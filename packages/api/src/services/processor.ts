import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { eq, inArray } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { trashFile } from './drive.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { Action, File } from '../db/schema.js';
import { JobCancelledError } from '../errors.js';

const activeJobCancellers = new Map<number, () => void>();

/** Set when recoverZombieRunningActions clears a ghost `running` row — same text unlocks Re-queue in UI */
export const ORPHANED_RUNNING_ERROR_MESSAGE =
  'Orphaned "running" state (server restarted or worker died).';

/** Stop download/upload (via AbortSignal) and send SIGTERM to ffprobe/ffmpeg if running. */
export function requestCancelProcessing(actionId: number): boolean {
  const run = activeJobCancellers.get(actionId);
  if (!run) return false;
  run();
  return true;
}

export function setJobCancelHandler(actionId: number, handler: () => void): void {
  activeJobCancellers.set(actionId, handler);
}

export function clearJobCancelHandler(actionId: number): void {
  activeJobCancellers.delete(actionId);
}

/** Action IDs with an in-memory worker (between "running" in DB and processAction finally). */
export function getActiveProcessingActionIds(): number[] {
  return Array.from(activeJobCancellers.keys());
}

/**
 * Clears actions stuck as `running` in SQLite when no worker exists (crash, kill -9, old bug).
 * Does not touch rows that match a live in-memory job.
 */
export async function recoverZombieRunningActions(): Promise<number> {
  const db = getDb();
  const active = new Set(getActiveProcessingActionIds());
  /** Pipeline stages are reconciled on startup by `recoverOrphanedPipelineJobs` (local files). */
  const zombieStatuses = ['running'] as const;
  const running = await db
    .select()
    .from(schema.actions)
    .where(inArray(schema.actions.status, [...zombieStatuses]));

  const zombies = running.filter((a) => a.id != null && !active.has(a.id));
  if (zombies.length === 0) return 0;

  const ids = zombies.map((z) => z.id);
  const fileIds = [...new Set(zombies.map((z) => z.fileId).filter(Boolean))] as string[];

  await db
    .update(schema.actions)
    .set({
      status: 'cancelled',
      progress: 0,
      error: ORPHANED_RUNNING_ERROR_MESSAGE,
      completedAt: new Date(),
    })
    .where(inArray(schema.actions.id, ids));

  if (fileIds.length > 0) {
    await db
      .update(schema.files)
      .set({ status: 'pending' })
      .where(inArray(schema.files.id, fileIds));
  }

  return zombies.length;
}

export type JobPhase = 'download' | 'compress' | 'upload' | 'trash' | 'delete' | 'finalize';

export type ProgressExtras = {
  phase?: JobPhase;
  bytesDone?: number;
  bytesTotal?: number;
  /** Wall-clock seconds remaining (e.g. compress extrapolation from FFmpeg %). */
  etaSeconds?: number;
};

type ProgressCallback = (
  actionId: number,
  progress: number,
  status: string,
  speed?: number,
  details?: ProgressExtras & { statusLine: string }
) => void;
let progressCallback: ProgressCallback | null = null;

export function onProcessProgress(callback: ProgressCallback) {
  progressCallback = callback;
}

function formatXferBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

const ETA_MAX_SEC = 48 * 3600;

function formatEtaRemaining(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm > 0 ? `${h}h ${mm}m` : `${h}h`;
}

function appendEtaSuffix(
  line: string,
  extras: ProgressExtras | undefined,
  speed?: number
): string {
  const phase = extras?.phase;
  const done = extras?.bytesDone ?? 0;
  const total = extras?.bytesTotal ?? 0;
  let etaSec: number | undefined;

  if (phase === 'download' || phase === 'upload') {
    if (total > 0 && done < total && speed != null && speed > 0) {
      etaSec = (total - done) / speed;
    }
  } else if (phase === 'compress' && extras?.etaSeconds != null) {
    etaSec = extras.etaSeconds;
  }

  if (
    etaSec == null ||
    !Number.isFinite(etaSec) ||
    etaSec < 1 ||
    etaSec > ETA_MAX_SEC
  ) {
    return line;
  }
  return `${line} · ~${formatEtaRemaining(etaSec)} left`;
}

function buildStatusLine(
  extras: ProgressExtras | undefined,
  status: string,
  speed?: number
): string {
  const sp =
    speed != null && speed > 0 ? ` · ${(speed / 1024 / 1024).toFixed(1)} MB/s` : '';
  const phase = extras?.phase;
  const done = extras?.bytesDone ?? 0;
  const total = extras?.bytesTotal ?? 0;

  let core: string;
  if ((phase === 'download' || phase === 'upload') && total > 0) {
    const pct = Math.min(100, Math.round((done / total) * 100));
    const label = phase === 'download' ? 'Downloading' : 'Uploading';
    core = `${label} ${formatXferBytes(done)} / ${formatXferBytes(total)} (${pct}%)${sp}`;
  } else if ((phase === 'download' || phase === 'upload') && total <= 0) {
    const label = phase === 'download' ? 'Downloading' : 'Uploading';
    core = `${label}… ${status.replace(/^.*\.\.\.\s*/, '')}${sp}`.trim();
  } else {
    core = `${status}${sp}`;
  }

  return appendEtaSuffix(core, extras, speed);
}

