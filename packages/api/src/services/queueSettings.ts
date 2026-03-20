import { inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { log } from '../logger.js';

const KEY_AUTO = 'queue_auto_advance';
const KEY_PAUSE_AFTER = 'queue_pause_after_current';

export type QueueSettings = {
  autoAdvance: boolean;
  /** Deprecated: kept for API/tray compatibility; always cleared on save. */
  pauseAfterCurrent: boolean;
};

async function upsertSetting(key: string, value: string): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.appSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value },
    });
}

export async function getQueueSettings(): Promise<QueueSettings> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.appSettings)
    .where(inArray(schema.appSettings.key, [KEY_AUTO, KEY_PAUSE_AFTER]));

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    autoAdvance: map[KEY_AUTO] !== 'false',
    pauseAfterCurrent: map[KEY_PAUSE_AFTER] === 'true',
  };
}

export async function isQueueAutoAdvanceEnabled(): Promise<boolean> {
  const s = await getQueueSettings();
  return s.autoAdvance;
}

/**
 * Legacy: if `pause_after_current` was set before a job finished, turn auto-advance off once.
 */
export async function applyPauseAfterCurrentOnJobComplete(): Promise<void> {
  const s = await getQueueSettings();
  if (!s.pauseAfterCurrent) return;
  await upsertSetting(KEY_AUTO, 'false');
  await upsertSetting(KEY_PAUSE_AFTER, 'false');
  log.info('[queue] Pause-after-current applied: auto-advance off');
}

/**
 * Single user-facing control: `autoAdvance` (queue running vs paused).
 * `pauseAfterCurrent: true` is treated the same as `autoAdvance: false` (back-compat for old clients).
 */
export async function patchQueueSettings(
  patch: Partial<{ autoAdvance: boolean; pauseAfterCurrent: boolean }>,
  _opts?: { hasRunningJob: boolean },
): Promise<QueueSettings> {
  if (patch.autoAdvance === true) {
    await upsertSetting(KEY_AUTO, 'true');
    await upsertSetting(KEY_PAUSE_AFTER, 'false');
  } else if (patch.autoAdvance === false || patch.pauseAfterCurrent === true) {
    await upsertSetting(KEY_AUTO, 'false');
    await upsertSetting(KEY_PAUSE_AFTER, 'false');
  } else if (patch.pauseAfterCurrent === false) {
    await upsertSetting(KEY_PAUSE_AFTER, 'false');
  }

  return getQueueSettings();
}
