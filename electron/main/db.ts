import Database from 'better-sqlite3';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('userData'), 'senseframe');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'senseframe.sqlite'));
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      status TEXT NOT NULL,
      total_photos INTEGER DEFAULT 0,
      processed_photos INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      file_mtime TEXT,
      shot_at TEXT,
      camera_model TEXT,
      lens_model TEXT,
      iso INTEGER,
      aperture REAL,
      focal_length REAL,
      shutter_speed TEXT,
      width INTEGER,
      height INTEGER,
      thumb_path TEXT,
      preview_path TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photo_analysis (
      photo_id TEXT PRIMARY KEY,
      sharpness_score REAL NOT NULL,
      exposure_score REAL NOT NULL,
      highlight_clip_ratio REAL NOT NULL,
      shadow_clip_ratio REAL NOT NULL,
      face_score REAL NOT NULL,
      eyes_open_score REAL NOT NULL,
      face_count INTEGER NOT NULL,
      final_score REAL NOT NULL,
      risk_flags TEXT NOT NULL,
      face_visibility TEXT NOT NULL DEFAULT 'unknown',
      eye_state TEXT NOT NULL DEFAULT 'unknown',
      eye_confidence REAL NOT NULL DEFAULT 0,
      left_eye_state TEXT NOT NULL DEFAULT 'missing',
      right_eye_state TEXT NOT NULL DEFAULT 'missing',
      debug_regions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      size INTEGER NOT NULL,
      best_photo_id TEXT,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cluster_members (
      cluster_id TEXT NOT NULL,
      photo_id TEXT NOT NULL,
      rank_in_cluster INTEGER NOT NULL,
      similarity_to_best REAL NOT NULL,
      recommended INTEGER NOT NULL,
      PRIMARY KEY(cluster_id, photo_id)
    );

    CREATE TABLE IF NOT EXISTS decisions (
      photo_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      rating INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS semantic_analysis (
      photo_id TEXT PRIMARY KEY,
      scene TEXT NOT NULL,
      subjects TEXT NOT NULL,
      emotion TEXT NOT NULL,
      usage TEXT NOT NULL,
      composition TEXT NOT NULL,
      caption TEXT NOT NULL,
      recommendation_reason TEXT NOT NULL,
      llm_score TEXT NOT NULL,
      model TEXT NOT NULL,
      is_mock INTEGER NOT NULL,
      embedding TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensurePhotoAnalysisColumns(database);
}

function ensurePhotoAnalysisColumns(database: Database.Database): void {
  const columns = new Set((database.prepare('PRAGMA table_info(photo_analysis)').all() as Array<{ name: string }>).map((column) => column.name));
  const additions: Array<[string, string]> = [
    ['face_visibility', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['eye_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['eye_confidence', 'REAL NOT NULL DEFAULT 0'],
    ['left_eye_state', "TEXT NOT NULL DEFAULT 'missing'"],
    ['right_eye_state', "TEXT NOT NULL DEFAULT 'missing'"],
    ['debug_regions', "TEXT NOT NULL DEFAULT '[]'"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE photo_analysis ADD COLUMN ${name} ${definition}`);
  }
}
