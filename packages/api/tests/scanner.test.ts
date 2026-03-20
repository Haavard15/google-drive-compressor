import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const driveMock = vi.hoisted(() => ({
  listFiles: vi.fn(),
  getFile: vi.fn(),
  isAuthenticated: vi.fn(() => true),
  isSharedDrive: vi.fn(() => false),
}));

vi.mock('../src/services/drive.js', () => ({
  listFiles: driveMock.listFiles,
  getFile: driveMock.getFile,
  isAuthenticated: driveMock.isAuthenticated,
  isSharedDrive: driveMock.isSharedDrive,
}));

const envSnapshot = { ...process.env };

type ScannerModule = typeof import('../src/services/scanner.js');

async function waitForJobToFinish(scanner: ScannerModule, jobId: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await scanner.getScanStatus(jobId);
    if (job && job.status !== 'running') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for scan job ${jobId} to finish`);
}

async function createScannerContext(options?: { rootFolderId?: string }) {
  vi.resetModules();

  const dir = mkdtempSync(join(tmpdir(), 'gdc-scanner-test-'));
  process.env.DATABASE_URL = `file:${join(dir, 'scanner.db')}`;
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = options?.rootFolderId ?? 'root';
  process.env.LOG_LEVEL = 'silent';

  const dbModule = await import('../src/db/index.js');
  await dbModule.initDb();
  const scanner = await import('../src/services/scanner.js');

  return { dir, dbModule, scanner };
}

describe('scanner stale index handling', () => {
  beforeEach(() => {
    driveMock.listFiles.mockReset();
    driveMock.getFile.mockReset();
    driveMock.isAuthenticated.mockReturnValue(true);
    driveMock.isSharedDrive.mockResolvedValue(false);
  });

  afterEach(() => {
    process.env = { ...envSnapshot };
  });

  it('does not mark unrelated files missing after a partial scan', async () => {
    const { dir, dbModule, scanner } = await createScannerContext({ rootFolderId: 'root' });
    const db = dbModule.getDb();
    const { schema } = dbModule;

    try {
      await db.insert(schema.files).values({
        id: 'stale-file',
        name: 'stale.mov',
        mimeType: 'video/quicktime',
        size: 10,
        status: 'pending',
        isFolder: false,
        missingFromDrive: false,
        lastSeenScanJobId: 999,
      });

      driveMock.getFile.mockResolvedValue({
        id: 'client-folder',
        name: 'Client Folder',
        mimeType: 'application/vnd.google-apps.folder',
      });
      driveMock.listFiles.mockImplementation(async (folderId: string) => {
        if (folderId === 'client-folder') {
          return {
            files: [
              {
                id: 'seen-file',
                name: 'fresh.mp4',
                mimeType: 'video/mp4',
                size: '100',
              },
            ],
            nextPageToken: undefined,
          };
        }
        return { files: [], nextPageToken: undefined };
      });

      const job = await scanner.startScan('client-folder');
      await waitForJobToFinish(scanner, job.id);

      const files = await db.select().from(schema.files);
      const stale = files.find((file) => file.id === 'stale-file');
      const seen = files.find((file) => file.id === 'seen-file');

      expect(stale?.missingFromDrive).toBe(false);
      expect(seen?.missingFromDrive).toBe(false);
    } finally {
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks unseen files missing after a full-root scan', async () => {
    const { dir, dbModule, scanner } = await createScannerContext({ rootFolderId: 'root' });
    const db = dbModule.getDb();
    const { schema } = dbModule;

    try {
      await db.insert(schema.files).values({
        id: 'stale-file',
        name: 'stale.mov',
        mimeType: 'video/quicktime',
        size: 10,
        status: 'pending',
        isFolder: false,
        missingFromDrive: false,
        lastSeenScanJobId: 999,
      });

      driveMock.listFiles.mockImplementation(async (folderId: string) => {
        if (folderId === 'root') {
          return {
            files: [
              {
                id: 'seen-file',
                name: 'fresh.mp4',
                mimeType: 'video/mp4',
                size: '100',
              },
            ],
            nextPageToken: undefined,
          };
        }
        return { files: [], nextPageToken: undefined };
      });

      const job = await scanner.startScan('root');
      await waitForJobToFinish(scanner, job.id);

      const files = await db.select().from(schema.files);
      const stale = files.find((file) => file.id === 'stale-file');
      const seen = files.find((file) => file.id === 'seen-file');

      expect(stale?.missingFromDrive).toBe(true);
      expect(seen?.missingFromDrive).toBe(false);
    } finally {
      dbModule.closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
