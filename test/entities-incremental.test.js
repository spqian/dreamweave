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
//   4. Mechanical recurrence evidence spans incremental nightly boundaries.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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

  // Night 1 contains one Alice Example mention and must not promote it.
  ins.run("fact:alice-prior", "semantic", 0.5, "2026-06-14", null, "Alice Example confirmed the migration owner.", 1, 1);
  db.close();
  execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "dream.js"),
    "weave", "--as-of", "2026-06-15T00:00:00.000Z",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });
  const db1 = new Database(path.join(dataDir, "memory.db"));
  if (db1.prepare("SELECT count(*) c FROM nodes WHERE signature='person:alice-example'").get().c !== 0) {
    fail("(4) one occurrence incorrectly formed an entity hub on night 1");
  }

  // Night 2 dirties only the second mention. A delta-only extractor sees one
  // occurrence again; the persisted evidence window must combine both nights.
  db1.prepare("INSERT INTO nodes (signature, class, strength, first_seen, notes, fact, kind, ingested_seq, dirty_seq) VALUES (?,?,?,?,?,?, 'fact',?,?)")
    .run("fact:alice-new", "semantic", 0.5, "2026-06-16", null, "Alice Example reported the migration status.", 4, 4);
  db1.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','4')").run();
  db1.close();
  execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "dream.js"),
    "weave", "--as-of", "2026-06-16T00:00:00.000Z",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });
  const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const hub = db2.prepare("SELECT count(*) c FROM nodes WHERE signature='person:alice-example' AND kind='entity'").get().c;
  const mentions = db2.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:alice-example' AND src IN ('fact:alice-prior','fact:alice-new')").get().c;
  if (hub !== 1 || mentions !== 2) fail(`(4) cross-night recurrence did not form and backfill the hub (hub=${hub}, mentions=${mentions})`);

  console.log(ok
    ? "\nPASS \u2713 reportEntities follows dirty_seq, not event-time first_seen"
    : "\nFAILED \u2717 incremental entity-report contract violated");
  db2.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
