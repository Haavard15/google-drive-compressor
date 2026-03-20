import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { FastifyPluginAsync } from 'fastify';
import { eq, and, sql, desc, asc, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { config } from '../config.js';
import {
  processAction,
  onProcessProgress,
  checkCanProcessFile,
  requestCancelProcessing,
  recoverZombieRunningActions,
  ORPHANED_RUNNING_ERROR_MESSAGE,
} from '../services/processor.js';
import { log } from '../logger.js';
import { isQueueAutoAdvanceEnabled } from '../services/queueSettings.js';

function parseActionMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stripPrefetchFromMetadataJson(metadataJson: string | null): string {
  const meta = parseActionMeta(metadataJson);
  delete meta.prefetchedInputPath;
  return JSON.stringify(meta);
}

const ACTIVE_ACTION_STATUSES: string[] = [
  'pending',
  'download_queued',
  'running',
  'downloading',
  'ready_to_encode',
  'encoding',
  'ready_to_upload',
  'uploading',
];

const CLEARABLE_ACTION_STATUSES: string[] = ['completed', 'failed', 'cancelled'];
const QUEUEABLE_SUGGESTIONS: string[] = ['delete', 'compress'];

/** Legacy prefetch files from the old single-slot + prefetch path (safe no-op if unused). */
async function cleanupLegacyPrefetchArtifacts(actionId: number): Promise<void> {
  const partPath = join(config.TEMP_DIR, `.prefetch_${actionId}.part`);
  if (existsSync(partPath)) {
    try {
      unlinkSync(partPath);
    } catch {
      /* ignore */
    }
  }
  const db = getDb();
  const [row] = await db.select().from(schema.actions).where(eq(schema.actions.id, actionId));
  if (!row?.metadata) return;
  const meta = parseActionMeta(row.metadata);
  const p = meta.prefetchedInputPath;
  if (typeof p === 'string' && existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  delete meta.prefetchedInputPath;
  await db
    .update(schema.actions)
    .set({ metadata: JSON.stringify(meta) })
    .where(eq(schema.actions.id, actionId));
}

// Store connected WebSocket clients
const wsClients = new Set<WebSocket>();

export const actionsRoutes: FastifyPluginAsync = async (fastify) => {
  // Set up progress callback
  onProcessProgress((actionId, progress, status, speed, details) => {
    const message = JSON.stringify({
      type: 'action_progress',
      data: {
        actionId,
        progress,
        status,
        speed,
        phase: details?.phase,
        bytesDone: details?.bytesDone,
        bytesTotal: details?.bytesTotal,
        statusLine: details?.statusLine ?? status,
      },
    });
    wsClients.forEach(client => {
      if (client.readyState === 1) {
        client.send(message);
      }
    });
  });

  // WebSocket endpoint for action progress
  fastify.get('/ws', { websocket: true }, (socket) => {
    wsClients.add(socket as unknown as WebSocket);
    socket.on('close', () => {
      wsClients.delete(socket as unknown as WebSocket);
    });
  });

  // List actions with filtering
  fastify.get('/', async (request) => {
    const db = getDb();
    const { 
      status, 
      action,
      page = 1, 
      limit = 50 
    } = request.query as {
      status?: string;
      action?: string;
      page?: number;
      limit?: number;
    };

    const conditions = [];
    if (status) conditions.push(eq(schema.actions.status, status));
    if (action) conditions.push(eq(schema.actions.action, action));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const offset = (Number(page) - 1) * Number(limit);

    const [actions, countResult] = await Promise.all([
      db
        .select({
          action: schema.actions,
          file: schema.files,
          replacementLog: schema.sourceReplacementLog,
        })
        .from(schema.actions)
        .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
        .leftJoin(
          schema.sourceReplacementLog,
          eq(schema.actions.id, schema.sourceReplacementLog.actionId),
        )
        .where(whereClause)
        .orderBy(desc(schema.actions.createdAt))
        .limit(Number(limit))
        .offset(offset),
      
      db.select({ count: sql<number>`count(*)` })
        .from(schema.actions)
        .where(whereClause),
    ]);

    return {
      actions: actions.map(a => {
        // Parse metadata to extract progress details
        let parsedMetadata: {
          lastStatus?: string;
          statusLine?: string;
          lastUpdate?: string;
          speed?: number;
          phase?: string | null;
          bytesDone?: number | null;
          bytesTotal?: number | null;
        } = {};
        try {
          parsedMetadata = a.action.metadata ? JSON.parse(a.action.metadata) : {};
        } catch {
          parsedMetadata = {};
        }

        const speedVal = parsedMetadata.speed || 0;
        const log = a.replacementLog;
        const replacementLog =
          log?.id != null && log.newFileId
            ? {
                sourceFileId: log.sourceFileId,
                sourceFileName: log.sourceFileName,
                newFileId: log.newFileId,
                newFileName: log.newFileName,
                newFileDriveUrl: `https://drive.google.com/file/d/${encodeURIComponent(log.newFileId)}/view`,
                loggedAt:
                  log.createdAt instanceof Date
                    ? log.createdAt.toISOString()
                    : log.createdAt
                      ? new Date(log.createdAt as unknown as number).toISOString()
                      : null,
              }
            : null;

        return {
          ...a.action,
          file: a.file,
          replacementLog,
          progressDetails: {
            lastStatus: parsedMetadata.lastStatus || null,
            statusLine: parsedMetadata.statusLine || parsedMetadata.lastStatus || null,
            lastUpdate: parsedMetadata.lastUpdate || null,
            phase: parsedMetadata.phase ?? null,
            bytesDone: parsedMetadata.bytesDone ?? null,
            bytesTotal: parsedMetadata.bytesTotal ?? null,
            speed: speedVal,
            speedFormatted:
              speedVal > 0 ? `${(speedVal / 1024 / 1024).toFixed(1)} MB/s` : null,
          },
        };
      }),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: countResult[0]?.count || 0,
      },
    };
  });

  /** Fix DB rows stuck in "running" after a crash (no matching in-memory worker). Safe while a real job runs. */
  fastify.post('/recover-stuck', async () => {
    const recovered = await recoverZombieRunningActions();
    return { success: true, recovered };
  });

  // Queue new actions
  fastify.post('/', async (request) => {
    const db = getDb();
    const { 
      fileIds, 
      action, 
      priority = 0,
      metadata = {},
    } = request.body as {
      fileIds: string[];
      action: 'delete' | 'compress' | 'download';
      priority?: number;
      metadata?: Record<string, any>;
    };

    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      throw { statusCode: 400, message: 'fileIds array required' };
    }

    if (!['delete', 'compress', 'download'].includes(action)) {
      throw { statusCode: 400, message: 'Invalid action type' };
    }

    const created = [];
    for (const fileId of fileIds) {
      // Check if action already exists for this file
      const [existing] = await db.select()
        .from(schema.actions)
        .where(and(
          eq(schema.actions.fileId, fileId),
          eq(schema.actions.action, action),
          inArray(schema.actions.status, ACTIVE_ACTION_STATUSES)
        ));

      if (existing) {
        continue; // Skip duplicate
      }

      const [newAction] = await db.insert(schema.actions)
        .values({
          fileId,
          action,
          priority,
          metadata: JSON.stringify(metadata),
          createdAt: new Date(),
        })
        .returning();

      // Update file status
      await db.update(schema.files)
        .set({ status: 'queued' })
        .where(eq(schema.files.id, fileId));

      created.push(newAction);
    }

    return { 
      success: true, 
      created: created.length,
      actions: created,
    };
  });

  // Queue actions based on AI suggestions
  fastify.post('/queue-suggestions', async (request) => {
    const db = getDb();
    const {
      suggestions = ['delete', 'compress'],
      minConfidence = 0.6,
      compressMetadata,
    } = request.body as {
      suggestions?: string[];
      minConfidence?: number;
      compressMetadata?: { preset?: string; deleteOriginal?: boolean };
    };

    const normalizedSuggestions = [...new Set(suggestions)].filter(
      (suggestion): suggestion is string => QUEUEABLE_SUGGESTIONS.includes(suggestion),
    );
    if (normalizedSuggestions.length === 0) {
      throw { statusCode: 400, message: 'At least one valid suggestion is required' };
    }
    if (!Number.isFinite(minConfidence)) {
      throw { statusCode: 400, message: 'minConfidence must be a number' };
    }

    // Get files matching suggestions
    const files = await db.select()
      .from(schema.files)
      .where(and(
        inArray(schema.files.suggestion, normalizedSuggestions),
        sql`${schema.files.confidence} >= ${minConfidence}`,
        eq(schema.files.status, 'pending')
      ));

    const existingActions = files.length === 0
      ? []
      : await db
          .select({
            fileId: schema.actions.fileId,
            action: schema.actions.action,
          })
          .from(schema.actions)
          .where(and(
            inArray(schema.actions.fileId, files.map((file) => file.id)),
            inArray(schema.actions.status, ACTIVE_ACTION_STATUSES),
          ));
    const existingActionKeys = new Set(
      existingActions
        .filter((row): row is { fileId: string; action: string } => !!row.fileId)
        .map((row) => `${row.fileId}:${row.action}`),
    );

    const created = [];
    for (const file of files) {
      const action = file.suggestion === 'delete' ? 'delete' : 'compress';
      if (existingActionKeys.has(`${file.id}:${action}`)) {
        continue;
      }
      const metaPayload: Record<string, unknown> =
        action === 'compress'
          ? {
              ...(compressMetadata?.preset != null ? { preset: compressMetadata.preset } : {}),
              ...(compressMetadata?.deleteOriginal !== undefined
                ? { deleteOriginal: compressMetadata.deleteOriginal }
                : {}),
            }
          : {};

      const [newAction] = await db.insert(schema.actions)
        .values({
          fileId: file.id,
          action,
          priority: Math.round((file.confidence || 0) * 10),
          ...(action === 'compress' ? { metadata: JSON.stringify(metaPayload) } : {}),
          createdAt: new Date(),
        })
        .returning();

      await db.update(schema.files)
        .set({ status: 'queued' })
        .where(eq(schema.files.id, file.id));

      existingActionKeys.add(`${file.id}:${action}`);
      created.push(newAction);
    }

    return {
      success: true,
      queued: created.length,
    };
  });

  // Execute a specific action
  fastify.post<{ Params: { id: string } }>('/:id/execute', async (request) => {
    const actionId = parseInt(request.params.id);
    
    if (isNaN(actionId)) {
      throw { statusCode: 400, message: 'Invalid action ID' };
    }

    const db = getDb();
    const [action] = await db.select({
      action: schema.actions,
      file: schema.files,
    })
    .from(schema.actions)
    .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
    .where(eq(schema.actions.id, actionId));

    if (!action) {
      throw { statusCode: 404, message: 'Action not found' };
    }

    if (action.action.status !== 'pending') {
      throw { statusCode: 400, message: `Action is ${action.action.status}, not pending` };
    }

    // Check disk space / policy for compress/download actions
    if (action.action.action !== 'delete' && action.file?.size) {
      const eligibility = await checkCanProcessFile(action.file.size);
      if (!eligibility.ok) {
        throw { statusCode: 400, message: eligibility.reason };
      }
    }

    // Process in background
    processAction(actionId).catch(err => {
      log.error(`Action ${actionId} failed:`, err);
    });

    return { 
      success: true, 
      message: 'Action execution started',
      actionId,
    };
  });

  /** Re-queue failed jobs, or `cancelled` rows from recover-stuck (orphaned running state) */
  fastify.post<{ Params: { id: string } }>('/:id/retry', async (request) => {
    const actionId = parseInt(request.params.id, 10);
    if (isNaN(actionId)) {
      throw { statusCode: 400, message: 'Invalid action ID' };
    }

    const db = getDb();
    const [row] = await db.select().from(schema.actions).where(eq(schema.actions.id, actionId));

    if (!row) {
      throw { statusCode: 404, message: 'Action not found' };
    }
    const isOrphanedCancelled =
      row.status === 'cancelled' && row.error === ORPHANED_RUNNING_ERROR_MESSAGE;
    if (row.status !== 'failed' && !isOrphanedCancelled) {
      throw {
        statusCode: 400,
        message: `Only failed or orphaned (recover-stuck) actions can be re-queued (current status: ${row.status})`,
      };
    }

    await cleanupLegacyPrefetchArtifacts(actionId);

    await db
      .update(schema.actions)
      .set({
        status: 'pending',
        progress: 0,
        error: null,
        completedAt: null,
        startedAt: null,
        sizeBeforeBytes: null,
        sizeAfterBytes: null,
        metadata: stripPrefetchFromMetadataJson(row.metadata),
      })
      .where(eq(schema.actions.id, actionId));

    if (row.fileId) {
      await db
        .update(schema.files)
        .set({ status: 'queued' })
        .where(eq(schema.files.id, row.fileId));
    }

    return { success: true, actionId };
  });

  // Promote pending → download queue (disk permitting) and tick pipeline workers
  fastify.post('/execute-next', async () => {
    if (!(await isQueueAutoAdvanceEnabled())) {
      const { kickPipeline } = await import('../services/pipeline.js');
      kickPipeline();
      throw {
        statusCode: 409,
        message:
          'Queue is paused. Turn on Resume queue first, then use Start queue if you still need a manual tick.',
      };
    }

    const db = getDb();
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(schema.actions)
      .where(eq(schema.actions.status, 'pending'));
    const hadPending = Number(n) > 0;

    const { promoteAndKickPipeline, tryStartOnePendingDelete } = await import(
      '../services/actionQueue.js'
    );
    await promoteAndKickPipeline();
    await tryStartOnePendingDelete();

    return {
      success: true,
      message: hadPending
        ? 'Promoted jobs to the download queue'
        : 'Pipeline ticked (no pending compress/download)',
      hadPending,
    };
  });

  // Clear completed/failed actions (register before /:id so "clear" is not parsed as an id)
  fastify.delete('/clear', async (request) => {
    const { status } = request.query as { status?: string };
    const db = getDb();

    const statuses = status ? [status] : [...CLEARABLE_ACTION_STATUSES];
    const invalidStatus = statuses.find(
      (value) => !CLEARABLE_ACTION_STATUSES.includes(value),
    );
    if (invalidStatus) {
      throw { statusCode: 400, message: `Invalid status "${invalidStatus}"` };
    }

    await db.delete(schema.actions)
      .where(inArray(schema.actions.status, statuses));

    return { success: true, message: 'Cleared actions' };
  });

  // Cancel a pending action, or stop a running one (graceful: abort I/O + SIGTERM ffmpeg)
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const actionId = parseInt(request.params.id, 10);
    const db = getDb();

    if (isNaN(actionId)) {
      throw { statusCode: 400, message: 'Invalid action ID' };
    }

    const [action] = await db.select()
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));

    if (!action) {
      throw { statusCode: 404, message: 'Action not found' };
    }

    if (action.status === 'pending') {
      await cleanupLegacyPrefetchArtifacts(actionId);
      await db
        .update(schema.actions)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(schema.actions.id, actionId));
      if (action.fileId) {
        await db
          .update(schema.files)
          .set({ status: 'pending' })
          .where(eq(schema.files.id, action.fileId));
      }
      return { success: true, message: 'Cancelled' };
    }

    const { tryCancelWaitingPipelineAction } = await import('../services/pipeline.js');
    if (await tryCancelWaitingPipelineAction(actionId)) {
      return { success: true, message: 'Cancelled' };
    }

    const stoppable =
      action.status === 'running' ||
      action.status === 'downloading' ||
      action.status === 'encoding' ||
      action.status === 'ready_to_upload' ||
      action.status === 'uploading';

    if (stoppable) {
      const signalled = requestCancelProcessing(actionId);
      return {
        success: true,
        message: signalled
          ? 'Stopping job…'
          : 'Stop requested (job may already be finishing)',
      };
    }

    throw {
      statusCode: 400,
      message: `Cannot cancel action in state ${action.status}`,
    };
  });
};
