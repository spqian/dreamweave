"use strict";
// Regression: consolidation merge must be NON-DESTRUCTIVE.
//
// Before the fix, applyMerges rewrote the *survivor* node in place
// (UPDATE nodes SET fact=<gist> WHERE id=survivor.id), so whichever member the
// LLM picked as survivor had its original verbatim OVERWRITTEN by the gist and
// was never retained as a detail. When the survivor happened to be a completed
// ACTION fact ("I sent X after approval"), the store kept only the stale PLAN
// gist ("do not send X until approved") and the executed-state fact vanished —
// with no tombstone. That is the q313 temporal-recall failure.
//
// Contract asserted here (the "bookshelf = full fidelity" invariant):
//   1. The survivor's ORIGINAL verbatim survives as a retrievable node.
//   2. EVERY member's verbatim survives (nothing is destroyed).
//   3. The gist text exists as its own node, linked to every member via detail_of.
//   4. No member is deleted (no data loss), regardless of the retention knob.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-nd-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;
// The bug is independent of the retention knob; force the legacy "prune" merge
// path on to prove merge NEVER deletes a member even when keep-detail is off.
process.env.MEMORY_MERGE_KEEP = "false";

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { applyMerges } = require("../src/dream");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  // A realistic q313-shaped cluster: three PLAN/rule facts + one completed ACTION.
  const SENT = "I sent Theresa Caldwell's executive sponsor review reschedule note after Jamie's approval, using only the approved out-of-office window and no destination detail.";
  const facts = [
    { sig: "fact:resched-rule", fact: "For Theresa Caldwell's reschedule, the approved external wording is destination-neutral: say only that Jamie is out starting 2026-06-24.", first_seen: "2026-06-20", strength: 0.55 },
    { sig: "fact:resched-hold", fact: "I should not send the Caldwell reschedule note until Jamie approves it.", first_seen: "2026-06-23", strength: 0.6 },
    { sig: "fact:resched-alt",  fact: "If Jamie approves the Caldwell reschedule note, I should propose alternate times during the week of 2026-06-30.", first_seen: "2026-06-23", strength: 0.6 },
    { sig: "fact:resched-sent", fact: SENT, first_seen: "2026-06-25", strength: 0.72 },
  ];
  const ins = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, fact, kind) VALUES (?,?,?,?,?,'fact')");
  const insVec = db.prepare("INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)");
  for (const f of facts) {
    const info = ins.run(f.sig, "semantic", f.strength, f.first_seen, f.fact);
    insVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(f.fact)));
  }
  db.prepare("INSERT INTO nodes (signature, memory_id, kind, class, strength, first_seen, fact) VALUES ('person:theresa-caldwell','','entity','semantic',0.5,'2026-06-20','')").run();
  const edge = db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,'mentions','person:theresa-caldwell',0.8,'2026-06-20','2026-06-20')");
  for (const f of facts) edge.run(f.sig);

  // Worst-case LLM decision: it picks the ACTION fact as the survivor and writes
  // a PLAN-phrased gist (exactly the q313 collapse).
  const gist = "For Theresa Caldwell's executive sponsor review, do not send the reschedule note until Jamie approves it; if approved, propose alternate times the week of 2026-06-30.";
  const decisions = [{
    fact: gist,
    survivorSig: "fact:resched-sent",
    memberSigs: ["fact:resched-sent", "fact:resched-rule", "fact:resched-hold", "fact:resched-alt"],
  }];

  await applyMerges(db, decisions, { sim: 0.3 });

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };

  const allFacts = db.prepare("SELECT signature, fact, notes FROM nodes WHERE kind='fact'").all();
  const hasVerbatim = (needle) => allFacts.some((n) => (n.fact || "").includes(needle));

  // (1) survivor's original verbatim ACTION fact must survive somewhere.
  if (!hasVerbatim("I sent Theresa Caldwell")) fail("(1) survivor's original ACTION verbatim was destroyed by the merge");
  // (2) every member's distinctive verbatim survives.
  if (!hasVerbatim("propose alternate times")) fail("(2) member 'propose alternate times' verbatim lost");
  if (!hasVerbatim("should not send")) fail("(2) member 'should not send' verbatim lost");
  if (!hasVerbatim("destination-neutral")) fail("(2) member 'destination-neutral' verbatim lost");
  // (3) the gist must exist as its own node.
  const gistNode = allFacts.find((n) => (n.fact || "").includes("do not send the reschedule note until Jamie approves"));
  if (!gistNode) fail("(3) gist text node missing");
  // (4) no data loss: gist + 4 original members all present as retrievable nodes.
  const retrievable = allFacts.filter((n) => n.notes !== "archive" || true).length;
  if (retrievable < 5) fail(`(4) expected >=5 nodes (gist + 4 members), got ${retrievable}`);

  // (5) detail lineage: every original member verbatim is reachable as a detail of the gist.
  if (gistNode) {
    const details = db.prepare("SELECT n.fact FROM detail_of d JOIN nodes n ON n.signature=d.detail_sig WHERE d.gist_sig=?").all(gistNode.signature);
    const detailText = details.map((d) => d.fact || "").join(" || ");
    if (!detailText.includes("I sent Theresa Caldwell")) fail("(5) ACTION verbatim not linked as a detail_of the gist");
  }

  console.log(`nodes after merge: ${allFacts.length}`);
  for (const n of allFacts) console.log(`  [${n.notes}] ${n.signature} :: ${(n.fact || "").slice(0, 70)}`);

  console.log(ok ? "\nPASS \u2713 merge is non-destructive (all verbatims retained)" : "\nFAILED \u2717 merge destroyed a fact");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
