"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chronicle-delete-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");

let db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);
db.prepare(`
  INSERT INTO nodes(signature,memory_id,kind,class,first_seen,source_day,notes,fact,text)
  VALUES ('fact:delete-me','memory-delete-me','fact','episodic','2026-01-07','2026-01-07','harness-ingest','Delete me','Delete me')
`).run();
db.prepare(`
  INSERT INTO nodes(signature,memory_id,kind,class,first_seen,notes,fact,text)
  VALUES ('chronicle:day:2026-01-07:v1','','chronicle','semantic','2026-01-07','chronicle','Day summary','Day summary')
`).run();
db.prepare(`
  INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,covered_event_count,created_at)
  VALUES ('chronicle:day:2026-01-07:v1','day','2026-01-07','2026-01-07',1,1,'2026-01-07')
`).run();
db.prepare(`
  INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind)
  VALUES ('chronicle:day:2026-01-07:v1',0,'2026-01-07','Delete me','continuity')
`).run();
db.prepare(`
  INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig)
  VALUES ('chronicle:day:2026-01-07:v1',0,'fact:delete-me')
`).run();
db.close();

const emptyHarness = path.join(dataDir, "empty.json");
fs.writeFileSync(emptyHarness, "[]", "utf8");
execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "ingest-harness",
  "--file", emptyHarness,
  "--prune", "true",
  "--as-of", "2026-01-08",
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });

db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
if (db.prepare("SELECT 1 FROM nodes WHERE signature IN ('fact:delete-me','chronicle:day:2026-01-07:v1')").get()) {
  throw new Error("pruning evidence did not remove its dependent chronicle");
}
for (const table of ["chronicles", "chronicle_entries", "chronicle_evidence", "chronicle_entry_entities"]) {
  if (db.prepare(`SELECT count(*) c FROM ${table}`).get().c !== 0) {
    throw new Error(`pruning evidence left stale rows in ${table}`);
  }
}
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: deleting evidence removes dependent chronicles atomically");
