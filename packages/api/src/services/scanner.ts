import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { listFiles, getFile, isAuthenticated, isSharedDrive } from './drive.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { NewFile, ScanJob } from '../db/schema.js';

/** Jobs left `running` after API restart or crash have no worker — mark failed so UI can start a new scan. */
const STALLED_SCAN_ERROR =
  'Scan interrupted (server restarted or process exited). Start a new scan.';

// Event emitter for scan progress
type ScanProgressCallback = (progress: ScanProgress) => void;
let progressCallback: ScanProgressCallback | null = null;

/** Set while the root `scanFolder` for this job is in flight (this process). */
let inProcessScanJobId: number | null = null;

export interface ScanProgress {
  jobId: number;
  status: 'running' | 'completed' | 'failed';
  scannedFiles: number;
  totalFiles: number;
  totalSize: number;
  currentFolder?: string;
  error?: string;
}

export function onScanProgress(callback: ScanProgressCallback) {
  progressCallback = callback;
}

function emitProgress(progress: ScanProgress) {
  if (progressCallback) {
    progressCallback(progress);
  }
}

export type RecoverStalledScanOptions = {
  /** If true, skip the job currently being scanned in this process (manual recover while API stays up). */
  excludeActiveScanner?: boolean;
};

/**
 * Mark `running` scan jobs as failed when they have no worker (startup), or clear older zombies while a real scan runs.
 */
export async function recoverStalledScanJobs(
  options?: RecoverStalledScanOptions,
): Promise<number> {
  const db = getDb();
  const excludeId =
    options?.excludeActiveScanner && inProcessScanJobId != null
      ? inProcessScanJobId
      : null;

  const stuck = await db
    .select()
    .from(schema.scanJobs)
    .where(
      excludeId != null
        ? and(eq(schema.scanJobs.status, 'running'), ne(schema.scanJobs.id, excludeId))
        : eq(schema.scanJobs.status, 'running'),
    );

  if (stuck.length === 0) return 0;

  for (const job of stuck) {
    await db
      .update(schema.scanJobs)
      .set({
        status: 'failed',
        error: STALLED_SCAN_ERROR,
        completedAt: new Date(),
      })
      .where(eq(schema.scanJobs.id, job.id));

    emitProgress({
      jobId: job.id,
      status: 'failed',
      scannedFiles: job.scannedFiles ?? 0,
      totalFiles: job.totalFiles ?? job.scannedFiles ?? 0,
      totalSize: job.totalSize ?? 0,
      error: STALLED_SCAN_ERROR,
    });
  }

  return stuck.length;
}

/**
 * After a successful full-root scan, rows the crawler never touched are treated as gone from Drive.
 * Two-step update: flag everything, then clear for rows tagged with this job id during the crawl.
 */
async function markMissingAfterScan(jobId: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.files)
    .set({ missingFromDrive: true })
    .where(sql`1 = 1`);
  await db
    .update(schema.files)
    .set({ missingFromDrive: false })
    .where(eq(schema.files.lastSeenScanJobId, jobId));
}

function shouldMarkMissingForRoot(folderId: string): boolean {
  const fullScanRoot = config.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'root';
  return folderId === fullScanRoot;
}

export async function startScan(rootFolderId?: string): Promise<ScanJob> {
  if (!isAuthenticated()) {
    throw new Error('Not authenticated with Google Drive');
  }

  const db = getDb();
  const folderId = rootFolderId || config.GOOGLE_DRIVE_ROOT_FOLDER_ID || 'root';

  // Check if this is a Shared Drive root
  const isSharedDriveRoot = await isSharedDrive(folderId);
  log.info(`Starting scan of ${folderId} (Shared Drive: ${isSharedDriveRoot})`);

  // Create scan job
  const [job] = await db.insert(schema.scanJobs).values({
    rootFolderId: folderId,
    status: 'running',
    createdAt: new Date(),
  }).returning();

  inProcessScanJobId = job.id;

  // Start scanning in background
  scanFolder(
    job.id,
    folderId,
    '',
    { scannedFiles: 0, totalSize: 0 },
    isSharedDriveRoot,
    shouldMarkMissingForRoot(folderId),
  ).catch(async (error) => {
    log.error('Scan failed:', error);
    await db.update(schema.scanJobs)
      .set({ status: 'failed', error: error.message })
      .where(eq(schema.scanJobs.id, job.id));

    emitProgress({
      jobId: job.id,
      status: 'failed',
      scannedFiles: 0,
      totalFiles: 0,
      totalSize: 0,
      error: error.message,
    });
    if (inProcessScanJobId === job.id) inProcessScanJobId = null;
  });

  return job;
}

