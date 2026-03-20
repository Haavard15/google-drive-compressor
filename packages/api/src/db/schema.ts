import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const files = sqliteTable('files', {
  id: text('id').primaryKey(),                    // Google Drive file ID
  name: text('name').notNull(),
  mimeType: text('mime_type'),
  size: integer('size'),                          // bytes
  parentId: text('parent_id'),
  path: text('path'),                             // computed full path
  isFolder: integer('is_folder', { mode: 'boolean' }).default(false),

  // Video metadata (from Drive API)
  duration: integer('duration'),                  // milliseconds
  width: integer('width'),
  height: integer('height'),

  // AI analysis
  suggestion: text('suggestion'),                 // 'delete' | 'compress' | 'keep' | null
  suggestionReason: text('suggestion_reason'),
  confidence: real('confidence'),

  // Processing state
  status: text('status').default('pending'),      // pending | queued | processing | done | error
  compressedSize: integer('compressed_size'),
  newFileId: text('new_file_id'),                 // ID of compressed file after upload

  // Timestamps
  createdAt: integer('created_at', { mode: 'timestamp' }),
  modifiedAt: integer('modified_at', { mode: 'timestamp' }),
  scannedAt: integer('scanned_at', { mode: 'timestamp' }),

  /** Set on each upsert during a scan; used after a successful full scan to mark rows never visited. */
  lastSeenScanJobId: integer('last_seen_scan_job_id'),
  /** True when the last completed scan did not see this row (removed from Drive or outside scanned tree). */
  missingFromDrive: integer('missing_from_drive', { mode: 'boolean' }).default(false),
});

export const actions = sqliteTable('actions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileId: text('file_id').references(() => files.id),
  action: text('action').notNull(),               // 'delete' | 'compress' | 'download'
  status: text('status').default('pending'),      // pending | running | completed | failed | cancelled
  priority: integer('priority').default(0),
  progress: integer('progress').default(0),       // 0-100
  error: text('error'),
  metadata: text('metadata'),                     // JSON string for additional data
  /** Original Drive file size (bytes) when the job started */
  sizeBeforeBytes: integer('size_before_bytes'),
  /** Result size: compressed output, local download size, or null for delete / unknown */
  sizeAfterBytes: integer('size_after_bytes'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

/** Written after compress + upload when the source file is successfully moved to Drive trash. */
export const sourceReplacementLog = sqliteTable('source_replacement_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actionId: integer('action_id')
    .notNull()
    .references(() => actions.id, { onDelete: 'cascade' })
    .unique(),
  sourceFileId: text('source_file_id').notNull(),
  sourceFileName: text('source_file_name').notNull(),
  newFileId: text('new_file_id').notNull(),
  newFileName: text('new_file_name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
});

export const scanJobs = sqliteTable('scan_jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  rootFolderId: text('root_folder_id'),
  status: text('status').default('pending'),      // pending | running | completed | failed
  totalFiles: integer('total_files').default(0),
  scannedFiles: integer('scanned_files').default(0),
  totalSize: integer('total_size').default(0),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

/** Key-value settings; booleans stored as 'true' | 'false' */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type Action = typeof actions.$inferSelect;
export type NewAction = typeof actions.$inferInsert;
export type SourceReplacementLog = typeof sourceReplacementLog.$inferSelect;
export type NewSourceReplacementLog = typeof sourceReplacementLog.$inferInsert;
export type ScanJob = typeof scanJobs.$inferSelect;
export type NewScanJob = typeof scanJobs.$inferInsert;
export type AppSetting = typeof appSettings.$inferSelect;
