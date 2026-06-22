"use strict";

// Fresh-database bootstrap. Creates the full schema on a new memory.db and is a
// no-op on an existing one (CREATE TABLE IF NOT EXISTS + guarded ALTERs), so it is
// safe to call on every open. Mirrors the live production schema exactly.

const cfg = require("../config");

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY,
      signature TEXT UNIQUE NOT NULL,
      memory_id TEXT,
      class TEXT,
      salience TEXT,
      strength REAL DEFAULT 0,
      reactivations INTEGER DEFAULT 0,
      first_seen TEXT,
      last_reactivated TEXT,
      last_decayed TEXT,
      notes TEXT,
      text TEXT,
      fact TEXT,
      kind TEXT
    );

    CREATE TABLE IF NOT EXISTS edges (
      src TEXT NOT NULL,
      rel TEXT,
      dst TEXT NOT NULL,
      weight REAL DEFAULT 0,
      first_seen TEXT,
      last_reinforced TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS tombstones (
      signature TEXT,
      memory_id TEXT,
      forgotten_at TEXT,
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS dream_journal (
      dreamed_at TEXT,
      run_id TEXT,
      op TEXT,
      memory_id TEXT,
      signature TEXT,
      category TEXT,
      original_fact TEXT,
      result_fact TEXT,
      reason TEXT
    );
  `);

  // vec0 virtual table (sqlite-vec). Dimensionality is configurable; cosine metric.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(embedding float[${cfg.EMBED_DIM}] distance_metric=cosine)`);

  // Guarded migrations for databases created before fact/kind columns existed.
  for (const col of ["kind TEXT", "fact TEXT"]) {
    try { db.exec(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
}

module.exports = { ensureSchema };