async function scanFolder(
  jobId: number,
  folderId: string,
  parentPath: string,
  stats: { scannedFiles: number; totalSize: number } = { scannedFiles: 0, totalSize: 0 },
  isSharedDriveRoot: boolean = false,
  shouldMarkMissing: boolean = false,
): Promise<void> {
  const db = getDb();
  let pageToken: string | undefined;

  // Get folder info for path building
  let folderName = '';
  if (folderId !== 'root' && !isSharedDriveRoot) {
    const folderInfo = await getFile(folderId);
    folderName = folderInfo?.name || folderId;
  } else if (isSharedDriveRoot) {
    folderName = 'Shared Drive';
  }
  const currentPath = parentPath ? `${parentPath}/${folderName}` : folderName;

  emitProgress({
    jobId,
    status: 'running',
    scannedFiles: stats.scannedFiles,
    totalFiles: stats.scannedFiles,
    totalSize: stats.totalSize,
    currentFolder: currentPath || 'Root',
  });

  do {
    const { files, nextPageToken } = await listFiles(folderId, pageToken, isSharedDriveRoot);
    pageToken = nextPageToken;

    const filesToInsert: NewFile[] = [];
    const foldersToScan: { id: string; path: string }[] = [];

    for (const file of files) {
      const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
      const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;
      const fileSize = file.size ? parseInt(file.size) : 0;

      filesToInsert.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        size: fileSize,
        parentId: folderId === 'root' ? null : folderId,
        path: filePath,
        isFolder,
        duration: file.videoMediaMetadata?.durationMillis 
          ? parseInt(file.videoMediaMetadata.durationMillis) 
          : null,
        width: file.videoMediaMetadata?.width || null,
        height: file.videoMediaMetadata?.height || null,
        createdAt: file.createdTime ? new Date(file.createdTime) : null,
        modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
        scannedAt: new Date(),
        status: 'pending',
        lastSeenScanJobId: jobId,
        missingFromDrive: false,
      });

      if (!isFolder) {
        stats.totalSize += fileSize;
      }
      stats.scannedFiles++;

      if (isFolder) {
        foldersToScan.push({ id: file.id, path: filePath });
      }
    }

    // Batch insert files
    if (filesToInsert.length > 0) {
      // Use upsert to handle rescans
      for (const file of filesToInsert) {
        await db.insert(schema.files)
          .values(file)
          .onConflictDoUpdate({
            target: schema.files.id,
            set: {
              name: file.name,
              mimeType: file.mimeType,
              size: file.size,
              parentId: file.parentId,
              path: file.path,
              duration: file.duration,
              width: file.width,
              height: file.height,
              modifiedAt: file.modifiedAt,
              scannedAt: file.scannedAt,
              lastSeenScanJobId: jobId,
              missingFromDrive: false,
            },
          });
      }
    }

    // Update job progress
    await db.update(schema.scanJobs)
      .set({
        scannedFiles: stats.scannedFiles,
        totalSize: stats.totalSize,
      })
      .where(eq(schema.scanJobs.id, jobId));

    emitProgress({
      jobId,
      status: 'running',
      scannedFiles: stats.scannedFiles,
      totalFiles: stats.scannedFiles,
      totalSize: stats.totalSize,
      currentFolder: currentPath || 'Root',
    });

    // Recursively scan subfolders (no longer at shared drive root level)
    for (const folder of foldersToScan) {
      await scanFolder(jobId, folder.id, currentPath, stats, false, shouldMarkMissing);
    }

  } while (pageToken);

  // If this is the root call, mark job as completed
  if (!parentPath) {
    if (shouldMarkMissing) {
      try {
        await markMissingAfterScan(jobId);
      } catch (err) {
        log.error('markMissingAfterScan failed:', err);
      }
    } else {
      log.info(
        `Skipping missing-from-drive refresh for partial scan root ${folderId}; only full-root scans update stale-index flags.`,
      );
    }

    await db.update(schema.scanJobs)
      .set({
        status: 'completed',
        totalFiles: stats.scannedFiles,
        totalSize: stats.totalSize,
        completedAt: new Date(),
      })
      .where(eq(schema.scanJobs.id, jobId));

    emitProgress({
      jobId,
      status: 'completed',
      scannedFiles: stats.scannedFiles,
      totalFiles: stats.scannedFiles,
      totalSize: stats.totalSize,
    });

    if (inProcessScanJobId === jobId) inProcessScanJobId = null;
  }
}

export async function getScanStatus(jobId: number): Promise<ScanJob | null> {
  const db = getDb();
  const [job] = await db.select()
    .from(schema.scanJobs)
    .where(eq(schema.scanJobs.id, jobId));
  return job || null;
}

export async function getLatestScan(): Promise<ScanJob | null> {
  const db = getDb();
  const [job] = await db
    .select()
    .from(schema.scanJobs)
    .orderBy(desc(schema.scanJobs.id))
    .limit(1);
  return job || null;
}
