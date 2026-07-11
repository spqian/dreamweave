"use strict";

// Dream mutations, journal writes, and processing cursors must commit atomically.
// A failed run leaves no partial decay; a successful retry commits once; repeating
// the completed run ID is a no-op.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-dream-atomicity-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(() => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { dreamCore } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  db.prepare(`INSERT INTO nodes(signature,memory_id,kind,class,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,ingested_seq,dirty_seq)
    VALUES ('fact:atomic','m1','fact','semantic',0.8,0,'2026-01-01','2026-01-01','2026-01-01','harness-ingest','Atomic dream test fact.',1,1)`).run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','0')").run();

  const before = db.prepare("SELECT strength,reactivations,last_decayed FROM nodes WHERE signature='fact:atomic'").get();
  db.exec(`
    CREATE TRIGGER fail_dream_journal
    BEFORE INSERT ON dream_journal
    BEGIN
      SELECT RAISE(ABORT, 'injected journal failure');
    END
  `);

  let failed = false;
  try {
    dreamCore(db, { "as-of": "2026-07-10T00:00:00.000Z", "run-id": "atomic-run" });
  } catch (e) {
    failed = /injected journal failure/.test(String(e.message));
  }
  if (!failed) throw new Error("injected dream failure did not surface");

  const afterFailure = db.prepare("SELECT strength,reactivations,last_decayed FROM nodes WHERE signature='fact:atomic'").get();
  if (JSON.stringify(afterFailure) !== JSON.stringify(before)) throw new Error("failed dream left partial node mutations");
  if (db.prepare("SELECT value FROM meta WHERE key='last_dream'").get()) throw new Error("failed dream advanced last_dream");
  if (db.prepare("SELECT value FROM meta WHERE key='last_completed_dream_run'").get()) throw new Error("failed dream recorded completion");

  db.exec("DROP TRIGGER fail_dream_journal");
  const committed = dreamCore(db, { "as-of": "2026-07-10T00:00:00.000Z", "run-id": "atomic-run" });
  if (committed.skipped) throw new Error("first successful retry was skipped");
  const once = db.prepare("SELECT strength,reactivations,last_decayed FROM nodes WHERE signature='fact:atomic'").get();

  const repeated = dreamCore(db, { "as-of": "2026-07-10T00:00:00.000Z", "run-id": "atomic-run" });
  const twice = db.prepare("SELECT strength,reactivations,last_decayed FROM nodes WHERE signature='fact:atomic'").get();
  if (!repeated.skipped) throw new Error("completed run ID was not idempotent");
  if (JSON.stringify(twice) !== JSON.stringify(once)) throw new Error("completed run was applied twice");

  console.log("PASS \u2713 dream is atomic and completed run IDs are idempotent");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})();
