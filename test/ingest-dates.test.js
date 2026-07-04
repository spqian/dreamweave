"use strict";
// Verifies ingest-harness anchors first_seen to each memory's real `createdAt`
// (event date), NOT the ingest-run clock — falling back to now only when the
// date is absent/unparseable. Regression guard for the "everything reads
// [just now]" bug where first_seen collapsed onto the ingest date.
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
for (const r of db.prepare("SELECT memory_id, first_seen FROM nodes WHERE kind='fact'").all()) {
  rows[r.memory_id] = r.first_seen;
}
db.close();

// Event-anchored: first_seen === the memory's createdAt (normalized to ISO).
const expectOld = new Date("2026-06-26T10:05:20.222Z").toISOString();
const expectMid = new Date("2026-07-01T09:00:00.000Z").toISOString();
if (rows["m-old"] !== expectOld) fail(`m-old first_seen expected ${expectOld}, got ${rows["m-old"]}`);
if (rows["m-mid"] !== expectMid) fail(`m-mid first_seen expected ${expectMid}, got ${rows["m-mid"]}`);

// Fallback: absent/unparseable createdAt -> ingest clock (now, within the run window).
for (const id of ["m-nodate", "m-baddate"]) {
  const t = Date.parse(rows[id] || "");
  if (!t) fail(`${id} first_seen not a valid date: ${rows[id]}`);
  if (t < before - 5000 || t > after + 5000) fail(`${id} first_seen ${rows[id]} not within the ingest window (expected ~now)`);
}

console.log("PASS: ingest-harness anchors first_seen to createdAt, falls back to now");

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
for (const r of db2.prepare("SELECT memory_id, first_seen FROM nodes WHERE kind='fact'").all()) rows2[r.memory_id] = r.first_seen;
db2.close();

const expectOld2 = new Date("2026-06-20T00:00:00.000Z").toISOString();
if (rows2["m-old"] !== expectOld2) fail(`backfill: m-old expected earlier ${expectOld2}, got ${rows2["m-old"]}`);
if (rows2["m-mid"] !== expectMid) fail(`backfill: m-mid must NOT move later — expected ${expectMid}, got ${rows2["m-mid"]}`);

console.log("PASS: --backfill-dates moves first_seen earlier only");

