import { google, drive_v3, Auth } from 'googleapis';
import { config } from '../config.js';
import { log } from '../logger.js';
import { JobCancelledError } from '../errors.js';
import { withDownloadSlot } from './downloadGate.js';
import { withUploadSlot } from './uploadGate.js';

let driveClient: drive_v3.Drive | null = null;
let authType: 'service_account' | 'oauth' | null = null;

// OAuth tokens storage (in-memory for now, should be persisted)
let oauthTokens: {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
} | null = null;

export function resetDriveAuthState(): void {
  driveClient = null;
  authType = null;
  oauthTokens = null;
}

export function getOAuth2Client(): Auth.OAuth2Client {
  return new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(): string {
  const oauth2Client = getOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    prompt: 'consent',
  });
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const oauth2Client = getOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('Google OAuth did not return an access token');
  }

  const refreshToken = tokens.refresh_token ?? oauthTokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(
      'Google OAuth did not return a refresh token. Re-authorize with consent to allow reconnecting later.',
    );
  }

  oauthTokens = {
    access_token: tokens.access_token,
    refresh_token: refreshToken,
    expiry_date: tokens.expiry_date ?? (Date.now() + 60 * 60 * 1000),
  };

  oauth2Client.setCredentials(oauthTokens);
  driveClient = google.drive({ version: 'v3', auth: oauth2Client });
  authType = 'oauth';
}

export function setOAuthTokens(tokens: typeof oauthTokens): void {
  oauthTokens = tokens;
  if (tokens) {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials(tokens);
    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    authType = 'oauth';
  }
}

export async function initServiceAccount(): Promise<void> {
  if (!config.GOOGLE_SERVICE_ACCOUNT_EMAIL || !config.GOOGLE_PRIVATE_KEY) {
    throw new Error('Service account credentials not configured');
  }

  const auth = new google.auth.JWT({
    email: config.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: config.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
    ],
    // Impersonate a user who has access to the Shared Drive
    subject: config.GOOGLE_IMPERSONATE_USER,
  });

  driveClient = google.drive({ version: 'v3', auth });
  authType = 'service_account';
  
  if (config.GOOGLE_IMPERSONATE_USER) {
    log.info(`✅ Service account authenticated (impersonating ${config.GOOGLE_IMPERSONATE_USER})`);
  } else {
    log.info('✅ Service account authenticated');
  }
}

export function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    throw new Error('Drive client not initialized. Complete OAuth flow or configure service account.');
  }
  return driveClient;
}

export function isAuthenticated(): boolean {
  return driveClient !== null;
}

export function getAuthType(): typeof authType {
  return authType;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  videoMediaMetadata?: {
    width?: number;
    height?: number;
    durationMillis?: string;
  };
}

export async function listFiles(
  folderId: string = 'root',
  pageToken?: string,
  isSharedDriveRoot: boolean = false
): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const drive = getDriveClient();

  // For Shared Drive roots, we need to use driveId parameter
  const params: any = {
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'nextPageToken, files(id, name, mimeType, size, parents, createdTime, modifiedTime, videoMediaMetadata)',
    pageSize: 1000,
    pageToken,
    // Support Shared Drives
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  };

  // If this is a Shared Drive root, use driveId and corpora=drive
  if (isSharedDriveRoot) {
    params.driveId = folderId;
    params.corpora = 'drive';
  } else {
    params.corpora = 'allDrives';
  }

  const response = await drive.files.list(params);

  return {
    files: (response.data.files || []) as DriveFile[],
    nextPageToken: response.data.nextPageToken || undefined,
  };
}

// Check if a folder ID is a Shared Drive root
export async function isSharedDrive(folderId: string): Promise<boolean> {
  const drive = getDriveClient();
  try {
    await drive.drives.get({ driveId: folderId });
    return true;
  } catch {
    return false;
  }
}

export async function getFile(fileId: string): Promise<DriveFile | null> {
  const drive = getDriveClient();

  try {
    const response = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size, parents, createdTime, modifiedTime, videoMediaMetadata',
      supportsAllDrives: true,
    });
    return response.data as DriveFile;
  } catch (error) {
    return null;
  }
}