export async function emitProgress(
  actionId: number,
  progress: number,
  status: string,
  speed?: number,
  extras?: ProgressExtras,
  jobFields?: Record<string, unknown>
) {
  const db = getDb();
  const speedStr = speed ? ` (${(speed / 1024 / 1024).toFixed(1)} MB/s)` : '';
  const statusLine = buildStatusLine(extras, status, speed);

  let preserved: Record<string, unknown> = { ...(jobFields || {}) };
  if (!jobFields || Object.keys(jobFields).length === 0) {
    const [row] = await db
      .select({ metadata: schema.actions.metadata })
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    try {
      const prev = row?.metadata ? JSON.parse(row.metadata as string) : {};
      if (prev && typeof prev === 'object') {
        if (prev.preset != null) preserved.preset = prev.preset;
        if (prev.deleteOriginal != null) preserved.deleteOriginal = prev.deleteOriginal;
      }
    } catch {
      /* ignore */
    }
  }

  const meta = {
    ...preserved,
    lastStatus: status + speedStr,
    statusLine,
    lastUpdate: new Date().toISOString(),
    speed: speed || 0,
    phase: extras?.phase ?? null,
    bytesDone: extras?.bytesDone ?? null,
    bytesTotal: extras?.bytesTotal ?? null,
  };

  await db
    .update(schema.actions)
    .set({
      progress: Math.round(progress),
      metadata: JSON.stringify(meta),
    })
    .where(eq(schema.actions.id, actionId));

  const details: ProgressExtras & { statusLine: string } = {
    ...extras,
    statusLine,
  };
  if (progressCallback) {
    progressCallback(actionId, progress, statusLine, speed, details);
  }
}

export interface CompressionPreset {
  codec: string;
  /** libx264 / libx265: CRF + encoder preset */
  crf?: number;
  preset?: string;
  /** hevc_videotoolbox / h264_videotoolbox: FFmpeg -q:v (higher ≈ better quality, ~1–100) */
  vtQuality?: number;
  /** On non-macOS, VideoToolbox is unavailable — use these software encoders instead */
  fallbackSoftware?: { codec: string; crf: number; preset: string };
  audioCodec: string;
  audioBitrate: string;
}

export const compressionPresets: Record<string, CompressionPreset> = {
  archive: {
    codec: 'hevc_videotoolbox',
    vtQuality: 68,
    fallbackSoftware: { codec: 'libx265', crf: 23, preset: 'medium' },
    audioCodec: 'aac',
    audioBitrate: '192k',
  },
  balanced: {
    codec: 'hevc_videotoolbox',
    vtQuality: 62,
    fallbackSoftware: { codec: 'libx265', crf: 25, preset: 'medium' },
    audioCodec: 'aac',
    audioBitrate: '160k',
  },
  aggressive: {
    codec: 'hevc_videotoolbox',
    vtQuality: 52,
    fallbackSoftware: { codec: 'libx265', crf: 28, preset: 'slow' },
    audioCodec: 'aac',
    audioBitrate: '128k',
  },
  fast: {
    codec: 'h264_videotoolbox',
    vtQuality: 68,
    fallbackSoftware: { codec: 'libx264', crf: 23, preset: 'fast' },
    audioCodec: 'aac',
    audioBitrate: '192k',
  },
};

function resolvePresetForPlatform(preset: CompressionPreset): CompressionPreset {
  const isVt =
    preset.codec === 'hevc_videotoolbox' || preset.codec === 'h264_videotoolbox';
  if (!isVt || process.platform === 'darwin') {
    return preset;
  }
  const fb = preset.fallbackSoftware;
  if (!fb) {
    throw new Error(`Preset uses ${preset.codec} but no fallbackSoftware for non-macOS`);
  }
  log.debug(
    `[compress] VideoToolbox unavailable (${process.platform}); using ${fb.codec} CRF ${fb.crf} instead`,
  );
  return {
    ...preset,
    codec: fb.codec,
    crf: fb.crf,
    preset: fb.preset,
    vtQuality: undefined,
  };
}

export function ensureTempDir(): string {
  const tempDir = config.TEMP_DIR;
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  return tempDir;
}

