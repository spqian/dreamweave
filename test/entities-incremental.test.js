"use strict";
// Regression + perf-contract: reportEntities must be INCREMENTAL.
//
// Incremental processing is keyed by engine-owned dirty_seq, never event-time first_seen.
// A newly ingested historical memory may have an old first_seen but still needs processing.
//
// Contract asserted here (incremental mode, the default `connections=incremental`):
//   1. Facts dirtied after last_reflect_seq are returned, even with an old event date.
//   2. Facts already covered by the cursor are NOT returned.
//   3. Archived (tier-3) facts are never returned.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "entities-incr-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { reportEntities } = require("../src/dream");
  const tuning = require("../src/tuning");

  if (!tuning.resolve().incrementalWeave) {
    console.error("SKIP: incrementalWeave is off in this environment; gate is a no-op by design");
    process.exit(0);
  }

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);

  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq', '3')").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_reflect_seq', '1')").run();

  const ins = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, notes, fact, kind, ingested_seq, dirty_seq) VALUES (?,?,?,?,?,?, 'fact',?,?)");
  ins.run("fact:processed-1", "semantic", 0.5, "2026-06-15", null, "A fact already processed by the prior reflection.", 1, 1);
  ins.run("fact:backdated-new", "semantic", 0.5, "2025-01-10", null, "A newly ingested historical fact mentioning Acme Corp.", 2, 2);
  ins.run("fact:new-archived", "semantic", 0.5, "2025-01-11", "archive", "A new but archived (tier-3) fact.", 3, 3);

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };

  const sigs = new Set(reportEntities(db).facts.map((f) => f.sig));
  console.log("reported entity-fact sigs:", JSON.stringify([...sigs]));

  if (!sigs.has("fact:backdated-new")) fail("(1) a backdated fact dirtied after the cursor was not reported");
  if (sigs.has("fact:processed-1")) fail("(2) a fact already covered by last_reflect_seq was re-reported");
  if (sigs.has("fact:new-archived")) fail("(3) an archived (tier-3) fact was reported");

  console.log(ok
    ? "\nPASS \u2713 reportEntities follows dirty_seq, not event-time first_seen"
    : "\nFAILED \u2717 incremental entity-report contract violated");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