export async function downloadFile(
  fileId: string,
  destPath: string,
  onProgress?: (progress: number, downloadedBytes: number) => void,
  options?: { signal?: AbortSignal }
): Promise<void> {
  return withDownloadSlot(async () => {
  const drive = getDriveClient();
  const fs = await import('fs');
  const signal = options?.signal;

  if (signal?.aborted) {
    throw new JobCancelledError();
  }

  // Get file size first for progress tracking
  const fileInfo = await getFile(fileId);
  const totalSize = fileInfo?.size ? parseInt(fileInfo.size) : 0;
  
  log.info(
    `Starting download: ${fileInfo?.name} (${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB)`,
  );

  const response = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream', signal }
  );

  const dest = fs.createWriteStream(destPath);
  let downloadedSize = 0;
  let lastLogTime = Date.now();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      try {
        response.data.destroy();
      } catch {
        /* ignore */
      }
      try {
        dest.destroy();
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(destPath);
      } catch {
        /* partial file */
      }
      finish(() => reject(new JobCancelledError()));
    };

    const stream = response.data;

    signal?.addEventListener('abort', onAbort, { once: true });
    
    stream.on('data', (chunk: Buffer) => {
      downloadedSize += chunk.length;
      
      if (onProgress && totalSize > 0) {
        onProgress(Math.round((downloadedSize / totalSize) * 100), downloadedSize);
      }
      
      // Log progress every 10 seconds
      const now = Date.now();
      if (now - lastLogTime > 10000) {
        const progressPct = totalSize > 0 ? (downloadedSize / totalSize * 100).toFixed(1) : '?';
        log.debug(
          `Download progress: ${(downloadedSize / 1024 / 1024).toFixed(0)} MB / ${(totalSize / 1024 / 1024).toFixed(0)} MB (${progressPct}%)`,
        );
        lastLogTime = now;
      }
    });
    
    stream.on('end', () => {
      log.info(`Download complete: ${(downloadedSize / 1024 / 1024).toFixed(0)} MB`);
      dest.end();
      finish(() => resolve());
    });
    
    stream.on('error', (err: Error) => {
      log.error(`Download error at ${(downloadedSize / 1024 / 1024).toFixed(0)} MB:`, err.message);
      const body = (err as { response?: { data?: unknown } })?.response?.data;
      if (body != null) {
        log.warn('Drive download error body:', JSON.stringify(body));
      }
      dest.end();
      finish(() =>
        signal?.aborted ? reject(new JobCancelledError()) : reject(err)
      );
    });
    
    stream.pipe(dest);
    
    dest.on('error', (err: Error) => {
      log.error('File write error:', err.message);
      finish(() =>
        signal?.aborted ? reject(new JobCancelledError()) : reject(err)
      );
    });
  });
  });
}

export async function uploadFile(
  filePath: string,
  fileName: string,
  parentFolderId: string,
  mimeType: string = 'video/mp4',
  onProgress?: (progress: number, uploadedBytes: number) => void,
  options?: { signal?: AbortSignal }
): Promise<string> {
  return withUploadSlot(async () => {
  const drive = getDriveClient();
  const fs = await import('fs');
  const signal = options?.signal;

  if (signal?.aborted) {
    throw new JobCancelledError();
  }

  const fileSize = fs.statSync(filePath).size;
  log.info(`Starting upload: ${fileName} (${(fileSize / 1024 / 1024).toFixed(0)} MB)`);

  const readStream = fs.createReadStream(filePath);
  let uploadedSize = 0;
  let lastLogTime = Date.now();

  const onAbort = () => {
    readStream.destroy();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  readStream.on('data', (chunk: string | Buffer) => {
    uploadedSize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    
    if (onProgress && fileSize > 0) {
      onProgress(Math.round((uploadedSize / fileSize) * 100), uploadedSize);
    }
    
    const now = Date.now();
    if (now - lastLogTime > 10000) {
      const progressPct = (uploadedSize / fileSize * 100).toFixed(1);
      log.debug(
        `Upload progress: ${(uploadedSize / 1024 / 1024).toFixed(0)} MB / ${(fileSize / 1024 / 1024).toFixed(0)} MB (${progressPct}%)`,
      );
      lastLogTime = now;
    }
  });

  try {
    const response = await drive.files.create(
      {
        requestBody: {
          name: fileName,
          parents: [parentFolderId],
        },
        media: {
          mimeType,
          body: readStream,
        },
        fields: 'id',
        supportsAllDrives: true,
      },
      { signal }
    );

    log.info(`Upload complete: ${fileName} -> ${response.data.id}`);
    return response.data.id!;
  } catch (err) {
    if (signal?.aborted) {
      throw new JobCancelledError();
    }
    const body = (err as { response?: { data?: unknown } })?.response?.data;
    if (body != null) {
      log.warn('Drive upload error:', JSON.stringify(body));
    }
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  });
}

export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId, supportsAllDrives: true });
}

export async function trashFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
    supportsAllDrives: true,
  });
}
