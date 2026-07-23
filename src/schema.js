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
      source_day TEXT,
      last_reactivated TEXT,
      last_decayed TEXT,
      notes TEXT,
      text TEXT,
      fact TEXT,
      kind TEXT,
      temporal_form TEXT,
      memory_family TEXT,
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

    -- Durable evidence chronology. Active semantic graph edges can be removed when
    -- a fact demotes to Tier 3; exact sequence/correction topology cannot.
    CREATE TABLE IF NOT EXISTS evidence_transitions (
      src_sig         TEXT NOT NULL,
      rel             TEXT NOT NULL,
      dst_sig         TEXT NOT NULL,
      first_seen      TEXT,
      last_reinforced TEXT,
      PRIMARY KEY (src_sig, rel, dst_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_transitions_src ON evidence_transitions(src_sig, rel);
    CREATE INDEX IF NOT EXISTS idx_evidence_transitions_dst ON evidence_transitions(dst_sig, rel);

    -- Caller-judged temporal memory. Chronicles are nodes(kind='chronicle') so
    -- they can be embedded, ranked, decayed, and projected without entering
    -- semantic fact merge/synthesis paths.
    CREATE TABLE IF NOT EXISTS chronicles (
      node_sig            TEXT PRIMARY KEY,
      resolution          TEXT NOT NULL,
      period_start        TEXT NOT NULL,
      period_end          TEXT NOT NULL,
      version             INTEGER NOT NULL,
      compression_level   INTEGER NOT NULL DEFAULT 0,
      covered_event_count INTEGER NOT NULL DEFAULT 0,
      omitted_event_count INTEGER NOT NULL DEFAULT 0,
      latest_event_day    TEXT,
      coverage_seq        INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL,
      UNIQUE (resolution, period_start, period_end, version)
    );
    CREATE INDEX IF NOT EXISTS idx_chronicles_period
      ON chronicles(resolution, period_start, period_end, version DESC);

    CREATE TABLE IF NOT EXISTS chronicle_entries (
      chronicle_sig TEXT NOT NULL,
      ordinal       INTEGER NOT NULL,
      slot_label    TEXT NOT NULL,
      summary       TEXT NOT NULL,
      change_kind   TEXT NOT NULL,
      state_label   TEXT,
      aspect        TEXT,
      PRIMARY KEY (chronicle_sig, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_chronicle_entries_aspect
      ON chronicle_entries(aspect, chronicle_sig);

    CREATE TABLE IF NOT EXISTS chronicle_entry_entities (
      chronicle_sig TEXT NOT NULL,
      entry_ordinal INTEGER NOT NULL,
      entity_sig    TEXT NOT NULL,
      PRIMARY KEY (chronicle_sig, entry_ordinal, entity_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_chronicle_entry_entities_entity
      ON chronicle_entry_entities(entity_sig, chronicle_sig);

    CREATE TABLE IF NOT EXISTS chronicle_evidence (
      chronicle_sig TEXT NOT NULL,
      entry_ordinal INTEGER NOT NULL,
      evidence_sig  TEXT NOT NULL,
      PRIMARY KEY (chronicle_sig, entry_ordinal, evidence_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_chronicle_evidence_evidence
      ON chronicle_evidence(evidence_sig, chronicle_sig);

    CREATE TRIGGER IF NOT EXISTS trg_chronicle_entry_parent_insert
    BEFORE INSERT ON chronicle_entries
    WHEN NOT EXISTS (
      SELECT 1 FROM chronicles c JOIN nodes n ON n.signature=c.node_sig
      WHERE c.node_sig=NEW.chronicle_sig AND n.kind='chronicle'
    )
    BEGIN
      SELECT RAISE(ABORT, 'chronicle entry requires a live chronicle parent');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chronicle_entity_facet_insert
    BEFORE INSERT ON chronicle_entry_entities
    WHEN NOT EXISTS (
      SELECT 1 FROM chronicle_entries e
      WHERE e.chronicle_sig=NEW.chronicle_sig AND e.ordinal=NEW.entry_ordinal
    ) OR NOT EXISTS (
      SELECT 1 FROM nodes n WHERE n.signature=NEW.entity_sig AND n.kind='entity'
    )
    BEGIN
      SELECT RAISE(ABORT, 'chronicle entity facet requires a live entry and entity');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chronicle_entity_facet_update
    BEFORE UPDATE ON chronicle_entry_entities
    WHEN NOT EXISTS (
      SELECT 1 FROM chronicle_entries e
      WHERE e.chronicle_sig=NEW.chronicle_sig AND e.ordinal=NEW.entry_ordinal
    ) OR NOT EXISTS (
      SELECT 1 FROM nodes n WHERE n.signature=NEW.entity_sig AND n.kind='entity'
    )
    BEGIN
      SELECT RAISE(ABORT, 'chronicle entity facet requires a live entry and entity');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chronicle_evidence_insert
    BEFORE INSERT ON chronicle_evidence
    WHEN NOT EXISTS (
      SELECT 1 FROM chronicle_entries e
      WHERE e.chronicle_sig=NEW.chronicle_sig AND e.ordinal=NEW.entry_ordinal
    ) OR NOT EXISTS (
      SELECT 1 FROM nodes n WHERE n.signature=NEW.evidence_sig
    )
    BEGIN
      SELECT RAISE(ABORT, 'chronicle evidence requires a live entry and evidence node');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_chronicle_evidence_update
    BEFORE UPDATE ON chronicle_evidence
    WHEN NOT EXISTS (
      SELECT 1 FROM chronicle_entries e
      WHERE e.chronicle_sig=NEW.chronicle_sig AND e.ordinal=NEW.entry_ordinal
    ) OR NOT EXISTS (
      SELECT 1 FROM nodes n WHERE n.signature=NEW.evidence_sig
    )
    BEGIN
      SELECT RAISE(ABORT, 'chronicle evidence requires a live entry and evidence node');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_nodes_delete_chronicle_entity_guard
    BEFORE DELETE ON nodes
    WHEN OLD.kind='entity' AND EXISTS (
      SELECT 1 FROM chronicle_entry_entities e WHERE e.entity_sig=OLD.signature
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete entity referenced by chronicle facets');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_nodes_delete_chronicle_evidence_guard
    BEFORE DELETE ON nodes
    WHEN EXISTS (
      SELECT 1 FROM chronicle_evidence e WHERE e.evidence_sig=OLD.signature
    )
    BEGIN
      SELECT RAISE(ABORT, 'cannot delete evidence referenced by chronicles');
    END;

    CREATE TABLE IF NOT EXISTS gist_landmarks (
      gist_sig     TEXT NOT NULL,
      role         TEXT NOT NULL,
      ordinal      INTEGER NOT NULL,
      evidence_sig TEXT NOT NULL,
      PRIMARY KEY (gist_sig, role, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_gist_landmarks_evidence
      ON gist_landmarks(evidence_sig, gist_sig);

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

    -- Reactivation evidence is aggregated by family/member. Exact cumulative
    -- counters drive review cursors; only a small example ring is retained.
    CREATE TABLE IF NOT EXISTS reactivation_families (
      family_key    TEXT PRIMARY KEY,
      evidence_seq  INTEGER NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      observed_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reactivation_members (
      family_key    TEXT NOT NULL,
      member_sig    TEXT NOT NULL,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      latest_seq    INTEGER NOT NULL DEFAULT 0,
      observed_at   TEXT NOT NULL,
      PRIMARY KEY (family_key, member_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_reactivation_members_family
      ON reactivation_members(family_key, evidence_count DESC, latest_seq DESC);
    CREATE TABLE IF NOT EXISTS reactivation_examples (
      family_key    TEXT NOT NULL,
      new_sig       TEXT NOT NULL,
      old_sig       TEXT NOT NULL,
      observed_seq  INTEGER NOT NULL,
      observed_at   TEXT NOT NULL,
      PRIMARY KEY (family_key, new_sig, old_sig)
    );
    CREATE INDEX IF NOT EXISTS idx_reactivation_examples_family
      ON reactivation_examples(family_key, observed_seq DESC);

    -- One review cursor per stable recurrence family (the shared entity hub).
    -- Accepted and rejected families remain quiet until genuinely new evidence
    -- arrives beyond reviewed_seq.
    CREATE TABLE IF NOT EXISTS reactivation_reviews (
      family_key   TEXT PRIMARY KEY,
      decision     TEXT NOT NULL,
      gist_sigs    TEXT,
      reviewed_seq INTEGER NOT NULL,
      reviewed_count INTEGER NOT NULL DEFAULT 0,
      reviewed_at  TEXT NOT NULL,
      report_id    TEXT
    );
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
  // Dedicated temporal indexes prevent dense semantic facts from crowding
  // chronicles out of a global KNN window before the temporal lane can rank them.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chronicles USING vec0(embedding float[${cfg.EMBED_DIM}] distance_metric=cosine)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chronicles_archive USING vec0(embedding float[${cfg.EMBED_DIM}] distance_metric=cosine)`);

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
    "source_day TEXT",
    "temporal_form TEXT",
    "memory_family TEXT",
  ]) {
    try { db.exec(`ALTER TABLE nodes ADD COLUMN ${col}`); } catch (e) { /* already present */ }
  }
  const insertChronicleVec = db.prepare("INSERT OR IGNORE INTO vec_chronicles(rowid,embedding) VALUES (?,?)");
  for (const row of db.prepare(`
    SELECT n.id,v.embedding FROM nodes n JOIN vec_nodes v ON v.rowid=n.id
    LEFT JOIN vec_chronicles cv ON cv.rowid=n.id
    WHERE n.kind='chronicle' AND coalesce(n.notes,'')<>'archive' AND cv.rowid IS NULL
  `).all()) insertChronicleVec.run(BigInt(row.id), row.embedding);
  const insertArchiveChronicleVec = db.prepare("INSERT OR IGNORE INTO vec_chronicles_archive(rowid,embedding) VALUES (?,?)");
  for (const row of db.prepare(`
    SELECT n.id,v.embedding FROM nodes n JOIN vec_archive v ON v.rowid=n.id
    LEFT JOIN vec_chronicles_archive cv ON cv.rowid=n.id
    WHERE n.kind='chronicle' AND n.notes='archive' AND cv.rowid IS NULL
  `).all()) insertArchiveChronicleVec.run(BigInt(row.id), row.embedding);
  db.prepare(`
    DELETE FROM chronicle_entry_entities
    WHERE NOT EXISTS (
      SELECT 1 FROM nodes n
      WHERE n.signature=chronicle_entry_entities.entity_sig AND n.kind='entity'
    )
  `).run();
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_dirty_seq ON nodes(dirty_seq)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_memory_id ON nodes(memory_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_kind_notes_first_seen ON nodes(kind, notes, first_seen)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_source_day ON nodes(source_day)");
  try { db.exec("ALTER TABLE reactivation_reviews ADD COLUMN reviewed_count INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* already present */ }

  // Preserve every surviving sequence/correction edge before later demotion or
  // merge cleanup can remove it from the active semantic graph.
  db.prepare(`
    INSERT OR IGNORE INTO evidence_transitions(src_sig,rel,dst_sig,first_seen,last_reinforced)
    SELECT src,rel,dst,first_seen,last_reinforced
    FROM edges
    WHERE rel IN ('sequence','supersedes') AND src<>dst
  `).run();

  // Add narrow day-level provenance for verbatim evidence. first_seen remains
  // an internal ordering/age key and is never exposed as a gist source date.
  const sourceDayMigration = db.prepare("SELECT value FROM meta WHERE key='source_day_migrated_v1'").get();
  if (!sourceDayMigration) {
    db.prepare(`
      UPDATE nodes
      SET source_day = substr(first_seen, 1, 10)
      WHERE kind='fact'
        AND coalesce(notes,'') <> 'gist'
        AND first_seen IS NOT NULL
        AND source_day IS NULL
    `).run();
    db.prepare("UPDATE nodes SET source_day=NULL WHERE notes='gist'").run();
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('source_day_migrated_v1','1')").run();
  }

  // Pairwise recurrence rows were transient evidence and grew quadratically.
  // Aggregates rebuild from later dreams; dropping them is intentionally cheap.
  const aggregateMigration = db.prepare("SELECT value FROM meta WHERE key='reactivation_aggregates_v1'").get();
  if (!aggregateMigration) {
    db.exec("DROP TABLE IF EXISTS reactivation_events");
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reactivation_aggregates_v1','1')").run();
  }

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
