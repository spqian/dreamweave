"use strict";
// Regression + perf-contract: reportEntities must be INCREMENTAL.
//
// Before this fix, reportEntities emitted the ENTIRE active store every night, fanning out to
// ~O(store) LLM entity-extraction calls per checkpoint (the largest single LLM cost as the bank
// grew). Entity hubs for OLD facts were already extracted the night they arrived, so only facts new
// since last_reflect need extraction — mirroring reportSalience's `first_seen > last_reflect` gate.
//
// Contract asserted here (incremental mode, the default `connections=incremental`):
//   1. Facts newer than last_reflect are returned.
//   2. Facts older than last_reflect are NOT returned (already extracted on a prior night).
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

  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_reflect', ?)").run("2026-03-01T00:00:00.000Z");

  const ins = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, notes, fact, kind) VALUES (?,?,?,?,?,?, 'fact')");
  ins.run("fact:old-1", "semantic", 0.5, "2026-01-15", null, "An old fact ingested before the last reflect.");
  ins.run("fact:new-1", "semantic", 0.5, "2026-04-10", null, "A new fact ingested after the last reflect, mentioning Acme Corp.");
  ins.run("fact:new-archived", "semantic", 0.5, "2026-04-11", "archive", "A new but archived (tier-3) fact.");

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };

  const sigs = new Set(reportEntities(db).facts.map((f) => f.sig));
  console.log("reported entity-fact sigs:", JSON.stringify([...sigs]));

  if (!sigs.has("fact:new-1")) fail("(1) a fact newer than last_reflect was not reported for entity extraction");
  if (sigs.has("fact:old-1")) fail("(2) a fact older than last_reflect was re-reported (should have been extracted on a prior night)");
  if (sigs.has("fact:new-archived")) fail("(3) an archived (tier-3) fact was reported");

  console.log(ok
    ? "\nPASS \u2713 reportEntities only surfaces new, non-archived facts (incremental extraction)"
    : "\nFAILED \u2717 incremental entity-report contract violated");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