export async function processAction(actionId: number): Promise<void> {
  const db = getDb();

  const [action] = await db
    .select()
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId));

  if (!action) {
    throw new Error(`Action ${actionId} not found`);
  }

  if (action.action === 'compress' || action.action === 'download') {
    const { admitPipelinedAction } = await import('./pipeline.js');
    await admitPipelinedAction(actionId);
    return;
  }

  if (!action.fileId) {
    throw new Error(`Action ${actionId} has no file ID`);
  }

  const [fileAtStart] = await db
    .select()
    .from(schema.files)
    .where(eq(schema.files.id, action.fileId));

  await db
    .update(schema.actions)
    .set({
      status: 'running',
      startedAt: new Date(),
      sizeBeforeBytes: fileAtStart?.size ?? null,
      sizeAfterBytes: null,
    })
    .where(eq(schema.actions.id, actionId));

  const ac = new AbortController();
  const ffmpegProcs: { probe?: ChildProcess; ffmpeg?: ChildProcess } = {};
  activeJobCancellers.set(actionId, () => {
    ac.abort();
    ffmpegProcs.probe?.kill('SIGTERM');
    ffmpegProcs.ffmpeg?.kill('SIGTERM');
  });

  try {
    await processDelete(action);

    await db
      .update(schema.actions)
      .set({
        status: 'completed',
        progress: 100,
        completedAt: new Date(),
      })
      .where(eq(schema.actions.id, actionId));

    await emitProgress(actionId, 100, 'Completed', undefined, { phase: 'finalize' });

    const { applyPauseAfterCurrentOnJobComplete } = await import('./queueSettings.js');
    await applyPauseAfterCurrentOnJobComplete();

    import('./actionQueue.js')
      .then(({ startNextPendingIfIdle }) => startNextPendingIfIdle())
      .catch((e) => log.error('[queue] Auto-start next failed:', e));
  } catch (error) {
    if (error instanceof JobCancelledError) {
      await db
        .update(schema.actions)
        .set({
          status: 'cancelled',
          progress: 0,
          error: null,
          completedAt: new Date(),
        })
        .where(eq(schema.actions.id, actionId));

      await db
        .update(schema.files)
        .set({ status: 'pending' })
        .where(eq(schema.files.id, action.fileId!));

      await emitProgress(actionId, 0, 'Cancelled', undefined, { phase: 'finalize' });
      return;
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await db
      .update(schema.actions)
      .set({
        status: 'failed',
        error: errorMessage,
        completedAt: new Date(),
      })
      .where(eq(schema.actions.id, actionId));

    await emitProgress(actionId, 0, `Failed: ${errorMessage}`, undefined, { phase: 'finalize' });
    throw error;
  } finally {
    activeJobCancellers.delete(actionId);
  }
}

async function processDelete(action: Action): Promise<void> {
  const db = getDb();

  await emitProgress(action.id, 50, 'Moving to trash…', undefined, { phase: 'delete' });

  await trashFile(action.fileId!);

  await db.update(schema.files)
    .set({ status: 'done' })
    .where(eq(schema.files.id, action.fileId!));
}

export function getOutputFilename(originalName: string): string {
  const ext = originalName.split('.').pop();
  const nameWithoutExt = originalName.replace(/\.[^/.]+$/, '');
  return `${nameWithoutExt}_compressed.mp4`;
}

