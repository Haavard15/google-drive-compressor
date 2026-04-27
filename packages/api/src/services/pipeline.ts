import { existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import type { ChildProcess } from 'child_process';
import { and, asc, count, desc, eq, inArray, or } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { Action, File } from '../db/schema.js';
import { downloadFile, uploadFile, trashFile } from './drive.js';
import { config } from '../config.js';
import { JobCancelledError } from '../errors.js';
import {
  emitProgress,
  compressWithFFmpeg,
  getOutputFilename,
  compressionPresets,
  checkCanProcessFile,
  getAvailableDiskSpace,
  requiredTempSpace,
  ensureTempDir,
  setJobCancelHandler,
  clearJobCancelHandler,
  requestCancelProcessing,
} from './processor.js';
import { isQueueAutoAdvanceEnabled } from './queueSettings.js';
import { log } from '../logger.js';

export const PIPELINE_STATUSES = [
  'download_queued',
  'downloading',
  'ready_to_encode',
  'encoding',
  'ready_to_upload',
  'uploading',
] as const;

export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

const downloadAbortByAction = new Map<number, AbortController>();
const encodeAbortByAction = new Map<number, AbortController>();
const uploadAbortByAction = new Map<number, AbortController>();
const encodeFfmpegByAction = new Map<number, { probe?: ChildProcess; ffmpeg?: ChildProcess }>();

let downloadBusy = false;
let uploadBusy = false;
let kickScheduled = false;

function rewirePipelineCancel(actionId: number): void {
  setJobCancelHandler(actionId, () => {
    downloadAbortByAction.get(actionId)?.abort();
    encodeAbortByAction.get(actionId)?.abort();
    uploadAbortByAction.get(actionId)?.abort();
    const p = encodeFfmpegByAction.get(actionId);
    p?.probe?.kill('SIGTERM');
    p?.ffmpeg?.kill('SIGTERM');
  });
}

function compressInputPath(file: File): string {
  return join(ensureTempDir(), `input_${file.id}_${file.name}`);
}

function compressOutputPath(file: File): string {
  return join(ensureTempDir(), `compressed_${file.id}_${getOutputFilename(file.name)}`);
}

function downloadOnlyPath(actionId: number, file: File): string {
  return join(ensureTempDir(), `download_${actionId}_${file.name}`);
}

const DOWNLOAD_COMPLETE_RATIO = 0.98;
const MIN_ENCODED_OUTPUT_BYTES = 64 * 1024;

type PipelineStageName = 'download' | 'encode' | 'upload';

function parseActionMeta(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const o = JSON.parse(metadata) as unknown;
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Merge `pipelineStages` + optional resume log line into action metadata JSON. */
function mergeActionMeta(
  metadataJson: string | null,
  opts: {
    resumeMessage?: string;
    stage?: PipelineStageName;
    stageData?: Record<string, unknown>;
  },
): string {
  const meta = parseActionMeta(metadataJson);
  if (opts.resumeMessage) {
    const logArr = Array.isArray(meta.resumeLog)
      ? ([...(meta.resumeLog as unknown[])] as Record<string, unknown>[])
      : [];
    logArr.push({ at: new Date().toISOString(), message: opts.resumeMessage });
    if (logArr.length > 20) logArr.splice(0, logArr.length - 20);
    meta.resumeLog = logArr;
  }
  if (opts.stage && opts.stageData) {
    const stages = (meta.pipelineStages as Record<string, Record<string, unknown>>) || {};
    const prev = stages[opts.stage] || {};
    stages[opts.stage] = { ...prev, ...opts.stageData };
    meta.pipelineStages = stages;
  }
  return JSON.stringify(meta);
}

function isDownloadedFileComplete(localPath: string, expectedBytes: number | null | undefined): boolean {
  if (!existsSync(localPath)) return false;
  try {
    const sz = statSync(localPath).size;
    if (sz <= 0) return false;
    if (expectedBytes == null || expectedBytes <= 0) return sz > 4096;
    return sz >= Math.floor(expectedBytes * DOWNLOAD_COMPLETE_RATIO);
  } catch {
    return false;
  }
}

/** Heuristic: encoded file present and plausibly complete (not an empty/partial stub). */
function isEncodedOutputPresent(outputPath: string, sourceSize: number | null | undefined): boolean {
  if (!existsSync(outputPath)) return false;
  try {
    const sz = statSync(outputPath).size;
    if (sz < MIN_ENCODED_OUTPUT_BYTES) return false;
    if (sourceSize && sourceSize > 0) {
      if (sz > sourceSize * 1.5) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function pipelineReservedBytesEstimate(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({
      action: schema.actions,
      file: schema.files,
    })
    .from(schema.actions)
    .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
    .where(inArray(schema.actions.status, [...PIPELINE_STATUSES]));

  let sum = 0;
  for (const r of rows) {
    const sz = r.file?.size ?? 0;
    if (r.action.action === 'compress') {
      sum += requiredTempSpace(sz);
    } else if (r.action.action === 'download') {
      sum += Math.max(sz, 1024 * 1024);
    }
  }
  return sum;
}

const ACTIVE_QUEUE_STATUSES = [...PIPELINE_STATUSES, 'running'] as const;

/** True if any job is in the pipeline (for queue UI / settings). */
export async function hasPipelineActivity(): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(inArray(schema.actions.status, [...ACTIVE_QUEUE_STATUSES]))
    .limit(1);
  return !!row;
}

/**
 * Jobs waiting on disk (not yet encoding/uploading). Safe to cancel synchronously if still in this state.
 */
export async function tryCancelWaitingPipelineAction(actionId: number): Promise<boolean> {
  const db = getDb();
  const [claimed] = await db
    .update(schema.actions)
    .set({
      status: 'cancelled',
      progress: 0,
      error: null,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(schema.actions.id, actionId),
        or(eq(schema.actions.status, 'download_queued'), eq(schema.actions.status, 'ready_to_encode')),
      ),
    )
    .returning({ id: schema.actions.id, fileId: schema.actions.fileId });

  if (!claimed) {
    return false;
  }

  await cleanupTempArtifacts(actionId, claimed.fileId);
  clearJobCancelHandler(actionId);
  downloadAbortByAction.delete(actionId);
  encodeAbortByAction.delete(actionId);
  uploadAbortByAction.delete(actionId);
  encodeFfmpegByAction.delete(actionId);

  if (claimed.fileId) {
    await db.update(schema.files).set({ status: 'pending' }).where(eq(schema.files.id, claimed.fileId));
  }

  await emitProgress(actionId, 0, 'Cancelled', undefined, { phase: 'finalize' });
  kickPipeline();
  const { startNextPendingIfIdle } = await import('./actionQueue.js');
  await startNextPendingIfIdle();
  return true;
}

export async function promotePendingWhenDiskAllows(): Promise<void> {
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }
  const db = getDb();
  const free = await getAvailableDiskSpace();
  let reserved = await pipelineReservedBytesEstimate();

  const pendingRows = await db
    .select({
      action: schema.actions,
      file: schema.files,
    })
    .from(schema.actions)
    .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
    .where(
      and(
        eq(schema.actions.status, 'pending'),
        inArray(schema.actions.action, ['compress', 'download']),
      ),
    )
    .orderBy(desc(schema.actions.priority), asc(schema.actions.createdAt));

  for (const row of pendingRows) {
    const sz = row.file?.size ?? 0;
    const need =
      row.action.action === 'compress' ? requiredTempSpace(sz) : Math.max(sz, 1024 * 1024);
    if (reserved + need > free) {
      continue;
    }
    const el = await checkCanProcessFile(sz || 1024 * 1024);
    if (!el.ok) {
      continue;
    }
    const [upd] = await db
      .update(schema.actions)
      .set({
        status: 'download_queued',
        startedAt: new Date(),
        sizeBeforeBytes: row.file?.size ?? null,
        sizeAfterBytes: null,
      })
      .where(and(eq(schema.actions.id, row.action.id), eq(schema.actions.status, 'pending')))
      .returning({ id: schema.actions.id });
    if (upd) {
      reserved += need;
      rewirePipelineCancel(row.action.id);
    }
  }
}

export async function admitPipelinedAction(actionId: number): Promise<void> {
  const db = getDb();
  const [action] = await db.select().from(schema.actions).where(eq(schema.actions.id, actionId));
  if (!action) {
    throw new Error(`Action ${actionId} not found`);
  }
  if (action.status !== 'pending') {
    throw new Error(`Action is ${action.status}, not pending`);
  }
  if (action.action !== 'compress' && action.action !== 'download') {
    throw new Error('Not a pipelined action type');
  }
  if (!action.fileId) {
    throw new Error('No file ID');
  }

  const [file] = await db.select().from(schema.files).where(eq(schema.files.id, action.fileId));
  if (file?.size) {
    const eligibility = await checkCanProcessFile(file.size);
    if (!eligibility.ok) {
      throw new Error(eligibility.reason);
    }
  }

  await db
    .update(schema.actions)
    .set({
      status: 'download_queued',
      startedAt: new Date(),
      sizeBeforeBytes: file?.size ?? null,
      sizeAfterBytes: null,
    })
    .where(eq(schema.actions.id, actionId));

  rewirePipelineCancel(actionId);
  await promotePendingWhenDiskAllows();
  kickPipeline();
}

export function kickPipeline(): void {
  if (kickScheduled) return;
  kickScheduled = true;
  setImmediate(() => {
    kickScheduled = false;
    void runPipelineCycle();
  });
}

async function runPipelineCycle(): Promise<void> {
  await promotePendingWhenDiskAllows();
  void downloadWorkerTick();
  void encodeWorkerKick();
  void uploadWorkerTick();
}

async function failAction(
  actionId: number,
  fileId: string | null,
  error: unknown,
  opts?: { cancelled?: boolean; keepLocalCompressFiles?: boolean },
): Promise<void> {
  const db = getDb();
  await cleanupTempArtifacts(actionId, fileId, {
    keepCompressInputsOutputs: opts?.keepLocalCompressFiles === true,
  });
  clearJobCancelHandler(actionId);
  downloadAbortByAction.delete(actionId);
  encodeAbortByAction.delete(actionId);
  uploadAbortByAction.delete(actionId);
  encodeFfmpegByAction.delete(actionId);

  if (opts?.cancelled) {
    await db
      .update(schema.actions)
      .set({
        status: 'cancelled',
        progress: 0,
        error: null,
        completedAt: new Date(),
      })
      .where(eq(schema.actions.id, actionId));
    if (fileId) {
      await db.update(schema.files).set({ status: 'pending' }).where(eq(schema.files.id, fileId));
    }
    await emitProgress(actionId, 0, 'Cancelled', undefined, { phase: 'finalize' });
  } else {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    let metadataJson: string | undefined;
    if (opts?.keepLocalCompressFiles) {
      const [prev] = await db
        .select({ metadata: schema.actions.metadata })
        .from(schema.actions)
        .where(eq(schema.actions.id, actionId));
      metadataJson = mergeActionMeta(prev?.metadata ?? null, {
        resumeMessage:
          'Compress output (and source, if present) kept under temp dir after upload/Drive error — use Re-queue to retry without re-encoding.',
      });
    }
    await db
      .update(schema.actions)
      .set({
        status: 'failed',
        error: msg,
        completedAt: new Date(),
        ...(metadataJson ? { metadata: metadataJson } : {}),
      })
      .where(eq(schema.actions.id, actionId));
    if (fileId) {
      await db.update(schema.files).set({ status: 'pending' }).where(eq(schema.files.id, fileId));
    }
    await emitProgress(actionId, 0, `Failed: ${msg}`, undefined, { phase: 'finalize' });
  }
  kickPipeline();
  const { startNextPendingIfIdle } = await import('./actionQueue.js');
  await startNextPendingIfIdle();
}

async function cleanupTempArtifacts(
  actionId: number,
  fileId: string | null,
  opts?: { keepCompressInputsOutputs?: boolean },
): Promise<void> {
  if (!fileId) return;
  const db = getDb();
  const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId));
  if (!file) return;
  const paths =
    opts?.keepCompressInputsOutputs === true
      ? [downloadOnlyPath(actionId, file)]
      : [compressInputPath(file), compressOutputPath(file), downloadOnlyPath(actionId, file)];
  for (const p of paths) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

async function downloadWorkerTick(): Promise<void> {
  if (downloadBusy) return;
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }
  downloadBusy = true;
  try {
    const db = getDb();
    const [row] = await db
      .select({
        action: schema.actions,
        file: schema.files,
      })
      .from(schema.actions)
      .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
      .where(eq(schema.actions.status, 'download_queued'))
      .orderBy(desc(schema.actions.priority), asc(schema.actions.createdAt))
      .limit(1);

    if (!row?.action.fileId || !row.file) {
      return;
    }

    const id = row.action.id;
    const [claimed] = await db
      .update(schema.actions)
      .set({ status: 'downloading', progress: 0 })
      .where(and(eq(schema.actions.id, id), eq(schema.actions.status, 'download_queued')))
      .returning();

    if (!claimed) {
      return;
    }

    const ac = new AbortController();
    downloadAbortByAction.set(id, ac);
    rewirePipelineCancel(id);

    try {
      if (row.action.action === 'compress') {
        const inputPath = compressInputPath(row.file);
        const totalBytes = row.file.size ?? 0;

        if (isDownloadedFileComplete(inputPath, totalBytes)) {
          const outputPath = compressOutputPath(row.file);
          const outputReady = isEncodedOutputPresent(outputPath, totalBytes);
          let inputSz = 0;
          try {
            inputSz = statSync(inputPath).size;
          } catch {
            /* ignore */
          }
          const [mSkip] = await db
            .select({ metadata: schema.actions.metadata })
            .from(schema.actions)
            .where(eq(schema.actions.id, id));
          if (outputReady) {
            let outSz = 0;
            try {
              outSz = statSync(outputPath).size;
            } catch {
              /* ignore */
            }
            const ratio =
              totalBytes && totalBytes > 0
                ? (((totalBytes - outSz) / totalBytes) * 100).toFixed(1)
                : '?';
            await db
              .update(schema.actions)
              .set({
                status: 'ready_to_upload',
                progress: 75,
                metadata: mergeActionMeta(mSkip?.metadata ?? null, {
                  resumeMessage: `Skipped re-download/re-encode — compressed output already present (${outSz} B)`,
                  stage: 'encode',
                  stageData: {
                    completedAt: new Date().toISOString(),
                    skippedReencode: true,
                    outputBytes: outSz,
                    ratioPctApprox: ratio,
                  },
                }),
              })
              .where(eq(schema.actions.id, id));
            await emitProgress(
              id,
              75,
              `Resumed: encoded file on disk (~${ratio}% smaller vs source) · waiting for upload slot`,
              undefined,
              { phase: 'upload', bytesDone: 0, bytesTotal: outSz },
            );
          } else {
            await db
              .update(schema.actions)
              .set({
                status: 'ready_to_encode',
                progress: 30,
                metadata: mergeActionMeta(mSkip?.metadata ?? null, {
                  resumeMessage: `Skipped re-download — local input already present (${inputSz} B)`,
                  stage: 'download',
                  stageData: {
                    completedAt: new Date().toISOString(),
                    skippedRedownload: true,
                    bytes: inputSz,
                  },
                }),
              })
              .where(eq(schema.actions.id, id));
            await emitProgress(
              id,
              30,
              'Resumed: local file present · waiting for encoder',
              undefined,
              { phase: 'compress' },
            );
          }
        } else {
          if (existsSync(inputPath)) {
            try {
              unlinkSync(inputPath);
            } catch {
              /* ignore */
            }
          }
          let lastT = Date.now();
          let lastB = 0;
          await emitProgress(
            id,
            5,
            'Downloading…',
            undefined,
            { phase: 'download', bytesDone: 0, bytesTotal: totalBytes },
          );
          await downloadFile(
            row.action.fileId,
            inputPath,
            (pct, done) => {
              const now = Date.now();
              const dt = (now - lastT) / 1000;
              const db = done - lastB;
              const speed = dt > 0 ? db / dt : 0;
              if (dt >= 1) {
                void emitProgress(
                  id,
                  Math.min(25, Math.round(pct * 0.25)),
                  `Downloading… ${pct}%`,
                  speed,
                  {
                    phase: 'download',
                    bytesDone: done,
                    bytesTotal: totalBytes > 0 ? totalBytes : done,
                  },
                );
                lastT = now;
                lastB = done;
              }
            },
            { signal: ac.signal },
          );

          const [mDl] = await db
            .select({ metadata: schema.actions.metadata })
            .from(schema.actions)
            .where(eq(schema.actions.id, id));
          let inputSz = 0;
          try {
            inputSz = statSync(inputPath).size;
          } catch {
            /* ignore */
          }
          await db
            .update(schema.actions)
            .set({
              status: 'ready_to_encode',
              progress: 30,
              metadata: mergeActionMeta(mDl?.metadata ?? null, {
                stage: 'download',
                stageData: { completedAt: new Date().toISOString(), bytes: inputSz },
              }),
            })
            .where(eq(schema.actions.id, id));

          await emitProgress(
            id,
            30,
            'Downloaded · waiting for encoder',
            undefined,
            { phase: 'compress' },
          );
        }
      } else {
        const destPath = downloadOnlyPath(id, row.file);
        const totalBytes = row.file.size ?? 0;
        let lastDl = Date.now();
        let lastDlBytes = 0;
        await emitProgress(
          id,
          0,
          'Starting download…',
          undefined,
          { phase: 'download', bytesDone: 0, bytesTotal: totalBytes },
        );
        await downloadFile(
          row.action.fileId,
          destPath,
          (progress, downloadedBytes) => {
            const now = Date.now();
            const dt = (now - lastDl) / 1000;
            const db = downloadedBytes - lastDlBytes;
            const speed = dt > 0 ? db / dt : 0;
            if (dt < 1) return;
            lastDl = now;
            lastDlBytes = downloadedBytes;
            void emitProgress(
              id,
              progress,
              `Downloading… ${progress}%`,
              speed > 0 ? speed : undefined,
              {
                phase: 'download',
                bytesDone: downloadedBytes,
                bytesTotal: totalBytes > 0 ? totalBytes : downloadedBytes,
              },
            );
          },
          { signal: ac.signal },
        );

        const [metaRow] = await db
          .select({ metadata: schema.actions.metadata })
          .from(schema.actions)
          .where(eq(schema.actions.id, id));
        let localSize: number | null = null;
        try {
          localSize = statSync(destPath).size;
        } catch {
          /* ignore */
        }
        const merged = mergeActionMeta(metaRow?.metadata ?? null, {
          stage: 'download',
          stageData: {
            completedAt: new Date().toISOString(),
            bytes: localSize,
          },
        });
        const metaObj = parseActionMeta(merged);
        metaObj.downloadPath = destPath;

        await db
          .update(schema.actions)
          .set({
            status: 'completed',
            progress: 100,
            completedAt: new Date(),
            metadata: JSON.stringify(metaObj),
            sizeAfterBytes: localSize,
          })
          .where(eq(schema.actions.id, id));

        await emitProgress(id, 100, 'Completed', undefined, { phase: 'finalize' });
        clearJobCancelHandler(id);
        downloadAbortByAction.delete(id);

        const { applyPauseAfterCurrentOnJobComplete } = await import('./queueSettings.js');
        await applyPauseAfterCurrentOnJobComplete();
        const { startNextPendingIfIdle } = await import('./actionQueue.js');
        await startNextPendingIfIdle();
      }
    } catch (e) {
      if (e instanceof JobCancelledError || ac.signal.aborted) {
        await failAction(id, row.action.fileId, e, { cancelled: true });
      } else {
        await failAction(id, row.action.fileId, e);
      }
    } finally {
      downloadAbortByAction.delete(id);
      kickPipeline();
    }
  } finally {
    downloadBusy = false;
  }
}

async function encodeWorkerKick(): Promise<void> {
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }
  const db = getDb();
  const [{ n }] = await db
    .select({ n: count() })
    .from(schema.actions)
    .where(eq(schema.actions.status, 'encoding'));
  const encodingCount = Number(n);
  const slots = Math.max(0, config.MAX_PARALLEL_ENCODES - encodingCount);

  for (let i = 0; i < slots; i++) {
    const [row] = await db
      .select({
        action: schema.actions,
        file: schema.files,
      })
      .from(schema.actions)
      .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
      .where(eq(schema.actions.status, 'ready_to_encode'))
      .orderBy(desc(schema.actions.priority), asc(schema.actions.createdAt))
      .limit(1);

    if (!row?.action.fileId || !row.file) {
      break;
    }

    const id = row.action.id;
    const [claimed] = await db
      .update(schema.actions)
      .set({ status: 'encoding', progress: 35 })
      .where(and(eq(schema.actions.id, id), eq(schema.actions.status, 'ready_to_encode')))
      .returning();

    if (!claimed) {
      continue;
    }

    void runEncodeJob(row.action, row.file).catch((err) =>
      failAction(id, row.action.fileId, err),
    );
  }
}

