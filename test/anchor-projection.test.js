"use strict";
// The engine-owned "memory-usage" anchor (channel E) must ROUND-TRIP through projection
// so the nightly projection-sync KEEPs it instead of FORGETting it:
//   1. export-harness always leads with the anchor record (signature memory-usage-anchor).
//   2. On a fresh store its memory_id is "" -> the host ADD path m_remember's it.
//   3. record-projection with the anchor pair persists the assigned harness id in `meta`.
//   4. Subsequent export-harness emits that real id -> it is in exportedIds -> KEEP (not FORGET).
// Regression guard: previously the anchor emitted a synthetic id that never matched its real
// harness id, so the FORGET step deleted it every full reconcile and it silently dropped off.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anchor-projection-test-"));
const DREAM = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }
function run(...args) {
  return execFileSync(process.execPath, [DREAM, ...args], { env, encoding: "utf8" });
}
function exportHarness() {
  return JSON.parse(run("export-harness"));
}

run("init");

// 1 + 2: fresh store -> anchor leads with a blank memory_id (needs projecting).
let p = exportHarness();
if (!Array.isArray(p) || p.length < 1) fail("export-harness returned no records");
if (p[0].signature !== "memory-usage-anchor") fail("first record is not the anchor: " + JSON.stringify(p[0].signature));
if (p[0].memory_id !== "") fail("fresh anchor memory_id should be '' (ADD path), got: " + JSON.stringify(p[0].memory_id));
if (p[0].tier !== "gist") fail("anchor tier should be gist");
if (!/graph_recall/.test(p[0].fact)) fail("anchor fact should instruct graph_recall");

// 3: simulate the host ADD -> record the assigned harness id.
const assignedId = "harness-anchor-" + Date.now();
const projPath = path.join(dataDir, "proj.json");
fs.writeFileSync(projPath, JSON.stringify([{ signature: "memory-usage-anchor", memory_id: assignedId }]));
run("record-projection", "--file", projPath);

// 4: the anchor now round-trips with its real id -> projection-sync will KEEP it.
p = exportHarness();
if (p[0].signature !== "memory-usage-anchor") fail("anchor no longer leads after record-projection");
if (p[0].memory_id !== assignedId) fail("anchor memory_id did not persist; expected " + assignedId + " got " + JSON.stringify(p[0].memory_id));

// The anchor is synthesized, NOT a nodes row (it must not pollute the graph/consolidation).
const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const nodeRow = db.prepare("SELECT count(*) c FROM nodes WHERE signature='memory-usage-anchor'").get();
db.close();
if (nodeRow.c !== 0) fail("anchor must not be a nodes row (found " + nodeRow.c + ")");

console.log("ok: anchor leads export-harness with blank id on fresh store");
console.log("ok: record-projection persists anchor harness id to meta");
console.log("ok: anchor round-trips with its real id (KEEP, not FORGET)");
console.log("ok: anchor is synthesized, not a nodes row");

// ---- ingest recognition: the anchor text in the harness must NOT become a node, and its
// harness id must be captured into meta so it round-trips to that id (KEEP, no duplicate). ----
const ANCHOR_FACT = p[0].fact; // the exact engine anchor text
const snap = [
  { id: "u-1", fact: "Peter prefers concise summaries.", category: "preference" },
  { id: "anchor-harness-id", fact: ANCHOR_FACT, category: "context" },
];
const snapPath = path.join(dataDir, "snap.json");
fs.writeFileSync(snapPath, JSON.stringify(snap));
run("ingest-harness", "--file", snapPath);

const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const anchorNodes = db2.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND fact LIKE '[memory-usage]%'").get();
const userNodes = db2.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND fact LIKE 'Peter prefers%'").get();
db2.close();
if (anchorNodes.c !== 0) fail("anchor text must not be ingested as a node (found " + anchorNodes.c + ")");
if (userNodes.c !== 1) fail("normal memory should ingest as a node (found " + userNodes.c + ")");

// export-harness now emits the anchor with the captured harness id -> projection-sync KEEPs it.
p = exportHarness();
if (p[0].signature !== "memory-usage-anchor") fail("anchor no longer leads after ingest");
if (p[0].memory_id !== "anchor-harness-id") fail("ingest did not capture anchor harness id into meta; got " + JSON.stringify(p[0].memory_id));

console.log("ok: anchor text in harness is recognized on ingest (no node created)");
console.log("ok: ingest captures the anchor's harness id -> round-trips to it (KEEP)");
console.log("PASS \u2713 anchor projection round-trip");

fs.rmSync(dataDir, { recursive: true, force: true });
