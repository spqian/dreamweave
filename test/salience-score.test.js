"use strict";
// Layer 4 / P12 — SALIENCE = EARNED IMPORTANCE, judged only at dream time.
//
// Contract asserted here:
//   1. applySalience accepts the NEW scored shape { salient:[{sig,score}], downgrade:[sig] }
//      and stores a continuous salience_score; it NO LONGER sets class='salient'.
//   2. Legacy { salientSigs:[sig] } still works (backward-compat, score => 1.0).
//   3. The ranked sparsity cap bounds how many facts cross the salient threshold.
//   4. Downgrade revokes salience (score -> 0) WITHOUT destroying the fact or its strength.
//   5. The retroactive spotlight boosts a weak, temporally-adjacent, semantically-related
//      episodic — bounded, and IDEMPOTENT across repeated nights (no re-inflation).
//   6. salience_score continuously modulates the decay half-life (a salient fact decays
//      much slower than an identical non-salient one).
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "salience-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { applySalience, reportSalience, dreamCore } = require("../src/dream");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };
  const scoreOf = (sig) => (db.prepare("SELECT salience_score FROM nodes WHERE signature=?").get(sig) || {}).salience_score;
  const classOf = (sig) => (db.prepare("SELECT class FROM nodes WHERE signature=?").get(sig) || {}).class;
  const strengthOf = (sig) => (db.prepare("SELECT strength FROM nodes WHERE signature=?").get(sig) || {}).strength;

  const ins = db.prepare("INSERT INTO nodes (signature, class, salience_score, strength, first_seen, last_reactivated, last_decayed, fact, kind) VALUES (?,?,?,?,?,?,?,?,'fact')");
  const insVec = db.prepare("INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)");
  const add = async (sig, fact, opts = {}) => {
    const info = ins.run(sig, opts.class || "episodic", opts.sal || 0, opts.strength ?? 0.3, opts.first_seen || "2026-03-01", opts.first_seen || "2026-03-01", opts.first_seen || "2026-03-01", fact);
    insVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(fact)));
    return sig;
  };

  // ---- fixture: an important stakes/decision fact + an adjacent-window weak episodic on the
  //      SAME topic (spotlight target) + a distant-window weak episodic (must NOT be boosted)
  //      + a batch of ordinary daily-logistics facts (must NOT all become salient under the cap).
  await add("fact:layoff", "The board approved a company-wide reduction in force of 400 roles effective next quarter.", { first_seen: "2026-03-10", strength: 0.3 });
  await add("fact:layoff-adj", "The reduction in force will cut 400 positions across the affected teams.", { first_seen: "2026-03-10", strength: 0.25 });
  await add("fact:layoff-far", "The reduction in force headcount plan was referenced again in a later status update.", { first_seen: "2026-05-20", strength: 0.25 });
  for (let i = 0; i < 12; i++) await add(`fact:log${i}`, `On day ${i} I moved a routine calendar item and confirmed a lunch reservation number ${i}.`, { first_seen: "2026-03-10", strength: 0.3 });

  // ---------- (1)+(3) scored elevation + ranked cap ----------
  // Judge marks the layoff strongly salient plus (adversarially) ALL 12 logistics facts salient.
  const candidates = reportSalience(db).facts.map((f) => f.sig);
  if (!candidates.includes("fact:layoff")) fail("(report) new fact not surfaced as an elevation candidate");
  const decision = {
    salient: [{ sig: "fact:layoff", score: 0.95 }, ...Array.from({ length: 12 }, (_, i) => ({ sig: `fact:log${i}`, score: 0.9 }))],
  };
  const r1 = applySalience(db, decision, { asOf: "2026-03-11" });

  if (!(scoreOf("fact:layoff") >= 0.9)) fail("(1) layoff salience_score not stored");
  if (classOf("fact:layoff") === "salient") fail("(1) class must remain a durability class (episodic/semantic), never 'salient'");
  const salientCount = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND COALESCE(salience_score,0) >= 0.5").get().c;
  // 15 facts total => 15% global cap = 2; per-batch 20% of ~13 candidates = 2. Cap must bite hard.
  if (salientCount > 3) fail(`(3) ranked sparsity cap failed: ${salientCount} facts salient (expected <=3, cap should reject the 12 logistics facts)`);
  console.log(`elevated strong=${r1.salient_tagged} spotlighted=${r1.spotlighted}; total salient=${salientCount}`);

  // ---------- (5) retroactive spotlight ----------
  const adjBoosted = strengthOf("fact:layoff-adj") > 0.25 + 1e-9;
  const farBoosted = strengthOf("fact:layoff-far") > 0.25 + 1e-9;
  if (!adjBoosted) fail("(5) adjacent-window related weak episodic was NOT spotlight-boosted");
  if (farBoosted) fail("(5) distant-window episodic was wrongly boosted (temporal window not enforced)");
  const spotEdge = db.prepare("SELECT count(*) c FROM edges WHERE rel='spotlight'").get().c;
  if (spotEdge < 1) fail("(5) no 'spotlight' marker edge written");

  // ---------- (5b) spotlight IDEMPOTENCE: a second identical night must NOT re-boost ----------
  const before = strengthOf("fact:layoff-adj");
  applySalience(db, { salient: [{ sig: "fact:layoff", score: 0.95 }] }, { asOf: "2026-03-12" });
  const after = strengthOf("fact:layoff-adj");
  if (Math.abs(after - before) > 1e-9) fail(`(5b) spotlight re-inflated a neighbor on a repeat night (${before} -> ${after})`);

  // ---------- (2) legacy backward-compat + (4) non-destructive downgrade — fresh store ----------
  // (Sections 1/3 above intentionally consume db1's salience budget under the cap; test the
  //  legacy accept + downgrade contract on a clean store so the cap doesn't mask them.)
  const db2 = new Database(path.join(dataDir, "memory2.db"));
  sqliteVec.load(db2);
  ensureSchema(db2);
  const ins2 = db2.prepare("INSERT INTO nodes (signature, class, salience_score, strength, first_seen, last_reactivated, last_decayed, fact, kind) VALUES (?,?,?,?,?,?,?,?,'fact')");
  const insVec2 = db2.prepare("INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)");
  const add2 = async (sig, fact, opts = {}) => {
    const info = ins2.run(sig, opts.class || "episodic", opts.sal || 0, opts.strength ?? 0.3, opts.first_seen || "2026-03-01", opts.first_seen || "2026-03-01", opts.first_seen || "2026-03-01", fact);
    insVec2.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(fact)));
    return sig;
  };
  const scoreOf2 = (sig) => (db2.prepare("SELECT salience_score FROM nodes WHERE signature=?").get(sig) || {}).salience_score;
  const classOf2 = (sig) => (db2.prepare("SELECT class FROM nodes WHERE signature=?").get(sig) || {}).class;
  const strengthOf2 = (sig) => (db2.prepare("SELECT strength FROM nodes WHERE signature=?").get(sig) || {}).strength;
  for (let i = 0; i < 6; i++) await add2(`fact:filler${i}`, `A routine unrelated note number ${i} about scheduling and logistics.`, { first_seen: "2026-03-05" });
  await add2("fact:legacy", "A critical security incident (Sev1) exposed customer data and required an emergency response.", { first_seen: "2026-03-11", strength: 0.3 });
  applySalience(db2, { salientSigs: ["fact:legacy"] }, { asOf: "2026-03-12" });
  if (!(scoreOf2("fact:legacy") >= 0.9)) fail("(2) legacy salientSigs did not elevate (score should be ~1.0)");
  if (classOf2("fact:legacy") === "salient") fail("(2) legacy path must not set class='salient'");

  // ---------- (4) downgrade is non-destructive ----------
  const strBefore = strengthOf2("fact:legacy");
  const rD = applySalience(db2, { downgrade: ["fact:legacy"] }, { asOf: "2026-03-13" });
  if (rD.downgraded !== 1) fail("(4) downgrade did not apply");
  if ((scoreOf2("fact:legacy") || 0) >= 0.5) fail("(4) salience_score not revoked on downgrade");
  const stillThere = db2.prepare("SELECT fact FROM nodes WHERE signature='fact:legacy'").get();
  if (!stillThere || !/security incident/.test(stillThere.fact)) fail("(4) downgrade DESTROYED the fact (must be non-destructive, P6)");
  if (Math.abs(strengthOf2("fact:legacy") - strBefore) > 1e-9) fail("(4) downgrade slashed strength (should let decay handle it)");
  db2.close();

  // ---------- (6) salience_score modulates half-life ----------
  // Two identical-age facts, one salient one not; after a decay run the salient one must be stronger.
  await add("fact:decay-plain", "A generic status note recorded on a Tuesday afternoon.", { first_seen: "2026-01-01", strength: 0.8, sal: 0 });
  await add("fact:decay-sal", "A generic status note recorded on a Tuesday afternoon (copy).", { first_seen: "2026-01-01", strength: 0.8, sal: 0.95 });
  db.prepare("UPDATE nodes SET last_decayed='2026-01-01' WHERE signature IN ('fact:decay-plain','fact:decay-sal')").run();
  dreamCore(db, { "as-of": "2026-04-01" });
  const sp = strengthOf("fact:decay-plain"), ss = strengthOf("fact:decay-sal");
  if (!(ss > sp)) fail(`(6) salience_score did not slow decay (salient ${ss} should exceed plain ${sp})`);
  console.log(`decay after ~90d: plain=${(sp||0).toFixed(4)} salient=${(ss||0).toFixed(4)}`);

  console.log(ok ? "\nPASS \u2713 salience: scored + cap + spotlight(idempotent) + downgrade + half-life" : "\nFAILED \u2717 salience contract broken");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
