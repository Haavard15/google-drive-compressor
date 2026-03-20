import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { config } from '../config.js';
import { log } from '../logger.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

let db: ReturnType<typeof drizzle<typeof schema>>;
let sqlite: Database.Database;

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export async function initDb() {
  // Extract file path from DATABASE_URL
  const dbPath = config.DATABASE_URL.replace('file:', '');
  
  // Ensure directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Create SQLite connection
  sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  
  // Create Drizzle instance
  db = drizzle(sqlite, { schema });

  // Run migrations or create tables directly
  await createTables();

  log.info('✅ Database initialized');
  return db;
}

async function createTables() {
  // Create tables directly (simpler than migrations for initial setup)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      parent_id TEXT,
      path TEXT,
      is_folder INTEGER DEFAULT 0,
      duration INTEGER,
      width INTEGER,
      height INTEGER,
      suggestion TEXT,
      suggestion_reason TEXT,
      confidence REAL,
      status TEXT DEFAULT 'pending',
      compressed_size INTEGER,
      new_file_id TEXT,
      created_at INTEGER,
      modified_at INTEGER,
      scanned_at INTEGER,
      last_seen_scan_job_id INTEGER,
      missing_from_drive INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT REFERENCES files(id),
      action TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      error TEXT,
      metadata TEXT,
      size_before_bytes INTEGER,
      size_after_bytes INTEGER,
      created_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS scan_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_folder_id TEXT,
      status TEXT DEFAULT 'pending',
      total_files INTEGER DEFAULT 0,
      scanned_files INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      error TEXT,
      created_at INTEGER,
      completed_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);
    CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
    CREATE INDEX IF NOT EXISTS idx_files_suggestion ON files(suggestion);
    CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    CREATE INDEX IF NOT EXISTS idx_actions_file ON actions(file_id);
  `);

  const cols = sqlite.prepare(`PRAGMA table_info(actions)`).all() as { name: string }[];
  const has = (n: string) => cols.some((c) => c.name === n);
  if (!has('size_before_bytes')) {
    sqlite.exec(`ALTER TABLE actions ADD COLUMN size_before_bytes INTEGER;`);
  }
  if (!has('size_after_bytes')) {
    sqlite.exec(`ALTER TABLE actions ADD COLUMN size_after_bytes INTEGER;`);
  }

  const fileCols = sqlite.prepare(`PRAGMA table_info(files)`).all() as { name: string }[];
  const fileHas = (n: string) => fileCols.some((c) => c.name === n);
  if (!fileHas('last_seen_scan_job_id')) {
    sqlite.exec(`ALTER TABLE files ADD COLUMN last_seen_scan_job_id INTEGER;`);
  }
  if (!fileHas('missing_from_drive')) {
    sqlite.exec(`ALTER TABLE files ADD COLUMN missing_from_drive INTEGER DEFAULT 0;`);
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS source_replacement_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
      source_file_id TEXT NOT NULL,
      source_file_name TEXT NOT NULL,
      new_file_id TEXT NOT NULL,
      new_file_name TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_source_replacement_action ON source_replacement_log(action_id);
  `);
}

export function closeDb() {
  if (sqlite) {
    sqlite.close();
  }
}

export function runRawQuery<T>(query: string, params: any[] = []): T[] {
  if (!sqlite) {
    throw new Error('Database not initialized');
  }
  return sqlite.prepare(query).all(...params) as T[];
}

export { schema };
