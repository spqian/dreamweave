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

    -- DURABLE gist -> detail lineage (R1). When retain-detail merge keeps a
    -- constituent as a 'detail' node, it also records the parent gist HERE, in a
    -- cold relation table that is NOT subject to graph-edge GC. The 'related_to'
    -- edge added at merge time is deleted when the detail is later demoted to the
    -- Tier-3 archive (DELETE FROM edges ...), which used to sever the gist->detail
    -- link and make the atom reachable only by brittle keyword scan. This table
    -- survives demotion so recall can always expand a gist back to its specifics.
    CREATE TABLE IF NOT EXISTS detail_of (
      detail_sig TEXT NOT NULL,
      gist_sig   TEXT NOT NULL,
      first_seen TEXT,
      PRIMARY KEY (detail_sig, gist_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_detail_of_gist   ON detail_of(gist_sig);
    CREATE INDEX IF NOT EXISTS idx_detail_of_detail ON detail_of(detail_sig);
  `);

  // Backfill detail_of for databases created before this table existed, from the
  // gist->detail 'related_to' edges that still survive (i.e. details not yet
  // demoted). Idempotent; cheap (NOT EXISTS guard). After the first demotion the
  // edge is gone, so this only recovers links for not-yet-archived details.
  try {
    db.prepare(`
      INSERT OR IGNORE INTO detail_of(detail_sig, gist_sig, first_seen)
      SELECT e.dst, e.src, e.first_seen
      FROM edges e
      JOIN nodes g ON g.signature = e.src AND g.notes = 'gist'
      JOIN nodes d ON d.signature = e.dst AND d.notes = 'detail'
      WHERE e.rel = 'related_to'
    `).run();
  } catch (e) { /* readonly db or pre-migration schema: skip */ }

  // vec0 virtual table (sqlite-vec). Dimensionality is configurable; cosine metric.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_nodes USING vec0(embedding float[${cfg.EMBED_DIM}] distance_metric=cosine)`);
  // vec_archive: vectors of DEMOTED (Tier-3) facts. At demotion the embedding is MOVED
  // here (not deleted — principle 1, pay-once), so the cold bookshelf stays reachable by
  // SIMILARITY, not just keyword, while staying out of every nightly query (which only
  // ever touches vec_nodes) — principle 2 (bounded nightly cost) is untouched.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_archive USING vec0(embedding float[${cfg.EMBED_DIM}] distance_metric=cosine)`);

  // Guarded migrations for databases created before fact/kind columns existed.
  for (const col of ["kind TEXT", "fact TEXT"]) {
    try { db.exec(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
}

module.exports = { ensureSchema };
