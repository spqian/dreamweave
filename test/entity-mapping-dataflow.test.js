"use strict";

// Mapping Dataflow fix regression: a mechanically-detected multi-token person
// candidate must default to FULL-PHRASE-ONLY matching. Splitting the label into
// single-token forms ("mapping", "dataflow") would let 37 UNRELATED facts that
// merely use those as ordinary lowercase words become false co-mentions of the
// hub — a huge, hard-to-reverse blast radius ("magnet"). This test builds exactly
// that trap: 37 unrelated facts using "mapping"/"dataflow" as common words, plus
// two recurring facts that name "Mapping Dataflow" as a subject via a
// high-precision syntactic frame (bypassing the corpus's wide-net casing gate).
// After weave, the resulting hub must mention ONLY the two facts that actually
// contain the full phrase — never the 37 unrelated ones.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-mapping-dataflow-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));

run("init");

const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"));
const ins = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)");
for (let i = 0; i < 37; i += 1) {
  ins.run(`fact:unrelated-${i}`, `m-u-${i}`, "fact", "episodic", 0.3, "2026-01-01",
    "harness-ingest", `The mapping was applied to every dataflow config number ${i} last night.`, i + 1, i + 1);
}
ins.run("fact:md-1", "m-md-1", "fact", "episodic", 0.3, "2026-01-02", "harness-ingest", "Mapping Dataflow reported the outage status.", 38, 38);
ins.run("fact:md-2", "m-md-2", "fact", "episodic", 0.3, "2026-01-03", "harness-ingest", "Mapping Dataflow confirmed the fix shipped.", 39, 39);
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','39')").run();
db.close();

run("weave", "--as-of", "2026-01-04T00:00:00.000Z");

const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const hub = db2.prepare("SELECT signature, text FROM nodes WHERE kind='entity' AND signature LIKE 'person:mapping%'").get();
if (!hub) throw new Error("recurring 'Mapping Dataflow' candidate did not earn a hub");
if (hub.text !== "mapping dataflow") throw new Error(`expected full-phrase-only forms, got "${hub.text}"`);

const mentionCount = db2.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst=?").get(hub.signature).c;
if (mentionCount !== 2) throw new Error(`expected exactly 2 mentions (the recurring facts), got ${mentionCount} (magnet regression)`);

const falseMentions = db2.prepare(
  "SELECT count(*) c FROM edges WHERE rel='mentions' AND dst=? AND src LIKE 'fact:unrelated-%'"
).get(hub.signature).c;
if (falseMentions !== 0) throw new Error(`${falseMentions} unrelated facts falsely linked to the hub (magnet regression)`);
db2.close();

console.log("PASS \u2713 Mapping Dataflow candidate matches only the full phrase, no 37-fact magnet");
fs.rmSync(dataDir, { recursive: true, force: true });
