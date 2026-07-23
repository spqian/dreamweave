"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-reactivation-synthesis-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const {
    dreamCore,
    doctor,
    reportSynthesis,
    applySynthesis,
    pendingSemanticSigs,
  } = require("../src/dream");

  const open = (name) => {
    const db = new Database(path.join(dataDir, name));
    sqliteVec.load(db);
    ensureSchema(db);
    return db;
  };
  const addFact = async (db, sig, fact, firstSeen, opts = {}) => {
    const info = db.prepare(`
      INSERT INTO nodes(
        signature,memory_id,kind,class,strength,reactivations,first_seen,source_day,
        last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq
      ) VALUES (?,?, 'fact',?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      sig, opts.memoryId || "", opts.class || "episodic",
      opts.strength == null ? 0.3 : opts.strength,
      opts.reactivations || 0, firstSeen, firstSeen.slice(0, 10), firstSeen, firstSeen,
      opts.notes || "harness-ingest", fact, "", opts.seq || 0, opts.seq || 0
    );
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
      .run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(fact)));
    return Number(info.lastInsertRowid);
  };
  const addHub = (db, sig) => {
    db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text)
      VALUES (?,'','entity','semantic',0.5,'2026-01-01','caller-approved','','')
    `).run(sig);
  };
  const mention = (db, factSig, hubSig) => {
    db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,'mentions',?,0.8,'2026-01-01','2026-01-01')")
      .run(factSig, hubSig);
  };
  const addEvidence = (db, newSig, oldSig, hubSig, seq, at) => {
    db.prepare(`
      INSERT INTO reactivation_families(family_key,evidence_seq,evidence_count,observed_at)
      VALUES (?,?,1,?)
      ON CONFLICT(family_key) DO UPDATE SET evidence_seq=max(evidence_seq,excluded.evidence_seq),
        evidence_count=evidence_count+1, observed_at=excluded.observed_at
    `).run(hubSig, seq, at);
    const member = db.prepare(`
      INSERT INTO reactivation_members(family_key,member_sig,evidence_count,latest_seq,observed_at)
      VALUES (?,?,1,?,?)
      ON CONFLICT(family_key,member_sig) DO UPDATE SET evidence_count=evidence_count+1,
        latest_seq=max(latest_seq,excluded.latest_seq), observed_at=excluded.observed_at
    `);
    member.run(hubSig, newSig, seq, at);
    member.run(hubSig, oldSig, seq, at);
    db.prepare(`
      INSERT OR REPLACE INTO reactivation_examples(family_key,new_sig,old_sig,observed_seq,observed_at)
      VALUES (?,?,?,?,?)
    `).run(hubSig, newSig, oldSig, seq, at);
  };

  // Mechanical recurrence must no longer turn the exact episode into semantic text.
  const dbPromotion = open("promotion.db");
  addHub(dbPromotion, "system:jit");
  await addFact(dbPromotion, "fact:old-request", "A JIT request for Alpha was pending.", "2026-07-01T00:00:00Z", { reactivations: 1 });
  await addFact(dbPromotion, "fact:new-request", "A JIT request for Beta arrived.", "2026-07-10T00:00:00Z", { seq: 1 });
  mention(dbPromotion, "fact:old-request", "system:jit");
  mention(dbPromotion, "fact:new-request", "system:jit");
  dbPromotion.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();
  dbPromotion.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','0')").run();
  const dream = dreamCore(dbPromotion, { "as-of": "2026-07-10T00:00:00Z", "run-id": "reactivation-no-promotion" });
  const promoted = dbPromotion.prepare("SELECT class,reactivations FROM nodes WHERE signature='fact:old-request'").get();
  const event = dbPromotion.prepare("SELECT evidence_count FROM reactivation_families WHERE family_key='system:jit'").get();
  if (promoted.class !== "episodic" || promoted.reactivations !== 2 || dream.promoted_semantic !== 0) {
    throw new Error("reactivation still promoted the verbatim episode");
  }
  if (!event || event.evidence_count !== 1) throw new Error("qualified semantic evidence was not persisted");
  dbPromotion.close();

  // Caller-reviewed synthesis turns a recurrence family into one semantic gist.
  const db = open("synthesis.db");
  addHub(db, "system:access-approval");
  await addFact(db, "fact:req-alpha", "Access approval Alpha arrived for Peter.", "2026-06-01T00:00:00Z", { reactivations: 2, strength: 0.5 });
  await addFact(db, "fact:req-beta", "Access approval Beta arrived for Peter.", "2026-06-02T00:00:00Z", { reactivations: 2, strength: 0.5 });
  await addFact(db, "fact:req-current", "Access approval Gamma is currently awaiting Peter.", "2026-07-14T00:00:00Z", { seq: 5 });
  for (const sig of ["fact:req-alpha", "fact:req-beta", "fact:req-current"]) mention(db, sig, "system:access-approval");
  addEvidence(db, "fact:req-current", "fact:req-alpha", "system:access-approval", 5, "2026-07-15T00:00:00Z");
  addEvidence(db, "fact:req-current", "fact:req-beta", "system:access-approval", 5, "2026-07-15T00:00:00Z");
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','5')").run();

  const first = reportSynthesis(db, { asOf: "2026-07-15T00:00:00Z" });
  if (!first.report_id || first.reactivation_pools.length !== 1) throw new Error("reactivation family was not reported");
  const pool = first.reactivation_pools[0];
  if (!pool.members.find((m) => m.sig === "fact:req-current" && !m.archiveEligible)) {
    throw new Error("current exemplar was not protected from archival");
  }
  if (!pendingSemanticSigs(db).has("fact:req-alpha")) throw new Error("pending family was not durability-protected");

  await addFact(db, "fact:unrelated-change", "The cafeteria menu changed.", "2026-07-15T00:00:00Z", { seq: 6 });
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','6')").run();
  const stale = await applySynthesis(db, {
    report_id: first.report_id,
    decisions: [],
    reactivation_reviews: [{ poolId: pool.poolId, action: "reject" }],
  }, { asOf: "2026-07-15T00:00:00Z" });
  if (stale.complete !== false || !stale.rejected.some((r) => r.reason === "report_stale")) {
    throw new Error("stale synthesis report was not rejected");
  }

  const rejectReport = reportSynthesis(db, { asOf: "2026-07-15T00:00:00Z" });
  const rejected = await applySynthesis(db, {
    report_id: rejectReport.report_id,
    decisions: [],
    reactivation_reviews: [{ poolId: rejectReport.reactivation_pools[0].poolId, action: "reject" }],
  }, { asOf: "2026-07-15T00:00:00Z" });
  if (!rejected.complete || rejected.reactivation_reviewed !== 1) throw new Error("reactivation rejection was not recorded");
  if (reportSynthesis(db, { asOf: "2026-07-15T00:00:00Z" }).reactivation_pools.length !== 0) {
    throw new Error("rejected family immediately resurfaced");
  }
  if (pendingSemanticSigs(db).size !== 0) throw new Error("rejected family remained durability-protected");

  await addFact(db, "fact:req-delta", "Access approval Delta arrived for Peter.", "2026-07-15T01:00:00Z", { seq: 7 });
  mention(db, "fact:req-delta", "system:access-approval");
  addEvidence(db, "fact:req-delta", "fact:req-alpha", "system:access-approval", 7, "2026-07-15T01:00:00Z");
  addEvidence(db, "fact:req-delta", "fact:req-beta", "system:access-approval", 7, "2026-07-15T01:00:00Z");
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','7')").run();

  const acceptedReport = reportSynthesis(db, { asOf: "2026-07-15T02:00:00Z" });
  if (acceptedReport.reactivation_pools.length !== 1) throw new Error("new evidence did not resurface the family");
  const acceptedPool = acceptedReport.reactivation_pools[0];
  const accepted = await applySynthesis(db, {
    report_id: acceptedReport.report_id,
    decisions: [],
    reactivation_reviews: [{
      poolId: acceptedPool.poolId,
      action: "synthesize",
      groups: [{
        concept: "Peter receives recurring access approval requests; individual request IDs are transient.",
        memberSigs: ["fact:req-alpha", "fact:req-beta"],
        span: "June-July 2026",
        scale: "four observed requests",
      }],
    }],
  }, { asOf: "2026-07-15T02:00:00Z" });
  if (!accepted.complete || accepted.concepts_created !== 1 || accepted.members_demoted !== 2) {
    throw new Error("accepted recurrence was not synthesized");
  }
  const concept = db.prepare("SELECT signature,class,notes FROM nodes WHERE fact LIKE 'Peter receives recurring access approval requests%'").get();
  if (!concept || concept.class !== "semantic" || concept.notes !== "gist") throw new Error("semantic gist was not created");
  const archived = db.prepare("SELECT signature,notes FROM nodes WHERE signature IN ('fact:req-alpha','fact:req-beta') ORDER BY signature").all();
  if (archived.length !== 2 || archived.some((n) => n.notes !== "archive")) throw new Error("historical instances were not archived");
  const current = db.prepare("SELECT class,notes FROM nodes WHERE signature='fact:req-current'").get();
  if (current.class !== "episodic" || current.notes === "archive") throw new Error("current exemplar was incorrectly generalized");
  const lineage = db.prepare("SELECT count(*) c FROM detail_of WHERE gist_sig=?").get(concept.signature).c;
  if (lineage !== 2) throw new Error("exact recurring instances are not recallable through the gist");
  if (reportSynthesis(db, { asOf: "2026-07-15T02:00:00Z" }).reactivation_pools.length !== 0) {
    throw new Error("accepted family immediately resurfaced");
  }

  // Multi-hub recurrence may share historical instances, but the report must
  // expose each instance as archive-selectable in only one pool.
  const overlap = open("overlap.db");
  addHub(overlap, "system:jit");
  addHub(overlap, "project:access");
  for (const [sig, fact, date] of [
    ["fact:shared-old", "Peter handled a JIT access approval.", "2026-06-01T00:00:00Z"],
    ["fact:jit-old", "Peter handled another JIT approval.", "2026-06-02T00:00:00Z"],
    ["fact:access-old-1", "Peter handled an access request for Project Access.", "2026-06-03T00:00:00Z"],
    ["fact:access-old-2", "Peter handled another Project Access request.", "2026-06-04T00:00:00Z"],
    ["fact:jit-new", "A new JIT approval arrived.", "2026-07-15T00:00:00Z"],
    ["fact:access-new", "A new Project Access request arrived.", "2026-07-15T00:00:00Z"],
  ]) await addFact(overlap, sig, fact, date, { reactivations: 2, seq: 9 });
  for (const sig of ["fact:shared-old", "fact:jit-old", "fact:jit-new"]) mention(overlap, sig, "system:jit");
  for (const sig of ["fact:shared-old", "fact:access-old-1", "fact:access-old-2", "fact:access-new"]) mention(overlap, sig, "project:access");
  addEvidence(overlap, "fact:jit-new", "fact:shared-old", "system:jit", 9, "2026-07-15T00:00:00Z");
  addEvidence(overlap, "fact:jit-new", "fact:jit-old", "system:jit", 9, "2026-07-15T00:00:00Z");
  addEvidence(overlap, "fact:access-new", "fact:shared-old", "project:access", 9, "2026-07-15T00:00:00Z");
  addEvidence(overlap, "fact:access-new", "fact:access-old-1", "project:access", 9, "2026-07-15T00:00:00Z");
  addEvidence(overlap, "fact:access-new", "fact:access-old-2", "project:access", 9, "2026-07-15T00:00:00Z");
  overlap.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','9')").run();
  const overlapPools = reportSynthesis(overlap, { asOf: "2026-07-15T00:00:00Z" }).reactivation_pools;
  if (overlapPools.length !== 2) throw new Error("overlapping recurrence families were dropped");
  const sharedSelectable = overlapPools
    .flatMap((p) => p.members)
    .filter((m) => m.sig === "fact:shared-old" && m.archiveEligible).length;
  if (sharedSelectable !== 1) throw new Error("shared instance was selectable in multiple pools");
  overlap.close();

  // Persistent recurrence evidence is aggregate + write-capped, not one row per
  // historical pair. Exact counters may grow; retained examples may not.
  const bounded = open("bounded.db");
  addHub(bounded, "system:bounded-family");
  // Dilute the store so the recurrence hub is a SPECIFIC entity, not a ubiquitous connector.
  // The auto-reactivate ubiquity guard (specificHubState) skips any hub mentioned by more than
  // ~20% of all active facts as a generic connector carrying no discriminating recurrence signal,
  // so a hub touched by every fact would (correctly) record no evidence. These unrelated fillers
  // keep the counter/example-cap mechanics under test while the family stays below the cut.
  for (let i = 0; i < 150; i += 1) {
    await addFact(bounded, `fact:filler-${i}`, `Unrelated filler fact ${i}.`, "2026-06-01T00:00:00Z", { seq: 1 });
  }
  for (let i = 0; i < 20; i += 1) {
    const sig = `fact:bounded-old-${i}`;
    await addFact(bounded, sig, `Historical recurring request ${i}.`, "2026-06-01T00:00:00Z", { reactivations: 2, seq: 1 });
    mention(bounded, sig, "system:bounded-family");
  }
  for (let i = 0; i < 3; i += 1) {
    const sig = `fact:bounded-new-${i}`;
    await addFact(bounded, sig, `New recurring request ${i}.`, "2026-07-20T00:00:00Z", { seq: 20 });
    mention(bounded, sig, "system:bounded-family");
  }
  bounded.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','20')").run();
  bounded.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','10')").run();
  dreamCore(bounded, { "as-of": "2026-07-20T00:00:00Z", "run-id": "bounded-reactivation" });
  const familyCount = bounded.prepare("SELECT evidence_count FROM reactivation_families WHERE family_key='system:bounded-family'").get();
  const exampleCount = bounded.prepare("SELECT count(*) c FROM reactivation_examples WHERE family_key='system:bounded-family'").get().c;
  if (!familyCount || familyCount.evidence_count !== 60) throw new Error("aggregate recurrence counter lost evidence");
  if (exampleCount > 40) throw new Error(`reactivation example cap exceeded: ${exampleCount}`);
  if (doctor(bounded).reactivation_example_overflow !== 0) throw new Error("doctor missed/flagged bounded recurrence evidence");
  bounded.close();

  console.log("PASS \u2713 reactivation promotes caller-extracted semantics, not transient episodes");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
