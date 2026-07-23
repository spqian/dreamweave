"use strict";
// Verifies ingest-harness stores narrow day-level source provenance from each
// memory's real `createdAt`, falling back to the ingest day only when absent.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-dates-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

const snapshot = [
  { id: "m-old", fact: "Series C was raised on 2026-06-26 at a $1.2B valuation.", category: "context", createdAt: "2026-06-26T10:05:20.222Z" },
  { id: "m-mid", fact: "Board approved the reorg plan.", category: "decision", createdAt: "2026-07-01T09:00:00.000Z" },
  { id: "m-nodate", fact: "A memory with no creation date at all.", category: "fact" },
  { id: "m-baddate", fact: "A memory with an unparseable creation date.", category: "fact", createdAt: "not-a-date" },
];
const snapPath = path.join(dataDir, "snapshot.json");
fs.writeFileSync(snapPath, JSON.stringify(snapshot));

const before = Date.now();
execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "ingest-harness", "--file", snapPath,
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, stdio: "inherit" });
const after = Date.now();

const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const rows = {};
for (const r of db.prepare("SELECT memory_id, source_day FROM nodes WHERE kind='fact'").all()) {
  rows[r.memory_id] = r.source_day;
}
db.close();

const expectOld = "2026-06-26";
const expectMid = "2026-07-01";
if (rows["m-old"] !== expectOld) fail(`m-old source_day expected ${expectOld}, got ${rows["m-old"]}`);
if (rows["m-mid"] !== expectMid) fail(`m-mid source_day expected ${expectMid}, got ${rows["m-mid"]}`);

// Fallback: absent/unparseable createdAt -> ingest clock (now, within the run window).
for (const id of ["m-nodate", "m-baddate"]) {
  const expectedDays = new Set([new Date(before).toISOString().slice(0, 10), new Date(after).toISOString().slice(0, 10)]);
  if (!expectedDays.has(rows[id])) fail(`${id} source_day ${rows[id]} not within the ingest window`);
}

console.log("PASS: ingest-harness anchors source_day to createdAt, falls back to today");

// ---- --backfill-dates: re-anchor existing nodes, earlier-only -------------
// Re-ingest m-old with an EARLIER createdAt and m-mid with a LATER one, plus
// backfill on: m-old should move earlier, m-mid must NOT move later.
const snap2 = [
  { id: "m-old", fact: "Series C was raised on 2026-06-26 at a $1.2B valuation.", category: "context", createdAt: "2026-06-20T00:00:00.000Z" },
  { id: "m-mid", fact: "Board approved the reorg plan.", category: "decision", createdAt: "2026-07-10T00:00:00.000Z" },
];
fs.writeFileSync(snapPath, JSON.stringify(snap2));
execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "ingest-harness", "--file", snapPath, "--backfill-dates",
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, stdio: "inherit" });

const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const rows2 = {};
for (const r of db2.prepare("SELECT memory_id, source_day FROM nodes WHERE kind='fact'").all()) rows2[r.memory_id] = r.source_day;
db2.close();

const expectOld2 = "2026-06-20";
if (rows2["m-old"] !== expectOld2) fail(`backfill: m-old expected earlier ${expectOld2}, got ${rows2["m-old"]}`);
if (rows2["m-mid"] !== expectMid) fail(`backfill: m-mid must NOT move later — expected ${expectMid}, got ${rows2["m-mid"]}`);

console.log("PASS: --backfill-dates moves source_day earlier only");