async function runEncodeJob(action: Action, file: File): Promise<void> {
  const db = getDb();
  const id = action.id;
  const inputPath = compressInputPath(file);
  const outputPath = compressOutputPath(file);

  const [freshAction] = await db
    .select({ metadata: schema.actions.metadata })
    .from(schema.actions)
    .where(eq(schema.actions.id, id));

  let metadata: Record<string, unknown> = {};
  try {
    metadata = freshAction?.metadata ? JSON.parse(freshAction.metadata as string) : {};
  } catch {
    metadata = {};
  }

  const presetName = (metadata.preset as string) || 'archive';
  const preset = compressionPresets[presetName] || compressionPresets.archive;

  const jobFields: Record<string, unknown> = {};
  if (metadata.preset != null) jobFields.preset = metadata.preset;
  if (metadata.deleteOriginal != null) jobFields.deleteOriginal = metadata.deleteOriginal;

  const ac = new AbortController();
  encodeAbortByAction.set(id, ac);
  const ffmpegProcs: { probe?: ChildProcess; ffmpeg?: ChildProcess } = {};
  encodeFfmpegByAction.set(id, ffmpegProcs);
  rewirePipelineCancel(id);

  try {
    const encodeWallStart = Date.now();
    let lastCompressUpdate = Date.now();
    await compressWithFFmpeg(
      inputPath,
      outputPath,
      preset,
      (progress) => {
        const now = Date.now();
        if (now - lastCompressUpdate >= 2000) {
          const elapsedSec = (now - encodeWallStart) / 1000;
          let etaSeconds: number | undefined;
          if (progress >= 3 && progress < 99 && elapsedSec >= 2) {
            etaSeconds = ((100 - progress) / progress) * elapsedSec;
          }
          void emitProgress(
            id,
            35 + Math.round(progress * 0.35),
            `Compressing… ${progress}%`,
            undefined,
            {
              phase: 'compress',
              ...(etaSeconds != null && Number.isFinite(etaSeconds)
                ? { etaSeconds }
                : {}),
            },
            jobFields,
          );
          lastCompressUpdate = now;
        }
      },
      { signal: ac.signal, procs: ffmpegProcs },
    );

    const compressedSize = statSync(outputPath).size;
    const ratio =
      file.size && file.size > 0
        ? (((file.size - compressedSize) / file.size) * 100).toFixed(1)
        : '?';

    const [mEnc] = await db
      .select({ metadata: schema.actions.metadata })
      .from(schema.actions)
      .where(eq(schema.actions.id, id));
    await db
      .update(schema.actions)
      .set({
        status: 'ready_to_upload',
        progress: 75,
        metadata: mergeActionMeta(mEnc?.metadata ?? null, {
          stage: 'encode',
          stageData: {
            completedAt: new Date().toISOString(),
            outputBytes: compressedSize,
            ratioPctApprox: ratio,
          },
        }),
      })
      .where(eq(schema.actions.id, id));

    await emitProgress(
      id,
      75,
      `Encoded (~${ratio}% smaller vs source) · waiting for upload slot`,
      undefined,
      { phase: 'upload', bytesDone: 0, bytesTotal: compressedSize },
      jobFields,
    );
  } catch (e) {
    if (e instanceof JobCancelledError || ac.signal.aborted) {
      await failAction(id, action.fileId, e, { cancelled: true });
    } else {
      await failAction(id, action.fileId, e);
    }
    if (existsSync(inputPath)) {
      try {
        unlinkSync(inputPath);
      } catch {
        /* ignore */
      }
    }
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {
        /* ignore */
      }
    }
  } finally {
    encodeAbortByAction.delete(id);
    encodeFfmpegByAction.delete(id);
    kickPipeline();
  }
}

