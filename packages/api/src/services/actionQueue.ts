import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { log } from '../logger.js';
import { isQueueAutoAdvanceEnabled } from './queueSettings.js';

export async function promoteAndKickPipeline(): Promise<void> {
  const { promotePendingWhenDiskAllows, kickPipeline } = await import('./pipeline.js');
  await promotePendingWhenDiskAllows();
  kickPipeline();
}

/** Start one pending delete if no legacy `running` delete is in progress. */
export async function tryStartOnePendingDelete(): Promise<void> {
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }

  const db = getDb();
  const [alreadyRunning] = await db
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(eq(schema.actions.status, 'running'))
    .limit(1);
  if (alreadyRunning) {
    return;
  }

  const [nextDelete] = await db
    .select({ id: schema.actions.id })
    .from(schema.actions)
    .where(and(eq(schema.actions.status, 'pending'), eq(schema.actions.action, 'delete')))
    .orderBy(desc(schema.actions.priority), asc(schema.actions.createdAt))
    .limit(1);

  if (!nextDelete) {
    return;
  }

  const { processAction } = await import('./processor.js');
  processAction(nextDelete.id).catch((err) => {
    log.error(`Action ${nextDelete.id} failed:`, err);
  });
}

/**
 * When auto-advance is on: promote compress/download into the download queue, tick workers,
 * and start a pending delete when the legacy single-flight slot is free.
 */
export async function startNextPendingIfIdle(): Promise<void> {
  if (!(await isQueueAutoAdvanceEnabled())) {
    return;
  }

  await promoteAndKickPipeline();
  await tryStartOnePendingDelete();
}
