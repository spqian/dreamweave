"use strict";
// Regression + perf-contract: emitCandidates (synthesis candidate detection) must be INCREMENTAL.
//
// Before this fix, emitCandidates ran one vec_nodes KNN per active fact every night -> O(N^2),
// which became the dominant ingest cost as the store grew toward the tier-2 cap (hours/checkpoint
// at ~15-20k facts). The fix seeds the union-find KNN only from facts that (re)entered the
// synthesis-eligibility window since the last run — the maturing/just-joined cohort within the last
// (quietFor + slack) days — then BFS-expands through each tight (dense) cluster. Families whose
// eligibility did not change were already evaluated on a prior night, mirroring the incremental
// contract already used by reportSalience / reportMerges.
//
// Contract asserted here:
//   1. Incremental (asOf set, T.incrementalWeave on): a tight dormant family with a RECENT member
//      is emitted, AND its OLD members (outside the seed window) are reached via BFS expansion.
//   2. Incremental: a fully STALE tight dormant family (no member in the seed window) is SKIPPED.
//   3. Full-scan fallback (no asOf): BOTH families are emitted (exact legacy behavior preserved).
//   4. The incremental gate does not fabricate pools below minSize.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "synth-incr-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const cfg = require("../config");
  const { toVecBlob } = require("../src/embed");
  const { emitCandidates } = require("../src/dream");

  const DIM = cfg.EMBED_DIM;
  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  // A normalized vector that points mostly along basis index `hot` (a tiny per-member
  // perturbation keeps intra-cluster cosine ~0.999 while inter-cluster cosine ~0).
  const unitVec = (hot, k) => {
    const a = new Float32Array(DIM);
    a[hot] = 1.0;
    a[(hot + 1 + k) % DIM] += 0.02 * (k + 1);
    let n = 0; for (let i = 0; i < DIM; i++) n += a[i] * a[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < DIM; i++) a[i] /= n;
    return a;
  };

  const insNode = db.prepare(`INSERT INTO nodes (id, signature, class, salience, strength, reactivations, first_seen, last_reactivated, notes, fact, kind)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'fact')`);
  const insVec = db.prepare("INSERT INTO vec_nodes(rowid, embedding) VALUES (?, ?)");

  // All facts are dormant: weak strength, never reactivated -> isDormant true once aged.
  const addFact = (id, sig, hot, k, firstSeen) => {
    insNode.run(id, sig, "semantic", "", 0.2, 0, firstSeen, firstSeen, null, `fact ${sig}`);
    insVec.run(BigInt(id), toVecBlob(unitVec(hot, k)));
  };

  const asOf = "2026-06-01";
  // seed window = quietFor(14) + 45 = 59 days -> seedCutoff = 2026-04-03.

  // FRESH family (hot basis 0): one member INSIDE the window (2026-04-20, the maturing seed)
  // plus two members OUTSIDE the window (Jan) that BFS must still reach.
  const FRESH = ["fact:fresh-a", "fact:fresh-b", "fact:fresh-c"];
  addFact(1, FRESH[0], 0, 0, "2026-04-20"); // seed (in window, age 42d >= quietFor)
  addFact(2, FRESH[1], 0, 1, "2026-01-10"); // old, reached via BFS
  addFact(3, FRESH[2], 0, 2, "2026-01-12"); // old, reached via BFS

  // STALE family (hot basis 5): all members OUTSIDE the seed window -> eligibility unchanged.
  const STALE = ["fact:stale-a", "fact:stale-b", "fact:stale-c"];
  addFact(4, STALE[0], 5, 0, "2026-01-01");
  addFact(5, STALE[1], 5, 1, "2026-01-03");
  addFact(6, STALE[2], 5, 2, "2026-01-05");

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };

  const sigsOf = (pools) => new Set(pools.flatMap((p) => p.members.map((m) => m.sig)));
  const poolWith = (pools, sig) => pools.find((p) => p.members.some((m) => m.sig === sig));

  // (1)+(2) INCREMENTAL: only the FRESH family emits; BFS pulls in its old members.
  const incr = emitCandidates(db, { asOf });
  const incrSigs = sigsOf(incr.pools);
  console.log("incremental pools:", JSON.stringify(incr.pools.map((p) => ({ id: p.poolId, members: p.members.map((m) => m.sig) }))));

  if (!FRESH.every((s) => incrSigs.has(s))) fail("(1) FRESH family (with a recent member) was not fully emitted under the incremental gate");
  const freshPool = poolWith(incr.pools, FRESH[0]);
  if (!freshPool || freshPool.members.length < 3) fail("(1b) BFS expansion failed: FRESH pool did not reach its two out-of-window members");
  if (STALE.some((s) => incrSigs.has(s))) fail("(2) a fully STALE family was emitted under the incremental gate (should be skipped as already-evaluated)");

  // (3) FULL SCAN (no asOf): both families emit — legacy behavior preserved.
  const full = emitCandidates(db, {});
  const fullSigs = sigsOf(full.pools);
  console.log("full-scan pools:", JSON.stringify(full.pools.map((p) => ({ id: p.poolId, members: p.members.map((m) => m.sig) }))));
  if (!FRESH.every((s) => fullSigs.has(s))) fail("(3) FRESH family missing from full-scan output");
  if (!STALE.every((s) => fullSigs.has(s))) fail("(3) STALE family missing from full-scan output (full scan must be unchanged)");

  // (4) no sub-minSize junk pools.
  if (incr.pools.some((p) => p.members.length < 3) || full.pools.some((p) => p.members.length < 3)) fail("(4) a pool below minSize was emitted");

  console.log(ok
    ? "\nPASS \u2713 emitCandidates is incremental: seeds only the newly-eligible cohort, BFS-reaches old cluster members, skips unchanged families"
    : "\nFAILED \u2717 incremental synthesis-candidate contract violated");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