async function uploadWorkerTick(): Promise<void> {
  if (uploadBusy) return;
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }
  uploadBusy = true;
  try {
    const db = getDb();
    const [row] = await db
      .select({
        action: schema.actions,
        file: schema.files,
      })
      .from(schema.actions)
      .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
      .where(eq(schema.actions.status, 'ready_to_upload'))
      .orderBy(desc(schema.actions.priority), asc(schema.actions.createdAt))
      .limit(1);

    if (!row?.action.fileId || !row.file) {
      return;
    }

    const id = row.action.id;
    const [claimed] = await db
      .update(schema.actions)
      .set({ status: 'uploading', progress: 78 })
      .where(and(eq(schema.actions.id, id), eq(schema.actions.status, 'ready_to_upload')))
      .returning();

    if (!claimed) {
      return;
    }

    const outputPath = compressOutputPath(row.file);
    if (!existsSync(outputPath)) {
      await failAction(id, row.action.fileId, new Error('Compressed output missing'));
      return;
    }

    const [freshAction] = await db
      .select({ metadata: schema.actions.metadata })
      .from(schema.actions)
      .where(eq(schema.actions.id, id));
    let metadata: Record<string, unknown> = {};
    try {
      metadata = freshAction?.metadata ? JSON.parse(freshAction.metadata as string) : {};
    } catch {
      metadata = {};
    }

    const jobFields: Record<string, unknown> = {};
    if (metadata.preset != null) jobFields.preset = metadata.preset;
    if (metadata.deleteOriginal != null) jobFields.deleteOriginal = metadata.deleteOriginal;

    const ac = new AbortController();
    uploadAbortByAction.set(id, ac);
    rewirePipelineCancel(id);

    const compressedSize = statSync(outputPath).size;
    const parentId = row.file.parentId || 'root';
    let lastUploadUpdate = Date.now();
    let lastUploadBytes = 0;

    try {
      await emitProgress(
        id,
        78,
        'Starting upload…',
        undefined,
        { phase: 'upload', bytesDone: 0, bytesTotal: compressedSize },
        jobFields,
      );

      const newFileId = await uploadFile(
        outputPath,
        getOutputFilename(row.file.name),
        parentId,
        'video/mp4',
        (progress, uploadedBytes) => {
          const now = Date.now();
          const timeDiff = (now - lastUploadUpdate) / 1000;
          const bytesDiff = uploadedBytes - lastUploadBytes;
          const speed = timeDiff > 0 ? bytesDiff / timeDiff : 0;
          if (timeDiff >= 1) {
            void emitProgress(
              id,
              78 + Math.round(progress * 0.2),
              `Uploading… ${progress}%`,
              speed,
              { phase: 'upload', bytesDone: uploadedBytes, bytesTotal: compressedSize },
              jobFields,
            );
            lastUploadUpdate = now;
            lastUploadBytes = uploadedBytes;
          }
        },
        { signal: ac.signal },
      );

      await db
        .update(schema.files)
        .set({
          status: 'done',
          compressedSize,
          newFileId,
        })
        .where(eq(schema.files.id, row.file.id));

      const [mUp] = await db
        .select({ metadata: schema.actions.metadata })
        .from(schema.actions)
        .where(eq(schema.actions.id, id));
      await db
        .update(schema.actions)
        .set({
          status: 'completed',
          progress: 100,
          completedAt: new Date(),
          sizeAfterBytes: compressedSize,
          metadata: mergeActionMeta(mUp?.metadata ?? null, {
            stage: 'upload',
            stageData: {
              completedAt: new Date().toISOString(),
              newFileId,
              bytesUploaded: compressedSize,
            },
          }),
        })
        .where(eq(schema.actions.id, id));

      if (metadata.deleteOriginal !== false) {
        await emitProgress(id, 95, 'Moving original to trash…', undefined, { phase: 'trash' }, jobFields);
        await trashFile(row.action.fileId!);
        const replacementName = getOutputFilename(row.file.name);
        await db.insert(schema.sourceReplacementLog).values({
          actionId: id,
          sourceFileId: row.file.id,
          sourceFileName: row.file.name,
          newFileId,
          newFileName: replacementName,
          createdAt: new Date(),
        });
      }

      const inputPath = compressInputPath(row.file);
      if (existsSync(inputPath)) {
        try {
          unlinkSync(inputPath);
        } catch {
          /* ignore */
        }
      }
      if (existsSync(outputPath)) {
        try {
          unlinkSync(outputPath);
        } catch {
          /* ignore */
        }
      }

      await emitProgress(id, 100, 'Completed', undefined, { phase: 'finalize' });
      clearJobCancelHandler(id);
      uploadAbortByAction.delete(id);
      downloadAbortByAction.delete(id);
      encodeAbortByAction.delete(id);
      encodeFfmpegByAction.delete(id);

      const { applyPauseAfterCurrentOnJobComplete } = await import('./queueSettings.js');
      await applyPauseAfterCurrentOnJobComplete();
      const { startNextPendingIfIdle } = await import('./actionQueue.js');
      await startNextPendingIfIdle();
    } catch (e) {
      if (e instanceof JobCancelledError || ac.signal.aborted) {
        await failAction(id, row.action.fileId, e, {
          cancelled: true,
          keepLocalCompressFiles: true,
        });
      } else {
        await failAction(id, row.action.fileId, e, { keepLocalCompressFiles: true });
      }
    } finally {
      uploadAbortByAction.delete(id);
      kickPipeline();
    }
  } finally {
    uploadBusy = false;
  }
}

