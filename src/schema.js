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
      kind TEXT,
      salience_score REAL DEFAULT 0,
      ingested_seq INTEGER DEFAULT 0,
      dirty_seq INTEGER DEFAULT 0
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
    CREATE INDEX IF NOT EXISTS idx_edges_rel ON edges(rel);
    CREATE INDEX IF NOT EXISTS idx_edges_rel_src ON edges(rel, src);
    CREATE INDEX IF NOT EXISTS idx_edges_rel_dst ON edges(rel, dst);

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

    -- CALLER ADJUDICATIONS on mechanically-proposed entity hubs (Mapping Dataflow
    -- fix, durable half). A deterministic/mechanical hub candidate is always
    -- PROVISIONAL until the caller reviews it via report-entities/apply-entities hub
    -- review. This is a real schema/table, not JSON hidden in notes, precisely so a
    -- rejected or retyped mechanical candidate is never silently recreated by a
    -- later weave: weave() consults this table and refuses to recreate any sig
    -- whose status is 'rejected' or 'retyped'. status: 'provisional' (never
    -- reviewed) | 'approved' (caller kept/created/updated it) | 'rejected' (caller
    -- says this candidate is not a real entity) | 'retyped' (superseded by
    -- retyped_to). One row per mechanically- or caller-known hub signature.
    CREATE TABLE IF NOT EXISTS entity_adjudications (
      sig          TEXT PRIMARY KEY,
      status       TEXT NOT NULL,
      action       TEXT,
      retyped_to   TEXT,
      reviewed_at  TEXT,
      reviewed_seq INTEGER,
      report_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_entity_adjudications_status ON entity_adjudications(status);
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
  // salience_score (Layer 4): continuous [0,1] importance judged at dream time; modulates
  // half-life. Defaults 0 so pre-existing facts decay purely on their durability class until
  // the dream re-judges them (NULL is coalesced to 0 in the decay formula regardless).
  for (const col of [
    "kind TEXT",
    "fact TEXT",
    "vagueness REAL",
    "salience_score REAL DEFAULT 0",
    "ingested_seq INTEGER DEFAULT 0",
    "dirty_seq INTEGER DEFAULT 0",
  ]) {
    try { db.exec(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_dirty_seq ON nodes(dirty_seq)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_memory_id ON nodes(memory_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_kind_notes_first_seen ON nodes(kind, notes, first_seen)");

  // Legacy stores can contain duplicate harness IDs. Rewriting either row would
  // destroy projection identity, so leave those rows for doctor/operator repair
  // while preventing every new insert or memory_id change from adding ambiguity.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_nodes_memory_id_insert_unique
    BEFORE INSERT ON nodes
    WHEN coalesce(NEW.memory_id, '') <> ''
      AND EXISTS (SELECT 1 FROM nodes WHERE memory_id = NEW.memory_id)
    BEGIN
      SELECT RAISE(ABORT, 'duplicate non-empty memory_id');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_nodes_memory_id_update_unique
    BEFORE UPDATE OF memory_id ON nodes
    WHEN coalesce(NEW.memory_id, '') <> ''
      AND EXISTS (
        SELECT 1 FROM nodes
        WHERE memory_id = NEW.memory_id AND id <> OLD.id
      )
    BEGIN
      SELECT RAISE(ABORT, 'duplicate non-empty memory_id');
    END;
  `);

  // Many mutation paths intentionally use INSERT OR IGNORE for graph edges. That is
  // only meaningful when the schema enforces edge identity. Old stores may already
  // contain duplicates, so collapse them once before creating the unique index.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(src, ifnull(rel,''), dst)");
  } catch (e) {
    db.transaction(() => {
      db.exec(`
        DELETE FROM edges
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM edges GROUP BY src, ifnull(rel,''), dst
        )
      `);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique ON edges(src, ifnull(rel,''), dst)");
    })();
  }
}

module.exports = { ensureSchema };