export async function compressWithFFmpeg(
  inputPath: string,
  outputPath: string,
  preset: CompressionPreset,
  onProgress?: (progress: number) => void,
  opts?: { signal?: AbortSignal; procs?: { probe?: ChildProcess; ffmpeg?: ChildProcess } }
): Promise<void> {
  const signal = opts?.signal;
  const procs = opts?.procs;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new JobCancelledError());
      return;
    }

    const probe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      inputPath
    ]);
    if (procs) procs.probe = probe;

    let duration = 0;
    probe.stdout.on('data', (data) => {
      duration = parseFloat(data.toString().trim());
    });

    probe.on('error', (error) => {
      if (procs) procs.probe = undefined;
      reject(signal?.aborted ? new JobCancelledError() : new Error(`ffprobe failed to start: ${error.message}`));
    });

    probe.on('close', (code) => {
      if (procs) procs.probe = undefined;
      if (signal?.aborted) {
        reject(new JobCancelledError());
        return;
      }
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }

      const enc = resolvePresetForPlatform(preset);
      const args: string[] = ['-i', inputPath, '-c:v', enc.codec];

      // HEVC in MP4: default hev1 fails in QuickTime / iOS / many browsers; hvc1 is widely accepted
      if (enc.codec === 'libx265' || enc.codec === 'hevc_videotoolbox') {
        args.push('-tag:v', 'hvc1');
      } else if (enc.codec === 'libx264' || enc.codec === 'h264_videotoolbox') {
        args.push('-tag:v', 'avc1');
      }

      // 8-bit 4:2:0 — avoids 10-bit HEVC that common players reject
      args.push('-pix_fmt', 'yuv420p');

      const isVt =
        enc.codec === 'hevc_videotoolbox' || enc.codec === 'h264_videotoolbox';
      if (isVt) {
        const q = enc.vtQuality ?? 65;
        args.push('-q:v', String(q), '-b:v', '0');
      } else {
        if (enc.crf == null || enc.preset == null) {
          reject(new Error(`Software encoder ${enc.codec} requires crf and preset`));
          return;
        }
        args.push('-crf', String(enc.crf), '-preset', enc.preset);
      }

      args.push(
        '-c:a', enc.audioCodec,
        '-b:a', enc.audioBitrate,
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-y',
        outputPath
      );

      const ffmpeg = spawn('ffmpeg', args);
      if (procs) procs.ffmpeg = ffmpeg;

      ffmpeg.stdout.on('data', (data) => {
        const output = data.toString();
        const timeMatch = output.match(/out_time_ms=(\d+)/);
        if (timeMatch && duration > 0) {
          const currentTime = parseInt(timeMatch[1]) / 1000000;
          const progress = Math.min(99, Math.round((currentTime / duration) * 100));
          if (onProgress) onProgress(progress);
        }
      });

      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Error') || output.includes('Invalid')) {
          log.error('FFmpeg error:', output);
        }
      });

      ffmpeg.on('close', (code) => {
        if (procs) procs.ffmpeg = undefined;
        if (code === 0) {
          if (onProgress) onProgress(100);
          resolve();
        } else if (signal?.aborted) {
          reject(new JobCancelledError());
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (error) => {
        if (procs) procs.ffmpeg = undefined;
        reject(signal?.aborted ? new JobCancelledError() : new Error(`FFmpeg failed to start: ${error.message}`));
      });
    });
  });
}

export async function getAvailableDiskSpace(): Promise<number> {
  // Get available space in temp directory (in bytes)
  const { execSync } = await import('child_process');
  
  // Ensure temp directory exists first
  const tempDir = config.TEMP_DIR;
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  
  try {
    const result = execSync(`df -k "${tempDir}" | tail -1 | awk '{print $4}'`);
    const availableKB = parseInt(result.toString().trim());
    log.debug(`Disk space check: ${availableKB} KB available in ${tempDir}`);
    return availableKB * 1024;
  } catch (error) {
    log.error('Failed to check disk space:', error);
    // Fall back to checking /tmp if the specific directory fails
    try {
      const result = execSync(`df -k /tmp | tail -1 | awk '{print $4}'`);
      return parseInt(result.toString().trim()) * 1024;
    } catch {
      return 0;
    }
  }
}

/** Conservative estimate: original on disk + encoded output while both may exist. */
export function requiredTempSpace(fileSize: number): number {
  return fileSize * 2;
}

export type ProcessEligibility =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Compress/download needs free space under TEMP_DIR (~2× file size).
 * MAX_DISK_USAGE_GB is a per-job ceiling (raise it for large masters).
 */
export async function checkCanProcessFile(fileSize: number): Promise<ProcessEligibility> {
  const availableSpace = await getAvailableDiskSpace();
  const maxUsage = config.MAX_DISK_USAGE_GB * 1024 * 1024 * 1024;
  const requiredSpace = requiredTempSpace(fileSize);

  const gb = (n: number) => (n / 1024 / 1024 / 1024).toFixed(2);

  if (availableSpace < requiredSpace) {
    const reason = `Not enough free disk under TEMP_DIR (${config.TEMP_DIR}): need ~${gb(requiredSpace)} GiB for this file (${gb(fileSize)} GiB × 2), have ${gb(availableSpace)} GiB free.`;
    log.warn(`Can process file: blocked (disk)\n${reason}`);
    return { ok: false, reason };
  }

  if (requiredSpace > maxUsage) {
    const reason = `File exceeds MAX_DISK_USAGE_GB for one job: ~${gb(requiredSpace)} GiB working set vs limit ${gb(maxUsage)} GiB. Set MAX_DISK_USAGE_GB higher in .env (or pick a smaller file).`;
    log.warn(`Can process file: blocked (policy)\n${reason}`);
    return { ok: false, reason };
  }

  log.debug(`Can process file check:
    File size: ${gb(fileSize)} GiB
    Required space: ${gb(requiredSpace)} GiB
    Available space: ${gb(availableSpace)} GiB
    Max usage limit: ${gb(maxUsage)} GiB
    Can process: true`);

  return { ok: true };
}

export async function canProcessFile(fileSize: number): Promise<boolean> {
  const r = await checkCanProcessFile(fileSize);
  return r.ok;
}
