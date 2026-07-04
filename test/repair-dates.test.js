"use strict";
// Verifies `repair-dates`: re-anchors first_seen to the earliest explicit date
// found in each fact's TEXT — the rescue path when createdAt has been laundered
// to "today" (host rebuild). Covers extractor edge cases, earlier-only default,
// --allow-later, and --dry-run.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { earliestTextDate } = require("../src/timeline");

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }
function eq(actual, expected, label) { if (actual !== expected) fail(`${label}: expected ${expected}, got ${actual}`); }

// ---- extractor unit checks -------------------------------------------------
eq(earliestTextDate("Series C raised 2026-06-26T18:15:02Z at $1.2B."), "2026-06-26T18:15:02.000Z", "iso datetime Z");
eq(earliestTextDate("Question answered on 2026-07-01."), new Date("2026-07-01").toISOString(), "bare YYYY-MM-DD");
// earliest of several wins
eq(earliestTextDate("On 2026-07-03 we revisited the 2026-06-15 incident and the 2026-06-29 wave."), new Date("2026-06-15").toISOString(), "earliest of many");
// no false positives on money ranges / versions / bare years
eq(earliestTextDate("EV range $620-760M, leverage 2.8x, plan for 2026."), null, "no false positive");
eq(earliestTextDate("Invalid 2026-13-40 date and v1.2.3."), null, "reject invalid month/day");
eq(earliestTextDate(""), null, "empty");
console.log("PASS: earliestTextDate extractor");

// ---- subcommand integration ------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-dates-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

// Ingest a snapshot whose createdAt is uniformly "today" (the laundered state),
// while the fact text carries the true earlier event dates.
const today = new Date().toISOString();
const snapshot = [
  { id: "r-1", fact: "Series C was raised 2026-06-26T18:15:02Z at a $1.2B valuation.", category: "context", createdAt: today },
  { id: "r-2", fact: "Board approved the reorg on 2026-07-01.", category: "decision", createdAt: today },
  { id: "r-3", fact: "A memory with no date at all in its text.", category: "fact", createdAt: today },
];
const snapPath = path.join(dataDir, "snapshot.json");
fs.writeFileSync(snapPath, JSON.stringify(snapshot));
execFileSync(process.execPath, [path.join(__dirname, "..", "src", "dream.js"), "ingest-harness", "--file", snapPath],
  { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, stdio: "ignore" });

function runRepair(extra) {
  const out = execFileSync(process.execPath, [path.join(__dirname, "..", "src", "dream.js"), "repair-dates", ...extra],
    { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });
  return JSON.parse(out);
}
function firstSeen(memId) {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const r = db.prepare("SELECT first_seen FROM nodes WHERE memory_id=?").get(memId);
  db.close();
  return r && r.first_seen;
}

// dry-run must not write
const dry = runRepair(["--dry-run"]);
if (dry.updated !== 2) fail(`dry-run updated expected 2, got ${dry.updated}`);
if (firstSeen("r-1") !== today) fail("dry-run must not modify the db");
console.log("PASS: repair-dates --dry-run reports without writing");

// real run: r-1 and r-2 move earlier to their text dates; r-3 (no text date) stays today
const real = runRepair([]);
if (real.updated !== 2) fail(`repair updated expected 2, got ${real.updated}`);
eq(firstSeen("r-1"), "2026-06-26T18:15:02.000Z", "r-1 anchored to text date");
eq(firstSeen("r-2"), new Date("2026-07-01").toISOString(), "r-2 anchored to text date");
eq(firstSeen("r-3"), today, "r-3 (no text date) unchanged");
console.log("PASS: repair-dates anchors first_seen to earliest text date, earlier-only");

// idempotent second run
const again = runRepair([]);
if (again.updated !== 0) fail(`second repair should be a no-op, updated=${again.updated}`);
console.log("PASS: repair-dates is idempotent");
