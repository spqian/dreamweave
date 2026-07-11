"use strict";

// A caller-approved entity may arrive after the fact was already woven. Incremental
// apply must backfill mentions for that changed hub instead of creating an orphan
// entity that the next dream prunes.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-entity-apply-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { applyEntities, dreamCore } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  db.prepare(`INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq)
    VALUES ('fact:owner','m1','fact','episodic',0.3,'2025-01-01','2026-07-01','2026-07-01','harness-ingest','Alice Example owns the migration checklist.','',1,1)`).run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_weave_seq','1')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','1')").run();

  const applied = await applyEntities(db, [{
    sig: "person:alice-example",
    type: "person",
    forms: ["alice example"],
  }], { asOf: "2026-07-10T00:00:00.000Z" });

  const mentions = db.prepare("SELECT count(*) c FROM edges WHERE src='fact:owner' AND rel='mentions' AND dst='person:alice-example'").get().c;
  if (mentions !== 1) throw new Error("approved entity was not linked to the already-processed fact");
  if (applied.weave.weaved !== 0) throw new Error("test requires scoped hub backfill, not dirty-fact processing");

  dreamCore(db, { "as-of": "2026-07-11T00:00:00.000Z" });
  const hub = db.prepare("SELECT count(*) c FROM nodes WHERE signature='person:alice-example'").get().c;
  if (hub !== 1) throw new Error("linked approved entity was pruned on the next dream");

  console.log("PASS \u2713 approved entity forms backfill mentions in incremental mode");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
