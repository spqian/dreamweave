"use strict";
// Regression: HYBRID (dense + sparse) seeding must surface a lexically-distinctive fact
// that dense cosine seeding buries.
//
// The q122 failure: the persona restates a standing decision ("Maya keeps treasury in
// watch mode") on ~100 near-identical days. The ONE specific committed statement the
// question asks about ("if the miss is real, I need to know whether treasury has knock-on
// implications ... before the narrative is locked") is present but its long sentence
// dilutes its embedding, so it sits at cosine rank ~9 — below the seed cut — while generic
// restatements crowd the top. It is NOT a gist member (no detail_of), so parent-gist
// drilldown cannot reach it either. Yet it UNIQUELY carries the query's discriminating
// terms (miss/real/narrative/locked), so a term-overlap channel ranks it #1.
//
// Contract asserted here:
//   1. selectLexicalSeeds returns the lexically-distinctive gold node.
//   2. A generic near-duplicate that shares only 1 weak term is NOT returned.
//   3. Cosine seeds are never displaced (they are excluded from the lexical add).
//   4. The min-hits floor rejects one-token coincidences.
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-seed-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { selectLexicalSeeds, significantTerms } = require("../src/recall");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  const ins = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, fact, kind, notes) VALUES (?,?,?,?,?,'fact',?)");

  // GOLD: the specific committed statement (a detail node, high term overlap).
  const GOLD = "fact:maya-knockon";
  ins.run(GOLD, "semantic", 0.5, "2026-03-19",
    'On 2026-03-19, Maya Goldstein said, "If the miss is real, I need to know whether treasury has any knock-on implications before the earnings narrative is locked."',
    "detail");

  // ~12 generic near-duplicate restatements of the standing posture (the dense cluster).
  // They share at most the token "treasury"/"miss" weakly, never the discriminating set.
  for (let i = 0; i < 12; i += 1) {
    ins.run(`fact:maya-watch-${i}`, "semantic", 0.6 + i * 0.01, `2026-02-${String(10 + i).padStart(2, "0")}`,
      `Maya Goldstein said she is still watching cash timing and debt posture closely; treasury stays in monitoring mode (day ${i}).`,
      "detail");
  }
  // A one-token coincidence: mentions "narrative" only, nothing else.
  ins.run("fact:pr-narrative", "semantic", 0.9, "2026-05-01",
    "The comms team owns the external product-launch narrative for the spring campaign.", "detail");
  // A gist that summarized AWAY the facet (present but useless for the specific ask).
  ins.run("fact:maya-gist", "semantic", 0.8, "2026-04-01",
    "Maya Goldstein's treasury posture remained unchanged and on watch through the quarter.", "gist");

  const query = "What did Maya want clarified before the earnings narrative was locked once the miss appeared real?";
  const terms = significantTerms(query);

  let ok = true;
  const fail = (m) => { console.error("FAIL:", m); ok = false; };

  console.log("query terms:", terms.join(" "));

  // (1) gold is returned as a lexical seed.
  const seeds = selectLexicalSeeds(db, query, { budget: 2 });
  const seedSigs = seeds.map((s) => s.signature);
  console.log("lexical seeds:", JSON.stringify(seeds));
  if (!seedSigs.includes(GOLD)) fail("(1) lexically-distinctive gold fact was NOT returned as a seed");
  // gold should be the top lexical seed (most term hits).
  if (seeds.length && seeds[0].signature !== GOLD) fail(`(1b) gold should rank #1 by term overlap, got ${seeds[0].signature}`);

  // (2) a generic near-duplicate must not out-rank / crowd out the gold.
  if (seedSigs.some((s) => /maya-watch-/.test(s))) fail("(2) a generic near-duplicate restatement was seeded over the gold");

  // (3) cosine seeds are never displaced — excluded sigs never appear.
  const excl = new Set([GOLD]);
  const seeds2 = selectLexicalSeeds(db, query, { budget: 2, exclude: excl });
  if (seeds2.map((s) => s.signature).includes(GOLD)) fail("(3) excluded (already-cosine-seeded) node was re-added by the lexical channel");

  // (4) the one-token coincidence is rejected by the min-hits floor.
  if (seedSigs.includes("fact:pr-narrative")) fail("(4) a one-token coincidence passed the min-hits floor");

  // (5) budget is respected.
  if (seeds.length > 2) fail(`(5) budget exceeded: got ${seeds.length} seeds`);

  // (6) below-2-terms query yields no lexical seeds (nothing discriminating).
  if (selectLexicalSeeds(db, "treasury", { budget: 2 }).length !== 0) fail("(6) single-term query should not produce lexical seeds");

  console.log(ok
    ? "\nPASS \u2713 hybrid seeding surfaces the lexically-distinctive fact without crowding from restatements"
    : "\nFAILED \u2717 hybrid seeding contract violated");
  db.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
