import { DatabaseSync } from 'node:sqlite'
import { lstat } from 'node:fs/promises'
import type { ImageFormat } from '../contracts.cjs'
import { StorageError } from './errors.cjs'

export const SCHEMA_VERSION = 18
export type AssetRow = {
  id: string; original_name: string; format: ImageFormat; width: number; height: number; orientation: number
  byte_size: number; sha256: string; original_path: string; thumbnail_path: string
  thumbnail_width: number; thumbnail_height: number; revision: number; created_at: string; updated_at: string
}
export type ImportRow = { id: string; original_path: string | null; thumbnail_path: string | null; created_at: string }

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try { const result = action(); db.exec('COMMIT'); return result }
  catch (error) { try { db.exec('ROLLBACK') } catch { /* A SQLite trigger may already have rolled back. */ } throw error }
}

export async function openDatabase(filename: string): Promise<DatabaseSync> {
  // Refuse redirected database files, including pre-existing WAL/SHM companions.
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    const stat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new StorageError('STORAGE_UNAVAILABLE', 'The workspace database is not a regular local file.')
  }
  const db = new DatabaseSync(filename, { allowExtension: false })
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL;')
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > SCHEMA_VERSION) throw new StorageError('SCHEMA_TOO_NEW', 'This workspace was created by a newer Frame Studio version. Open it with that version; your data has been preserved.')
    db.exec('PRAGMA journal_mode = WAL')
    if (version === 0) transaction(db, () => {
      db.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;
        CREATE TABLE assets (
          id TEXT PRIMARY KEY, original_name TEXT NOT NULL, format TEXT NOT NULL CHECK(format IN ('jpeg','png','webp')),
          width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
          orientation INTEGER NOT NULL CHECK(orientation BETWEEN 1 AND 8), byte_size INTEGER NOT NULL CHECK(byte_size > 0),
          sha256 TEXT NOT NULL CHECK(length(sha256) = 64), original_path TEXT NOT NULL UNIQUE,
          thumbnail_path TEXT NOT NULL UNIQUE, thumbnail_width INTEGER NOT NULL CHECK(thumbnail_width > 0),
          thumbnail_height INTEGER NOT NULL CHECK(thumbnail_height > 0), revision INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE import_jobs (
          id TEXT PRIMARY KEY, original_path TEXT, thumbnail_path TEXT, created_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString())
    })
    if (version < 2) transaction(db, () => {
      db.exec(`
        CREATE TABLE products (
          id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
          description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
          primary_asset_id TEXT NOT NULL REFERENCES assets(id), revision INTEGER NOT NULL CHECK(revision > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT
        ) STRICT;
        CREATE TABLE product_assets (
          product_id TEXT NOT NULL REFERENCES products(id), asset_id TEXT NOT NULL REFERENCES assets(id),
          position INTEGER NOT NULL CHECK(position >= 0), removed_at TEXT,
          PRIMARY KEY(product_id, asset_id)
        ) STRICT;
        CREATE INDEX product_assets_order ON product_assets(product_id, removed_at, position);
        CREATE UNIQUE INDEX product_assets_position ON product_assets(product_id, position);
        CREATE TABLE product_trash (
          token TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
          kind TEXT NOT NULL CHECK(kind IN ('product','photo')), asset_id TEXT REFERENCES assets(id),
          old_primary_id TEXT NOT NULL REFERENCES assets(id), fallback_primary_id TEXT NOT NULL REFERENCES assets(id),
          removed_revision INTEGER NOT NULL, created_at TEXT NOT NULL, restored_at TEXT
        ) STRICT;
        PRAGMA user_version = 2;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString())
    })
    if (version < 3) transaction(db, () => {
      db.exec(`
        CREATE TABLE asset_edits (
          asset_id TEXT PRIMARY KEY REFERENCES assets(id), source_asset_id TEXT NOT NULL REFERENCES assets(id), recipe TEXT NOT NULL
        ) STRICT;
        CREATE TABLE themes (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT
        ) STRICT;
        CREATE TABLE theme_revisions (
          theme_id TEXT NOT NULL REFERENCES themes(id), revision INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(theme_id, revision)
        ) STRICT;
        CREATE TABLE theme_assets (
          theme_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
          PRIMARY KEY(theme_id, revision, asset_id), FOREIGN KEY(theme_id, revision) REFERENCES theme_revisions(theme_id, revision)
        ) STRICT;
        CREATE TABLE theme_trash (
          token TEXT PRIMARY KEY, theme_id TEXT NOT NULL REFERENCES themes(id), removed_revision INTEGER NOT NULL,
          created_at TEXT NOT NULL, restored_at TEXT
        ) STRICT;
        PRAGMA user_version = 3;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString())
    })
    if (version < 4) transaction(db, () => {
      db.exec(`
        CREATE TABLE characters (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT
        ) STRICT;
        CREATE TABLE character_revisions (
          character_id TEXT NOT NULL REFERENCES characters(id), revision INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(character_id, revision)
        ) STRICT;
        CREATE TABLE character_assets (
          character_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
          PRIMARY KEY(character_id, revision, asset_id), FOREIGN KEY(character_id, revision) REFERENCES character_revisions(character_id, revision)
        ) STRICT;
        CREATE TABLE character_trash (
          token TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id), kind TEXT NOT NULL CHECK(kind IN ('character','photo')),
          asset_id TEXT REFERENCES assets(id), position INTEGER, photo_order TEXT NOT NULL DEFAULT '[]', old_primary_id TEXT NOT NULL REFERENCES assets(id),
          fallback_primary_id TEXT NOT NULL REFERENCES assets(id), removed_revision INTEGER NOT NULL, created_at TEXT NOT NULL, restored_at TEXT
        ) STRICT;
        PRAGMA user_version = 4;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(4, new Date().toISOString())
    })
    if (version < 5) transaction(db, () => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, snapshot TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE project_revisions (
          project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
          content TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(project_id, revision)
        ) STRICT;
        CREATE TABLE project_assets (
          project_id TEXT NOT NULL, revision INTEGER NOT NULL, asset_id TEXT NOT NULL REFERENCES assets(id),
          PRIMARY KEY(project_id, revision, asset_id),
          FOREIGN KEY(project_id, revision) REFERENCES project_revisions(project_id, revision)
        ) STRICT;
        PRAGMA user_version = 5;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(5, new Date().toISOString())
    })
    if (version < 6) transaction(db, () => {
      db.exec(`
        CREATE TABLE generation_attempts (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), scene_id TEXT NOT NULL,
          output_type TEXT NOT NULL CHECK(output_type IN ('reel','post')), prompt TEXT NOT NULL,
          references_json TEXT NOT NULL, preset TEXT NOT NULL, source_duration REAL,
          state TEXT NOT NULL CHECK(state IN ('queued','paused','submission-uncertain','ready-for-review','failed')),
          result_path TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX generation_attempts_project ON generation_attempts(project_id, created_at DESC);
        CREATE UNIQUE INDEX generation_single_active ON generation_attempts((1))
          WHERE state IN ('queued','paused','submission-uncertain');
        PRAGMA user_version = 6;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(6, new Date().toISOString())
    })
    if (version < 7) transaction(db, () => {
      db.exec(`
        CREATE TABLE scene_reviews (
          project_id TEXT NOT NULL REFERENCES projects(id), scene_id TEXT NOT NULL,
          selected_attempt_id TEXT REFERENCES generation_attempts(id),
          status TEXT NOT NULL CHECK(status IN ('pending','approved','needs-changes','needs-recheck')),
          note TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id, scene_id)
        ) STRICT;
        PRAGMA user_version = 7;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(7, new Date().toISOString())
    })
    if (version < 8) transaction(db, () => {
      db.exec(`
        CREATE TABLE project_exports (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
          output_type TEXT NOT NULL CHECK(output_type IN ('reel','post')), preset TEXT NOT NULL,
          path TEXT NOT NULL, width INTEGER NOT NULL CHECK(width > 0), height INTEGER NOT NULL CHECK(height > 0),
          duration REAL, source_attempt_ids TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX project_exports_project ON project_exports(project_id, created_at DESC);
        PRAGMA user_version = 8;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(8, new Date().toISOString())
    })
    if (version < 9) transaction(db, () => {
      db.exec(`
        CREATE TABLE flow_projects (project_id TEXT PRIMARY KEY REFERENCES projects(id), content TEXT NOT NULL) STRICT;
        CREATE TABLE flow_jobs (attempt_id TEXT PRIMARY KEY REFERENCES generation_attempts(id), project_id TEXT NOT NULL REFERENCES projects(id), content TEXT NOT NULL) STRICT;
        CREATE INDEX flow_jobs_project ON flow_jobs(project_id);
        PRAGMA user_version = 9;
      `)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(9, new Date().toISOString())
    })
    if (version < 10) transaction(db, () => {
      db.exec('ALTER TABLE projects ADD COLUMN trashed_at TEXT; CREATE INDEX projects_visible ON projects(trashed_at, updated_at); PRAGMA user_version = 10;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(10, new Date().toISOString())
    })
    if (version < 11) transaction(db, () => {
      db.exec(`DROP INDEX generation_single_active;
        CREATE INDEX generation_active ON generation_attempts(state) WHERE state IN ('queued','paused','submission-uncertain');
        CREATE UNIQUE INDEX generation_scene_active ON generation_attempts(project_id, scene_id) WHERE state IN ('queued','paused','submission-uncertain');
        PRAGMA user_version = 11;`)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(11, new Date().toISOString())
    })
    if (version < 12) transaction(db, () => {
      // Result paths now also live under Final Projects. Older apps cannot read
      // that layout safely, so keep the normal schema-too-new guard for them.
      db.exec('PRAGMA user_version = 12;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(12, new Date().toISOString())
    })
    if (version < 13) transaction(db, () => {
      db.exec(`ALTER TABLE generation_attempts ADD COLUMN automation_scope TEXT;
        UPDATE generation_attempts SET automation_scope=project_id WHERE EXISTS (SELECT 1 FROM flow_jobs j WHERE j.attempt_id=generation_attempts.id AND j.project_id=generation_attempts.project_id);
        PRAGMA user_version = 13;`)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(13, new Date().toISOString())
    })
    if (version < 14) transaction(db, () => {
      db.exec('ALTER TABLE generation_attempts ADD COLUMN revision_json TEXT; PRAGMA user_version = 14;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(14, new Date().toISOString())
    })
    if (version < 15) transaction(db, () => {
      db.exec('ALTER TABLE generation_attempts ADD COLUMN theme_reference_json TEXT; PRAGMA user_version = 15;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(15, new Date().toISOString())
    })
    if (version < 16) transaction(db, () => {
      db.exec('PRAGMA user_version = 16;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(16, new Date().toISOString())
    })
    if (version < 17) transaction(db, () => {
      db.exec(`CREATE TABLE logo_reviews (attempt_id TEXT PRIMARY KEY REFERENCES generation_attempts(id), project_id TEXT NOT NULL REFERENCES projects(id), content TEXT NOT NULL) STRICT;
        CREATE INDEX logo_reviews_project ON logo_reviews(project_id); PRAGMA user_version = 17;`)
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(17, new Date().toISOString())
    })
    if(version<18)transaction(db,()=>{
      db.exec('PRAGMA user_version=18;')
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(18,new Date().toISOString())
    })
    return db
  } catch (error) { db.close(); throw error }
}
