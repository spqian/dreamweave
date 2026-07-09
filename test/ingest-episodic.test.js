"use strict";
// Verifies the ingest surface may NOT assert memory class: EVERY harness memory
// ingests as class='episodic' (initial strength 0.30) regardless of its `category`.
// The higher classes are engine-owned — semantic is earned via reactivation and
// salient ONLY via the dream's salience judgment. The harness `category` is retained
// in the `salience` column as a display label but must never set the class.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-episodic-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

const snapshot = [
  { id: "m-dec", fact: "Board approved the Condor acquisition at $650M.", category: "decision" },
  { id: "m-fact", fact: "Peter is the CEO and reports to the board.", category: "fact" },
  { id: "m-ctx", fact: "Standup moved to 9:30am on 2026-07-08.", category: "context" },
  { id: "m-pref", fact: "Peter prefers bottom-line-first summaries.", category: "preference" },
  { id: "m-none", fact: "A memory with no category at all." },
];
const snapPath = path.join(dataDir, "snapshot.json");
fs.writeFileSync(snapPath, JSON.stringify(snapshot));

execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "ingest-harness", "--file", snapPath,
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, stdio: "inherit" });

const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const rows = {};
for (const r of db.prepare("SELECT memory_id, class, salience, strength FROM nodes WHERE kind='fact'").all()) {
  rows[r.memory_id] = r;
}
db.close();

// Every category — including 'decision' and 'fact' — must ingest as episodic.
for (const id of ["m-dec", "m-fact", "m-ctx", "m-pref", "m-none"]) {
  const r = rows[id];
  if (!r) fail(`${id} was not ingested`);
  if (r.class !== "episodic") fail(`${id} class expected 'episodic', got '${r.class}'`);
  if (Math.abs(r.strength - 0.30) > 1e-9) fail(`${id} strength expected 0.30 (episodic INIT), got ${r.strength}`);
}

// The harness category is retained as a display label in the `salience` column.
if (rows["m-dec"].salience !== "decision") fail(`m-dec salience label expected 'decision', got '${rows["m-dec"].salience}'`);
if (rows["m-fact"].salience !== "fact") fail(`m-fact salience label expected 'fact', got '${rows["m-fact"].salience}'`);

console.log("PASS: all harness categories ingest as class=episodic; category retained as display label");
