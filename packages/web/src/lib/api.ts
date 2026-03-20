const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseHeaders = new Headers(options?.headers);
  // Only send JSON content-type when there is a body; Fastify rejects empty body + application/json
  if (options?.body != null && !baseHeaders.has('Content-Type')) {
    baseHeaders.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: baseHeaders,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new Error(message);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// Auth
export const authApi = {
  getStatus: () => fetchApi<{
    authenticated: boolean;
    authType: string | null;
    hasServiceAccountConfig: boolean;
    hasOAuthConfig: boolean;
    hasGeminiConfig: boolean;
  }>('/auth/status'),
  
  getOAuthUrl: () => fetchApi<{ url: string }>('/auth/oauth/url'),
  
  initServiceAccount: () => fetchApi<{ success: boolean; message: string }>('/auth/service-account', {
    method: 'POST',
    body: JSON.stringify({}),
  }),
};

export interface AppConfigStatus {
  google: {
    serviceAccountEmail: string | null;
    hasServiceAccountPrivateKey: boolean;
    impersonateUser: string | null;
    rootFolderId: string | null;
    clientId: string | null;
    hasClientSecret: boolean;
    redirectUri: string;
  };
  gemini: {
    hasApiKey: boolean;
    analysisMode: 'gemini' | 'heuristic';
  };
}

export interface AppConfigPatch {
  serviceAccountJson?: string | null;
  googleImpersonateUser?: string | null;
  googleDriveRootFolderId?: string | null;
  googleClientId?: string | null;
  googleClientSecret?: string | null;
  googleRedirectUri?: string | null;
  geminiApiKey?: string | null;
}

export const appConfigApi = {
  get: () => fetchApi<AppConfigStatus>('/app-config'),
  patch: (patch: AppConfigPatch) =>
    fetchApi<{ success: boolean; config: AppConfigStatus }>('/app-config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

// Scan
export interface ScanJobDto {
  id: number;
  rootFolderId: string | null;
  status: string;
  totalFiles: number;
  scannedFiles: number;
  totalSize: number;
  error: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export const scanApi = {
  start: (folderId?: string) => fetchApi<{ success: boolean; jobId: number }>('/scan', {
    method: 'POST',
    body: JSON.stringify({ folderId }),
  }),

  getStatus: () =>
    fetchApi<{
      status: string;
      jobId?: number;
      scannedFiles?: number;
      totalFiles?: number;
      totalSize?: number;
      completedAt?: string;
      error?: string;
      message?: string;
    }>('/scan/status'),

  /** Most recent job row (any status). */
  getLatest: () => fetchApi<ScanJobDto | { message: string }>('/scan/latest'),

  /** Mark orphan `running` scan rows failed (keeps the in-flight job if this process is actually scanning). */
  recoverStuck: () =>
    fetchApi<{ success: boolean; recovered: number }>('/scan/recover-stuck', {
      method: 'POST',
    }),

  getJob: (jobId: number) =>
    fetchApi<{
      id: number;
      status: string;
      totalFiles: number;
      scannedFiles: number;
      totalSize: number;
    }>(`/scan/${jobId}`),
};

// Files
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  parentId: string | null;
  path: string | null;
  isFolder: boolean;
  duration: number | null;
  width: number | null;
  height: number | null;
  suggestion: 'delete' | 'compress' | 'keep' | null;
  suggestionReason: string | null;
  confidence: number | null;
  status: string;
  /** After a completed full scan: not seen under the scanned tree (removed from Drive or never under this root). */
  missingFromDrive?: boolean;
  lastSeenScanJobId?: number | null;
}

export interface FilesResponse {
  files: DriveFile[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export const filesApi = {
  list: (params?: {
    parentId?: string;
    suggestion?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    page?: number;
    limit?: number;
    videosOnly?: boolean;
    /** Omit rows where this Drive file was the source of a completed compress (new_file_id set). */
    excludeCompressed?: boolean;
    /** Omit rows that already have a pending or in-flight action in the queue. */
    excludeQueued?: boolean;
    /** Only rows flagged as no longer found on Drive after the last successful scan. */
    missingOnly?: boolean;
    /** Hide rows flagged missing from Drive (show only still-indexed). */
    hideMissing?: boolean;
  }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      });
    }
    return fetchApi<FilesResponse>(`/files?${searchParams}`);
  },
  
  getTreemap: (parentId?: string) => fetchApi<{
    files: Array<DriveFile & { size: number }>;
  }>(`/files/treemap${parentId ? `?parentId=${parentId}` : ''}`),
  
  getTree: () => fetchApi<{
    tree: Array<{
      id: string;
      name: string;
      parentId: string | null;
      size: number;
      fileCount: number;
      folderCount: number;
      children: any[];
    }>;
  }>('/files/tree'),
  
  get: (id: string) => fetchApi<{
    file: DriveFile;
    children?: DriveFile[];
  }>(`/files/${id}`),
  
  updateSuggestions: (fileIds: string[], suggestion: 'delete' | 'compress' | 'keep') =>
    fetchApi<{ updated: number }>('/files/suggestions', {
      method: 'PATCH',
      body: JSON.stringify({ fileIds, suggestion }),
    }),
};

// Stats
export interface Stats {
  storage: {
    totalFiles: number;
    totalFolders: number;
    totalSize: number;
    videoFiles: number;
    videoSize: number;
    /** Video rows still in DB but not seen in the last completed scan. */
    goneFromDriveVideos?: number;
    goneFromDriveVideoBytes?: number;
  };
  suggestions: {
    delete: { count: number; size: number };
    compress: { count: number; size: number; estimatedSavings: number };
    keep: { count: number; size: number };
    unanalyzed: number;
  };
  actions: {
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
  savings: {
    fromDeletion: number;
    fromCompression: number;
    total: number;
    percentageReduction: number;
  };
  system: {
    availableDiskSpace: number;
  };
  analysis: {
    mode: 'gemini' | 'heuristic';
    hasGeminiKey: boolean;
  };
  realized: {
    compressionBytesSaved: number;
    deletionBytesFreed: number;
    totalBytesReclaimed: number;
    completedCompressionJobs: number;
    completedDeletionJobs: number;
  };
}

export const compressionApi = {
  getPresets: () =>
    fetchApi<{
      presets: Array<{ id: string; label: string; description: string }>;
      defaultPreset: string;
    }>('/compression/presets'),
};

export const statsApi = {
  get: () => fetchApi<Stats>('/stats'),
  
  getLargest: (limit?: number) => fetchApi<{ files: DriveFile[] }>(`/stats/largest?limit=${limit || 50}`),
  
  getFolders: () => fetchApi<{
    folders: Array<{
      id: string;
      name: string;
      path: string;
      size: number;
      fileCount: number;
    }>;
  }>('/stats/folders'),
  
  analyze: (fileIds?: string[], batchSize?: number) => fetchApi<{
    analyzed: number;
    suggestions: Array<{
      fileId: string;
      suggestion: string;
      reason: string;
      confidence: number;
    }>;
  }>('/stats/analyze', {
    method: 'POST',
    body: JSON.stringify({ fileIds, batchSize }),
  }),
};

// Actions
export interface ActionProgressDetails {
  lastStatus: string | null;
  statusLine: string | null;
  lastUpdate: string | null;
  phase: string | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  speed: number;
  speedFormatted: string | null;
}

/** Present when a compress job moved the source to trash and uploaded a replacement. */
export interface SourceReplacementLog {
  sourceFileId: string;
  sourceFileName: string;
  newFileId: string;
  newFileName: string;
  newFileDriveUrl: string;
  loggedAt: string | null;
}

export interface Action {
  id: number;
  fileId: string;
  action: 'delete' | 'compress' | 'download';
  status: string;
  /** Higher runs first (matches API / pipeline workers). */
  priority?: number | null;
  /** Queue ordering tie-breaker (older first among same priority). */
  createdAt?: string | number | Date | null;
  progress: number;
  error: string | null;
  /** Bytes (Drive) when the job started */
  sizeBeforeBytes?: number | null;
  /** Bytes after: compressed file, local download, etc. */
  sizeAfterBytes?: number | null;
  file?: DriveFile;
  /** Raw JSON: preset, `pipelineStages` (download/encode/upload), `resumeLog`, progress fields, etc. */
  metadata?: string | null;
  progressDetails?: ActionProgressDetails;
  replacementLog?: SourceReplacementLog | null;
}

export interface ActionsListResponse {
  actions: Action[];
  pagination: { page: number; limit: number; total: number };
}

async function listAllActions(pageSize: number = 200): Promise<ActionsListResponse> {
  const collected: Action[] = [];
  let page = 1;
  let total = 0;

  while (page <= 50) {
    const batch = await actionsApi.list({ page, limit: pageSize });
    total = Number(batch.pagination.total ?? collected.length);
    collected.push(...batch.actions);
    if (batch.actions.length < pageSize || collected.length >= total) {
      break;
    }
    page += 1;
  }

  return {
    actions: collected,
    pagination: {
      page: 1,
      limit: collected.length || pageSize,
      total,
    },
  };
}

export const actionsApi = {
  list: (params?: { status?: string; action?: string; page?: number; limit?: number }) => {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) {
          searchParams.set(key, String(value));
        }
      });
    }
    return fetchApi<ActionsListResponse>(`/actions?${searchParams}`);
  },

  listAll: (pageSize?: number) => listAllActions(pageSize),
  
  create: (fileIds: string[], action: 'delete' | 'compress' | 'download', metadata?: Record<string, any>) =>
    fetchApi<{ success: boolean; created: number; actions: Action[] }>('/actions', {
      method: 'POST',
      body: JSON.stringify({ fileIds, action, metadata }),
    }),
  
  queueSuggestions: (
    suggestions?: string[],
    minConfidence?: number,
    compressMetadata?: { preset?: string; deleteOriginal?: boolean },
  ) =>
    fetchApi<{ success: boolean; queued: number }>('/actions/queue-suggestions', {
      method: 'POST',
      body: JSON.stringify({ suggestions, minConfidence, compressMetadata }),
    }),
  
  execute: (actionId: number) => fetchApi<{ success: boolean }>(`/actions/${actionId}/execute`, {
    method: 'POST',
  }),

  retry: (actionId: number) =>
    fetchApi<{ success: boolean; actionId: number }>(`/actions/${actionId}/retry`, {
      method: 'POST',
    }),
  
  executeNext: () => fetchApi<{ success: boolean; actionId?: number }>('/actions/execute-next', {
    method: 'POST',
  }),
  
  cancel: (actionId: number) => fetchApi<{ success: boolean }>(`/actions/${actionId}`, {
    method: 'DELETE',
  }),
  
  clear: (status?: string) => fetchApi<{ success: boolean }>(`/actions/clear${status ? `?status=${status}` : ''}`, {
    method: 'DELETE',
  }),

  /** Clears "running" rows that have no live worker (crash / kill). Safe if a job is actually running. */
  recoverStuck: () =>
    fetchApi<{ success: boolean; recovered: number }>('/actions/recover-stuck', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
};

export interface QueueSettings {
  autoAdvance: boolean;
  pauseAfterCurrent: boolean;
}

export const queueApi = {
  getSettings: () =>
    fetchApi<QueueSettings>('/queue/settings'),

  patchSettings: (patch: Partial<QueueSettings>) =>
    fetchApi<{ success: boolean } & QueueSettings>('/queue/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

// Format utilities
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '-';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatBitrate(size: number | null | undefined, durationMs: number | null | undefined): string {
  if (!size || !durationMs || durationMs === 0) return '-';
  const durationSec = durationMs / 1000;
  const bitrate = (size * 8) / durationSec; // bits per second
  
  if (bitrate >= 1_000_000_000) {
    return `${(bitrate / 1_000_000_000).toFixed(1)} Gbps`;
  }
  if (bitrate >= 1_000_000) {
    return `${(bitrate / 1_000_000).toFixed(1)} Mbps`;
  }
  if (bitrate >= 1_000) {
    return `${(bitrate / 1_000).toFixed(0)} Kbps`;
  }
  return `${bitrate.toFixed(0)} bps`;
}