async function reconcileOneCompressAction(action: Action, file: File): Promise<boolean> {
  const db = getDb();
  const inputPath = compressInputPath(file);
  const outputPath = compressOutputPath(file);
  const expected = file.size ?? null;
  const inputOk = isDownloadedFileComplete(inputPath, expected);
  const outputOk = isEncodedOutputPresent(outputPath, expected);
  const st = action.status as string;

  let newStatus: string | null = null;
  let progress = action.progress ?? 0;
  let resumeMessage = '';

  if (st === 'download_queued' || st === 'downloading') {
    if (inputOk) {
      newStatus = 'ready_to_encode';
      progress = 30;
      resumeMessage = `Recovered: source file on disk (${statSync(inputPath).size} B) → ready_to_encode`;
    } else if (st === 'downloading') {
      if (existsSync(inputPath)) {
        try {
          const partial = statSync(inputPath).size;
          if (
            (expected && partial > 0 && partial < expected * DOWNLOAD_COMPLETE_RATIO) ||
            (!expected && partial > 0)
          ) {
            unlinkSync(inputPath);
            resumeMessage = `Recovered: removed partial download (${partial} B) → download_queued`;
          }
        } catch {
          /* ignore */
        }
      }
      newStatus = 'download_queued';
      progress = 0;
      if (!resumeMessage) resumeMessage = 'Recovered: download interrupted → download_queued';
    }
  } else if (st === 'ready_to_encode') {
    if (!inputOk) {
      newStatus = 'download_queued';
      progress = 0;
      resumeMessage = 'Recovered: expected input missing → download_queued';
    }
  } else if (st === 'encoding') {
    if (existsSync(outputPath)) {
      try {
        unlinkSync(outputPath);
      } catch {
        /* ignore */
      }
    }
    if (inputOk) {
      newStatus = 'ready_to_encode';
      progress = 30;
      resumeMessage = 'Recovered: encode interrupted (output discarded) → ready_to_encode';
    } else {
      newStatus = 'download_queued';
      progress = 0;
      resumeMessage = 'Recovered: encode interrupted, no valid input → download_queued';
    }
  } else if (st === 'ready_to_upload') {
    if (!outputOk) {
      if (inputOk) {
        newStatus = 'ready_to_encode';
        progress = 30;
        resumeMessage = 'Recovered: compressed output missing → ready_to_encode';
      } else {
        newStatus = 'download_queued';
        progress = 0;
        resumeMessage = 'Recovered: output and input missing → download_queued';
      }
    }
  } else if (st === 'uploading') {
    if (outputOk) {
      newStatus = 'ready_to_upload';
      progress = 75;
      resumeMessage = 'Recovered: upload interrupted, output on disk → ready_to_upload';
    } else if (inputOk) {
      newStatus = 'ready_to_encode';
      progress = 30;
      resumeMessage = 'Recovered: upload interrupted, output missing → ready_to_encode';
    } else {
      newStatus = 'download_queued';
      progress = 0;
      resumeMessage = 'Recovered: upload interrupted, no local artifacts → download_queued';
    }
  } else if (st === 'failed') {
    if (outputOk) {
      newStatus = 'ready_to_upload';
      progress = 75;
      resumeMessage =
        'Recovered: failed after encode or during upload — compressed file still on disk → ready_to_upload';
    } else if (inputOk) {
      newStatus = 'ready_to_encode';
      progress = 30;
      resumeMessage = 'Recovered: failed with source on disk, no output → ready_to_encode';
    }
  }

  if (!newStatus) return false;

  const annotateDownloadRecovered =
    (st === 'download_queued' || st === 'downloading') && inputOk && newStatus === 'ready_to_encode';
  const annotateEncodeRecovered =
    (st === 'uploading' || st === 'failed') && outputOk && newStatus === 'ready_to_upload';

  const metadata = mergeActionMeta(action.metadata, {
    resumeMessage,
    ...(annotateDownloadRecovered
      ? {
          stage: 'download' as const,
          stageData: { recoveredAt: new Date().toISOString(), fromServerRestart: true },
        }
      : annotateEncodeRecovered
        ? {
            stage: 'encode' as const,
            stageData: { recoveredAt: new Date().toISOString(), fromServerRestart: true },
          }
        : {}),
  });

  await db
    .update(schema.actions)
    .set({
      status: newStatus,
      progress,
      metadata,
      error: null,
      completedAt: null,
    })
    .where(eq(schema.actions.id, action.id));

  log.info(`[pipeline-resume] action #${action.id} (${st} → ${newStatus}): ${resumeMessage}`);
  return true;
}

