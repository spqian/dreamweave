"use strict";

// A newly ingested memory can describe an event from long before the last nightly run.
// first_seen must remain that event date, while dirty_seq makes every incremental stage
// process the newly arrived node.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-processing-seq-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

run("init");

const Database = require("better-sqlite3");
let db = new Database(path.join(dataDir, "memory.db"));
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_weave_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_reflect_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream','2026-07-01T00:00:00.000Z')").run();
db.close();

const snapshot = path.join(dataDir, "snapshot.json");
fs.writeFileSync(snapshot, JSON.stringify([{
  id: "historical-new",
  fact: "Alice Example approved the archived migration decision.",
  category: "decision",
  createdAt: "2025-01-15T00:00:00.000Z",
}]));

run("ingest-harness", "--file", snapshot, "--as-of", "2026-07-10T00:00:00.000Z");

db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const row = db.prepare("SELECT first_seen, ingested_seq, dirty_seq FROM nodes WHERE memory_id='historical-new'").get();
db.close();
if (!row) fail("ingested fact missing");
if (row.first_seen !== "2025-01-15T00:00:00.000Z") fail("first_seen no longer preserves event time");
if (!(row.ingested_seq > 0 && row.dirty_seq === row.ingested_seq)) fail("processing revision not assigned");

const entities = run("report-entities");
const salience = run("report-salience");
const merges = run("report-merges");
if (!entities.facts.some((f) => f.sig === "fact:alice-example-approved-archived-migration")) fail("backdated fact skipped entity report");
if (!salience.facts.some((f) => f.sig === "fact:alice-example-approved-archived-migration")) fail("backdated fact skipped salience report");
if (!Array.isArray(merges.clusters)) fail("merge report failed");

const weave = run("weave", "--as-of", "2026-07-10T00:00:00.000Z");
if (weave.weaved !== 1) fail(`backdated fact was not woven (weaved=${weave.weaved})`);

console.log("PASS \u2713 event time and processing revision are independent");
fs.rmSync(dataDir, { recursive: true, force: true });
