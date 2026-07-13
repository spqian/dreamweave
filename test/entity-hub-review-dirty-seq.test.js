"use strict";

// Regression for the reviewed hub-review bug: affected facts (mention edges
// severed/repointed by a reject/retype/remove_forms hub review) must be stamped
// with a BRAND-NEW dirty revision via nextChangeSeq(db), never maxDirtySeq(db) /
// currentChangeSeq(db) as-is.
//
// In the (common) STEADY STATE — no other pending dirty work — maxDirtySeq(db)
// already EQUALS the persisted `last_weave_seq` cursor left by the prior weave.
// Stamping an affected fact's dirty_seq at that SAME value makes it indistinguishable
// from "already woven" to the incremental-weave cursor comparison (`dirty_seq >
// lastWeaveSeq`), so the scoped reweave applyEntities triggers would silently skip
// re-deriving that fact's mention/sibling edges — the exact bug this test guards.
//
// This test:
//   1. reaches steady state (last_weave_seq == maxDirtySeq(db), no pending dirty work);
//   2. rejects a mechanical hub via apply-entities;
//   3. asserts the apply result's weave.weaved > 0 (the scoped reweave actually
//      processed the affected facts, not zero);
//   4. asserts the affected facts' dirty_seq is now STRICTLY GREATER than the
//      steady-state last_weave_seq captured before the apply call;
//   5. asserts sibling connectivity is genuinely RECOMPUTED: the two affected
//      facts are near-duplicate sentences (high real vector similarity) besides
//      sharing the (false) hub mention, so once the false corroboration is
//      severed, a truthful similar_to/related_to edge should reappear between them
//      after the scoped reweave — proving the sibling-linking step actually ran for
//      them (with the bug, they would have been skipped entirely, leaving zero
//      sibling edges).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-hub-review-seq-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));
const writeDecision = (name, obj) => {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};

run("init");

const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"));
const ins = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)");
// Near-duplicate sentences (high real vector similarity) that ALSO both name the
// same mechanical (false) hub candidate — the hub-based corroboration and the
// genuine semantic similarity are two INDEPENDENT signals, so we can tell which
// one produced any sibling edge left after the reject.
ins.run("fact:md-1", "m-md-1", "fact", "episodic", 0.3, "2026-01-02", "harness-ingest", "Mapping Dataflow reported the checkout payment gateway outage status.", 1, 1);
ins.run("fact:md-2", "m-md-2", "fact", "episodic", 0.3, "2026-01-03", "harness-ingest", "Mapping Dataflow reported the checkout payment gateway outage status again.", 2, 2);
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','2')").run();
db.close();

run("weave", "--as-of", "2026-01-04T00:00:00.000Z");

let ok = true;
const fail = (m) => { console.error("FAIL:", m); ok = false; };

// ---- reach + verify STEADY STATE (last_weave_seq == maxDirtySeq(db)) ---------
const metaRow = (key) => {
  const d = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const r = d.prepare("SELECT value FROM meta WHERE key=?").get(key);
  d.close();
  return r ? Number(r.value) : 0;
};
const maxDirtySeqNow = () => {
  const d = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const r = d.prepare("SELECT COALESCE(MAX(dirty_seq),0) m FROM nodes").get();
  d.close();
  return Math.max(metaRow("change_seq"), Number(r && r.m) || 0);
};
const priorLastWeaveSeq = metaRow("last_weave_seq");
if (priorLastWeaveSeq !== maxDirtySeqNow()) {
  fail(`test precondition failed: not at steady state (last_weave_seq=${priorLastWeaveSeq}, maxDirtySeq=${maxDirtySeqNow()})`);
}

const report = run("report-entities");
const hub = report.hubs.find((h) => h.sig === "person:mapping-dataflow");
if (!hub) fail("expected mechanical 'Mapping Dataflow' candidate not present in report");

const rejectFile = writeDecision("reject.json", {
  report_id: report.report_id,
  decisions: [],
  hub_reviews: [{ sig: "person:mapping-dataflow", action: "reject" }],
});
const res = run("apply-entities", "--file", rejectFile);

if (!res.complete || !res.reviewed) fail("reject apply did not complete/review");
if (!res.weave || !(res.weave.weaved > 0)) fail(`expected weave.weaved > 0 (scoped reweave must process affected facts), got ${JSON.stringify(res.weave)}`);

const dbA = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const md1 = dbA.prepare("SELECT dirty_seq FROM nodes WHERE signature='fact:md-1'").get();
const md2 = dbA.prepare("SELECT dirty_seq FROM nodes WHERE signature='fact:md-2'").get();
if (!(Number(md1.dirty_seq) > priorLastWeaveSeq)) fail(`fact:md-1 dirty_seq (${md1.dirty_seq}) is not > prior last_weave_seq (${priorLastWeaveSeq})`);
if (!(Number(md2.dirty_seq) > priorLastWeaveSeq)) fail(`fact:md-2 dirty_seq (${md2.dirty_seq}) is not > prior last_weave_seq (${priorLastWeaveSeq})`);

const mentionsLeft = dbA.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:mapping-dataflow'").get().c;
if (mentionsLeft !== 0) fail(`false mention edges not severed (${mentionsLeft} remain)`);

// Valid sibling connectivity RECOMPUTED: real semantic similarity between the two
// near-duplicate facts must have produced a fresh related_to/similar_to edge — this
// can only happen if the scoped reweave's sibling-linking step actually ran for
// them (which requires their dirty_seq fix above to be correct).
const siblingEdges = dbA.prepare(
  "SELECT count(*) c FROM edges WHERE rel IN ('related_to','similar_to') AND ((src='fact:md-1' AND dst='fact:md-2') OR (src='fact:md-2' AND dst='fact:md-1'))"
).get().c;
if (siblingEdges === 0) fail("valid sibling connectivity was not recomputed after the false hub corroboration was severed");

const newLastWeaveSeq = metaRow("last_weave_seq");
if (!(newLastWeaveSeq > priorLastWeaveSeq)) fail(`last_weave_seq cursor did not advance (prior=${priorLastWeaveSeq}, new=${newLastWeaveSeq})`);
dbA.close();

console.log(ok
  ? "PASS \u2713 hub-review reject stamps a NEW dirty revision and the scoped reweave recomputes affected facts"
  : "\nFAILED \u2717 hub-review dirty-seq contract violated");
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