async function reconcileOneDownloadOnlyAction(action: Action, file: File): Promise<boolean> {
  const db = getDb();
  if (action.status !== 'downloading') return false;
  const destPath = downloadOnlyPath(action.id, file);
  const expected = file.size ?? null;

  if (isDownloadedFileComplete(destPath, expected)) {
    let localSize: number | null = null;
    try {
      localSize = statSync(destPath).size;
    } catch {
      /* ignore */
    }
    const meta = mergeActionMeta(action.metadata, {
      resumeMessage: `Recovered: download-only file on disk (${localSize ?? '?'} B) → completed`,
      stage: 'download',
      stageData: {
        completedAt: new Date().toISOString(),
        recoveredAfterRestart: true,
        bytes: localSize,
      },
    });
    const o = parseActionMeta(meta);
    o.downloadPath = destPath;

    await db
      .update(schema.actions)
      .set({
        status: 'completed',
        progress: 100,
        completedAt: new Date(),
        metadata: JSON.stringify(o),
        sizeAfterBytes: localSize,
        error: null,
      })
      .where(eq(schema.actions.id, action.id));

    log.info(`[pipeline-resume] action #${action.id} (downloading → completed): download-only file present`);
    return true;
  }

  if (existsSync(destPath)) {
    try {
      unlinkSync(destPath);
    } catch {
      /* ignore */
    }
  }
  const metadata = mergeActionMeta(action.metadata, {
    resumeMessage: 'Recovered: partial download-only file removed → download_queued',
  });
  await db
    .update(schema.actions)
    .set({
      status: 'download_queued',
      progress: 0,
      metadata,
      error: null,
      completedAt: null,
    })
    .where(eq(schema.actions.id, action.id));

  log.info(`[pipeline-resume] action #${action.id} (downloading → download_queued): partial or missing file`);
  return true;
}

