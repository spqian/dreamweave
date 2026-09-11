#!/usr/bin/env node
// Adapter: builds a Dreamweave harness-snapshot.json from file-based harness memory.
// INGEST-ONLY: projection display text is not evidence. dreamweave_harness.py
// owns MEMORY.md plus its manifest; this adapter never opens or mutates the DB.
// Content-addressed source IDs intentionally replace unsafe positional legacy IDs.
// Do not reuse IDs from an old snapshot: they may already point at overwritten facts.

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const os = require("os");

const HOME = path.resolve(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"));
const CONFIG_FILE = path.join(HOME, "dreamweave-adapter.json");
const CONFIG = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) : {};
const MEMORY_DIR =
  process.env.HARNESS_MEMORY_DIR ||
  path.join(HOME, "memories");
const DAILY_MEMORY_DIR =
  process.env.HARNESS_DAILY_MEMORY_DIR || CONFIG.daily_dir;
// Plural override is a JSON array of directories (not colon-separated paths).
const DAILY_MEMORY_DIRS = process.env.HARNESS_DAILY_MEMORY_DIRS
  ? JSON.parse(process.env.HARNESS_DAILY_MEMORY_DIRS) : [DAILY_MEMORY_DIR];
if (!Array.isArray(DAILY_MEMORY_DIRS) || !DAILY_MEMORY_DIRS.length ||
    DAILY_MEMORY_DIRS.some((dir) => typeof dir !== "string" || !dir.trim())) {
  throw new Error("HARNESS_DAILY_MEMORY_DIRS must be a nonempty JSON array of directory paths");
}
const OUT = process.argv[2] || path.join(__dirname, "snapshot.json");

const MEMORY_FILE = process.env.HARNESS_MEMORY_FILE || path.join(MEMORY_DIR, "MEMORY.md");
const MANIFEST = process.env.HARNESS_PROJECTION_MANIFEST || `${MEMORY_FILE}.projection.json`;
const projected = new Set();
if (fs.existsSync(MANIFEST)) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  if (!manifest || manifest.version !== 1 || manifest.memory_file !== path.resolve(MEMORY_FILE) ||
      !Array.isArray(manifest.records) || !Array.isArray(manifest.displays) ||
      manifest.records.length !== manifest.displays.length ||
      manifest.records.some((r, i) => !r || typeof r.fact !== "string" ||
        typeof manifest.displays[i] !== "string" || manifest.displays[i] !== (r.display || r.fact))) {
    throw new Error(`Invalid projection manifest: ${MANIFEST}`);
  }
  for (const display of manifest.displays) projected.add(display.trim());
} else {
  console.error(`Projection manifest missing: ${MANIFEST}; raw observations retained, unmatched wrappers skipped`);
  // Bootstrap only from a frozen export supplied by the caller. The dream.js CLI
  // opens/migrates its database even for export-harness; never invoke it here.
  if (process.env.HARNESS_PROJECTION_EXPORT_FILE) {
    const records = JSON.parse(fs.readFileSync(process.env.HARNESS_PROJECTION_EXPORT_FILE, "utf8"));
    if (!Array.isArray(records) || records.some((r) => !r || typeof r.fact !== "string" ||
        (r.display != null && typeof r.display !== "string")))
      throw new Error("Invalid frozen projection export");
    for (const r of records) projected.add((r.display || r.fact).trim());
  }
}

// These are engine presentation markers, never independent evidence. Unknown/edited
// wrappers are quarantined in the source file and flagged, not stripped into a new fact.
const WRAPPER = /^\[(?:(?:SEMANTIC|TEMPORAL) MEMORY(?:\s|·|\])|memory-usage\]|(?:undated|just now|this week|past couple weeks|last month or so|a couple months ago|earlier this period|long ago)\])/;
function keepObservation(chunk, sourceLabel) {
  if (sourceLabel !== "memory-main") return true;
  if (projected.has(chunk)) return false;
  if (WRAPPER.test(chunk)) {
    console.error(`Skipped unmatched projection wrapper in ${MEMORY_FILE}: ${chunk.split("\n")[0]}`);
    return false;
  }
  return true;
}

function readLines(file, sourceLabel, createdAt) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const stat = fs.statSync(file);
  // Once card-delimited, blank lines belong to the observation, not its identity.
  const cards = /^[ \t]*§[ \t]*\r?$/m.test(text) ||
    (sourceLabel === "memory-main" && (process.env.HARNESS_MEMORY_FORMAT || "hermes") === "hermes");
  const chunks = text
    .split(cards ? /^[ \t]*§[ \t]*\r?$/m : /\r?\n\s*\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((chunk) => keepObservation(chunk, sourceLabel));
  return chunks.map((chunk) => ({
    id: `${sourceLabel}:sha256:${createHash("sha256").update(chunk).digest("hex")}`,
    source: sourceLabel,
    fact: chunk,
    category: "context",
    createdAt: createdAt || stat.mtime.toISOString(),
  }));
}

let items = [];
items = items.concat(readLines(MEMORY_FILE, "memory-main"));
items = items.concat(readLines(path.join(MEMORY_DIR, "USER.md"), "user-profile"));

for (const dailyDir of new Set(DAILY_MEMORY_DIRS.map((dir) => path.resolve(dir)))) {
  if (!fs.existsSync(dailyDir)) {
    throw new Error(`Missing explicit daily memory directory: ${dailyDir}`);
  }
  for (const f of fs.readdirSync(dailyDir).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
    const day = f.slice(0, 10);
    const date = new Date(`${day}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) continue;
    items = items.concat(readLines(path.join(dailyDir, f), `daily:${path.join(dailyDir, f)}`, date.toISOString()));
  }
}

fs.writeFileSync(OUT, JSON.stringify(items, null, 2));
console.log(`Wrote ${items.length} snapshot items to ${OUT}`);
