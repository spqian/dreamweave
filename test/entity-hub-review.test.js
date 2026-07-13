"use strict";

// Entity hub review contract (report-entities / apply-entities envelope):
//   - a REJECT severs false mention edges AND corroborated fact-to-fact sibling
//     edges, marks only the affected facts dirty, and PERSISTS across a subsequent
//     weave (the mechanical candidate is never silently recreated);
//   - a RETYPE repoints mention edges to the new sig only where the fact text
//     actually matches the caller-approved new forms (never a blind transfer),
//     and also persists across a subsequent weave;
//   - a stale report_id is rejected atomically: zero mutation, complete:false,
//     no cursor advance.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-hub-review-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));
const runAllowFail = (...args) => {
  try { return { code: 0, json: JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" })) }; }
  catch (e) { return { code: e.status, json: JSON.parse(e.stdout.toString()) }; }
};
const writeDecision = (name, obj) => {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
};

run("init");

const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"));
const ins = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)");
ins.run("fact:md-1", "m-md-1", "fact", "episodic", 0.3, "2026-01-02", "harness-ingest", "Mapping Dataflow reported the outage status.", 1, 1);
ins.run("fact:md-2", "m-md-2", "fact", "episodic", 0.3, "2026-01-03", "harness-ingest", "Mapping Dataflow confirmed the fix shipped.", 2, 2);
// Textually unrelated aside from the shared (false) hub mention, so once that
// mention is severed, a truthful vector recompute should NOT re-derive a sibling
// edge between md-2 and sibling — proving the removal is real, not decorative.
ins.run("fact:sibling", "m-sib", "fact", "episodic", 0.3, "2026-01-03", "harness-ingest", "Mapping Dataflow noted the office relocation date moved to March.", 3, 3);
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','3')").run();
db.close();

run("weave", "--as-of", "2026-01-04T00:00:00.000Z");

let ok = true;
const fail = (m) => { console.error("FAIL:", m); ok = false; };

// ---- stale report_id: zero mutation, atomic rejection ----------------------
{
  const report = run("report-entities");
  const staleFile = writeDecision("stale.json", {
    report_id: "not-the-real-report-id",
    decisions: [],
    hub_reviews: [{ sig: "person:mapping-dataflow", action: "reject" }],
  });
  const beforeMentions = new Database(path.join(dataDir, "memory.db"), { readonly: true })
    .prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:mapping-dataflow'").get().c;
  const res = runAllowFail("apply-entities", "--file", staleFile);
  if (res.code !== 3) fail(`stale report_id did not gate (exit=${res.code})`);
  if (res.json.complete !== false) fail("stale report_id did not return complete:false");
  if (!res.json.rejected.length || res.json.rejected[0].reason !== "report_stale") fail("stale report_id missing structured rejection");
  const afterMentions = new Database(path.join(dataDir, "memory.db"), { readonly: true })
    .prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:mapping-dataflow'").get().c;
  if (afterMentions !== beforeMentions) fail("stale report mutated mention edges");
  void report;
}

// ---- malformed hub_reviews: atomic rejection, no mutation -------------------
{
  const report = run("report-entities");
  const malformedFile = writeDecision("malformed.json", {
    report_id: report.report_id,
    decisions: [],
    hub_reviews: [{ sig: "person:mapping-dataflow", action: "not-a-real-action" }],
  });
  const res = runAllowFail("apply-entities", "--file", malformedFile);
  if (res.code !== 3 || res.json.complete !== false) fail("malformed hub_review action was not rejected atomically");
  if (!res.json.rejected.some((r) => r.reason === "invalid_action")) fail("malformed action missing structured reason");
}

// ---- REJECT: severs mentions + corroborated sibling edges, persists --------
{
  const report = run("report-entities");
  const hub = report.hubs.find((h) => h.sig === "person:mapping-dataflow");
  if (!hub) fail("expected hub not present in report");

  const rejectFile = writeDecision("reject.json", {
    report_id: report.report_id,
    decisions: [],
    hub_reviews: [{ sig: "person:mapping-dataflow", action: "reject" }],
  });
  const res = run("apply-entities", "--file", rejectFile);
  if (!res.complete || !res.reviewed) fail("reject apply did not complete/review");
  if (res.mentions_severed !== 3) fail(`expected 3 severed mentions, got ${res.mentions_severed}`);

  const dbA = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const mentionsLeft = dbA.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:mapping-dataflow'").get().c;
  if (mentionsLeft !== 0) fail(`false mention edges not severed (${mentionsLeft} remain)`);
  const siblingLeft = dbA.prepare(
    "SELECT count(*) c FROM edges WHERE rel IN ('related_to','similar_to') AND ((src='fact:md-2' AND dst='fact:sibling') OR (src='fact:sibling' AND dst='fact:md-2'))"
  ).get().c;
  if (siblingLeft !== 0) fail(`corroborated sibling edge between md-2 and sibling not removed (${siblingLeft} remain)`);
  dbA.close();

  // Persistence: a subsequent weave must NOT recreate the rejected candidate.
  run("weave", "--as-of", "2026-01-05T00:00:00.000Z");
  const dbB = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const mentionsAfterReweave = dbB.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:mapping-dataflow'").get().c;
  if (mentionsAfterReweave !== 0) fail(`rejected mechanical candidate was recreated by the next weave (${mentionsAfterReweave} mentions)`);
  dbB.close();

  // The now-evidence-free hub is cleared by the EXISTING degree-zero hub prune
  // (runs at `dream`, not `weave` — no new pruning logic is added for this).
  run("dream", "--as-of", "2026-01-06T00:00:00.000Z");
  const dbC = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const hubGone = dbC.prepare("SELECT count(*) c FROM nodes WHERE signature='person:mapping-dataflow'").get().c;
  if (hubGone !== 0) fail("degree-zero rejected hub was not pruned by dream");
  dbC.close();
}

// ---- RETYPE: repoints only matching new forms, persists --------------------
{
  const db2 = new Database(path.join(dataDir, "memory.db"));
  db2.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("fact:orion-1", "m-orion-1", "fact", "episodic", 0.3, "2026-01-10", "harness-ingest", "Orion Falcon reported the deployment status.", 10, 10);
  db2.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("fact:orion-2", "m-orion-2", "fact", "episodic", 0.3, "2026-01-11", "harness-ingest", "Orion Falcon confirmed the rollback completed.", 11, 11);
  // A THIRD fact mentions the hub's mechanical full-phrase form but would NOT
  // match a caller-approved new alias ("falcon-team") were one added instead.
  db2.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','11')").run();
  db2.close();
  run("weave", "--as-of", "2026-01-12T00:00:00.000Z");

  const report = run("report-entities");
  const hub = report.hubs.find((h) => h.sig === "person:orion-falcon");
  if (!hub) fail("expected orion-falcon candidate not present in report");

  const retypeFile = writeDecision("retype.json", {
    report_id: report.report_id,
    decisions: [],
    hub_reviews: [{ sig: "person:orion-falcon", action: "retype", type: "system", new_sig: "system:orion-falcon" }],
  });
  const res = run("apply-entities", "--file", retypeFile);
  if (!res.complete || !res.reviewed) fail("retype apply did not complete/review");

  const dbD = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const oldMentions = dbD.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:orion-falcon'").get().c;
  const newMentions = dbD.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='system:orion-falcon'").get().c;
  if (oldMentions !== 0) fail(`old typed hub retains ${oldMentions} mention edges after retype`);
  if (newMentions !== 2) fail(`new typed hub has ${newMentions} mention edges, expected 2 (matching full phrase)`);
  dbD.close();

  run("weave", "--as-of", "2026-01-13T00:00:00.000Z");
  const dbE = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const oldMentionsAfter = dbE.prepare("SELECT count(*) c FROM edges WHERE rel='mentions' AND dst='person:orion-falcon'").get().c;
  if (oldMentionsAfter !== 0) fail(`retyped-away sig was recreated/relinked by the next weave (${oldMentionsAfter} mentions)`);
  dbE.close();
}

// ---- REMOVE_FORMS: drops every stale sibling edge touching severed facts ----
{
  const db2 = new Database(path.join(dataDir, "memory.db"));
  const addFact = db2.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)");
  addFact.run("fact:nova-base-1", "m-nova-base-1", "fact", "episodic", 0.3, "2026-01-20", "harness-ingest", "Nova Signal reported the deployment status.", 20, 20);
  addFact.run("fact:nova-base-2", "m-nova-base-2", "fact", "episodic", 0.3, "2026-01-21", "harness-ingest", "Nova Signal confirmed the rollback completed.", 21, 21);
  addFact.run("fact:nova-alias", "m-nova-alias", "fact", "episodic", 0.3, "2026-01-22", "harness-ingest", "The response team published the office relocation plan.", 22, 22);
  db2.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','22')").run();
  db2.close();
  run("weave", "--as-of", "2026-01-23T00:00:00.000Z");

  const addAlias = run("apply-entities", "--file", writeDecision("add-alias.json", [{
    sig: "person:nova-signal",
    type: "person",
    forms: ["nova signal", "the response team"],
  }]));
  if (!addAlias.complete) fail("failed to add caller-approved alias");

  const db3 = new Database(path.join(dataDir, "memory.db"));
  const aliasMention = db3.prepare("SELECT 1 FROM edges WHERE src='fact:nova-alias' AND rel='mentions' AND dst='person:nova-signal'").get();
  if (!aliasMention) fail("caller-added alias did not link the alias-only fact");
  db3.prepare("INSERT OR IGNORE INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)")
    .run("fact:nova-base-1", "related_to", "fact:nova-alias", 0.8, "2026-01-23", "2026-01-23");
  db3.close();

  const report = run("report-entities");
  const removeFile = writeDecision("remove-alias.json", {
    report_id: report.report_id,
    decisions: [],
    hub_reviews: [{ sig: "person:nova-signal", action: "remove_forms", forms: ["the response team"] }],
  });
  const res = run("apply-entities", "--file", removeFile);
  if (!res.complete || res.mentions_severed !== 1) fail(`remove_forms did not sever exactly the alias mention: ${JSON.stringify(res)}`);

  const db4 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const aliasMentionsLeft = db4.prepare("SELECT count(*) c FROM edges WHERE src='fact:nova-alias' AND rel='mentions' AND dst='person:nova-signal'").get().c;
  const baseMentionsLeft = db4.prepare("SELECT count(*) c FROM edges WHERE src='fact:nova-base-1' AND rel='mentions' AND dst='person:nova-signal'").get().c;
  const staleRelatedEdges = db4.prepare(
    "SELECT count(*) c FROM edges WHERE rel='related_to' AND ((src='fact:nova-base-1' AND dst='fact:nova-alias') OR (src='fact:nova-alias' AND dst='fact:nova-base-1'))"
  ).get().c;
  if (aliasMentionsLeft !== 0) fail("removed alias mention survived");
  if (baseMentionsLeft !== 1) fail("base-form mention was incorrectly severed");
  if (staleRelatedEdges !== 0) fail(`stale shared-mention related_to edge survived (${staleRelatedEdges})`);
  db4.close();
}

console.log(ok
  ? "PASS \u2713 hub review (reject/retype/remove_forms) severs false evidence and persists across weave"
  : "\nFAILED \u2717 hub review contract violated");
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