/**
 * After API restart: move compress/download pipeline rows to a consistent state using files under TEMP_DIR.
 * Does not cancel jobs; updates metadata (`pipelineStages`, `resumeLog`) for the UI / debugging.
 */
export async function recoverOrphanedPipelineJobs(): Promise<{ examined: number; resumed: number }> {
  const db = getDb();
  const pipelineRows = await db
    .select({
      action: schema.actions,
      file: schema.files,
    })
    .from(schema.actions)
    .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
    .where(
      and(
        inArray(schema.actions.status, [...PIPELINE_STATUSES]),
        inArray(schema.actions.action, ['compress', 'download']),
      ),
    );

  const failedCompressRows = await db
    .select({
      action: schema.actions,
      file: schema.files,
    })
    .from(schema.actions)
    .leftJoin(schema.files, eq(schema.actions.fileId, schema.files.id))
    .where(and(eq(schema.actions.status, 'failed'), eq(schema.actions.action, 'compress')));

  const rows = [...pipelineRows, ...failedCompressRows];

  let resumed = 0;
  for (const row of rows) {
    const { action, file } = row;
    if (action.action === 'compress') {
      if (!file) continue;
      if (await reconcileOneCompressAction(action, file)) resumed += 1;
    } else if (action.action === 'download') {
      if (!file) continue;
      if (await reconcileOneDownloadOnlyAction(action, file)) resumed += 1;
    }
  }

  return { examined: rows.length, resumed };
}

/** Abort in-flight I/O / ffmpeg for a pipeline job (same as Stop in UI). */
export function userAbortPipelineAction(actionId: number): boolean {
  return requestCancelProcessing(actionId);
}
