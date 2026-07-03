"use strict";

// dream.js — the memory consolidation engine. Every nightly stage is implemented here.
// memory.db is the durable source of truth; the harness bank is its nightly projection.
//
// Subcommands:
//   migrate-model              one-time: split nodes into kind=fact / kind=entity, re-signature facts
//   ingest-harness  --file F [--prune]   harness -> db, memory_id-keyed, lossless (sync)
//   verify-sync     --file F             hard gate: every harness id present in db (exit 3 if not)
//   dream           [--advance-days N]   decay + auto-reactivate + evaporate + housekeeping (+journal)
//   weave [--llm]                        co-mention + vector links; GUARANTEES zero fact islands
//                                        (--llm adds typed entity extraction + alias canonicalization)
//   reflect                              LLM judgment pass: salience tagging + semantic merge (needs DREAM_LLM)
//   consolidate                          report duplicate-fact merge candidates (agent confirms)
//   doctor                               health report; exit 3 if islands or dangling edges
//   export-harness                       FACTS only, inject-ready, strongest first
//   record-projection --file F           store harness ids after projection
//   export-viz                           regenerate graph-store-visualization.html
//   stats
//
// Node kinds:
//   fact   : signature fact:<slug>, memory_id set, has strength/decay, projects to harness
//   entity : signature person:/system:/... , memory_id='', connector hub, no independent decay

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const fs = require("fs");
const path = require("path");
const { embedTexts, embedOne, toVecBlob } = require("./embed");
const { buildNodeText } = require("./graphtext");
const ent = require("./entities");
const { ensureSchema } = require("./schema");
const { getLLM } = require("./llm");
const judge = require("./judge");
const { ageDays, ageTag } = require("./timeline");
const cfg = require("../config");
const tuning = require("./tuning");

// Resolved behavioral knobs (defaults <- memory.config.json <- env override).
// One snapshot per process; the CLI `config` subcommand re-reads fresh.
const T = tuning.resolve();
// Effective env for the optional LLM judge: the `judgment` knob supplies DREAM_LLM
// unless an explicit DREAM_LLM env var is already set (which still wins).
const llmEnv = () => ({ ...process.env, DREAM_LLM: T.llmSpec || process.env.DREAM_LLM || "" });

// ---- PHASE PROFILER (env MEMORY_PROFILE=1) ---------------------------------
// Lightweight per-phase wall-clock timing to stderr, to find where nightly cost
// scales with store size. Zero overhead when off.
const PROF_ON = process.env.MEMORY_PROFILE === "1";
function prof(label, fn) {
  if (!PROF_ON) return fn();
  const t0 = process.hrtime.bigint();
  const r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stderr.write(`[prof] ${label} ${ms.toFixed(1)}ms\n`);
  return r;
}
async function profA(label, fn) {
  if (!PROF_ON) return fn();
  const t0 = process.hrtime.bigint();
  const r = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  process.stderr.write(`[prof] ${label} ${ms.toFixed(1)}ms\n`);
  return r;
}

const DATA_DIR = cfg.DATA_DIR;
const DB_PATH = cfg.DB_PATH; // env MEMORY_DB overrides (e.g. dry-run forecasts)
const VIZ_TEMPLATE = cfg.VIZ_TEMPLATE; // tracked template (empty data line)
const VIZ_OUT = cfg.VIZ_OUT;           // per-user rendered output

const HALFLIFE = { salient: 365, semantic: 180, episodic: 3 };
const INIT = { salient: 0.90, semantic: 0.70, episodic: 0.30 };
const CAT2CLASS = { decision: "salient", fact: "semantic", context: "episodic", preference: "semantic" };
const CLASS2CAT = { salient: "decision", semantic: "fact", episodic: "context" };
const FORGET = 0.15;
const EDGE_DECAY = { mentions: 1.0, related_to: 0.985, similar_to: 0.97, supersedes: 1.0, sequence: 1.0, default: 0.99 }; // multiplicative per run

// ---- ENTRY BUDGET ----------------------------------------------------------
// The harness caps memory ENTRIES (= fact nodes; entity hubs are free db-side scaffolding).
// Hard max 500; performance degrades past 250. Target 250 as the sweet spot. As the bank
// approaches/exceeds target, dreaming escalates fading + merging. We prefer MERGE (fewer,
// richer entries) over deletion — entry SIZE may grow to keep the COUNT down.
const ENTRY_TARGET = T.entryTarget; // capacity knob (env MEMORY_ENTRY_TARGET overrides)
const ENTRY_MAX = T.entryMax;       // capacity knob (env MEMORY_ENTRY_MAX overrides)
// TIER 2 ("RAG class"): the bounded graph+vector store recall searches. Embedded fact
// nodes over this cap are DEMOTED (not deleted) to Tier 3 — a raw keyword-only archive
// (notes='archive', no vector, no edges). 0 disables (single-tier behavior). The brain
// analog: a bounded associative store + an unindexed "bookshelf" you can still dig through.
const TIER2_MAX = T.tier2Max; // capacity+retention knobs (env MEMORY_TIER2_MAX overrides)
// SQL fragment for "active" facts = Tier 1+2 (embedded, in graph). Tier-3 archive nodes
// must be excluded from EVERY nightly query that costs compute, re-embeds, or could
// delete them — they are inert keyword-only cold storage. Use this everywhere except the
// explicit Tier-3 keyword recall. (Audit-hardened: archive must never reach decay,
// evaporate, hard-cap, reactivation, salience, schema, or budget.)
const ACTIVE_FACT = "kind='fact' AND (notes IS NULL OR notes<>'archive')";
// Retain/tiered mode: when on, destructive eviction (ENTRY_MAX hard cap, weak-semantic
// fade) is replaced by DEMOTION — we never physically delete a fact, we move it to Tier 3.
const TIERED = () => T.tiered; // retention knob: preserve=tiered(demote), prune=destructive

// pressure = facts / target. Gentle below ~0.6; escalates toward/above 1.0.
function budgetParams(factCount) {
  const pressure = factCount / ENTRY_TARGET;
  const esc = Math.max(0, pressure - 0.6); // escalation kicks in at 60% of target
  // forget threshold rises 0.15 -> ~0.45 as pressure climbs (more episodics fade)
  const forgetThreshold = Math.min(0.45, FORGET + esc * 0.35);
  // effective decay acceleration: half-lives shrink as pressure rises (faster fade)
  const decayAccel = 1 + Math.max(0, pressure - 1.0) * 1.0 + esc * 0.4;
  // merge similarity bar lowers 0.62 -> ~0.50 (more aggressive dedup/rollup under pressure)
  const mergeSim = Math.max(0.50, 0.62 - esc * 0.18);
  // above target, also fade weak SEMANTIC (re-derivable) below this strength
  const semanticFade = pressure >= 1.0 ? Math.min(0.40, 0.25 + (pressure - 1.0) * 0.25) : 0;
  let status = "ok";
  if (factCount >= ENTRY_MAX) status = "critical";
  else if (factCount > ENTRY_TARGET) status = "over";
  else if (pressure >= 0.8) status = "elevated";
  return { pressure: Number(pressure.toFixed(3)), forgetThreshold: Number(forgetThreshold.toFixed(3)), decayAccel: Number(decayAccel.toFixed(3)), mergeSim: Number(mergeSim.toFixed(3)), semanticFade: Number(semanticFade.toFixed(3)), status };
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
// unit-normalize a vector; dot product of two vectors (used for the gist vagueness trace).
const unit = (v) => { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
// HARD-SPECIFIC extraction for the vagueness trace. A "hard specific" is an answer-bearing
// literal the LLM cannot reconstruct from a generalization: money, percentage, multiple, and
// counted quantities. DATES/TIMES are deliberately EXCLUDED — per-day "as of 2026-03-26"
// restatement timestamps are CORRECTLY dropped by generalization and would swamp the signal.
// Returns a Set of normalized token strings so the same value stated two ways collides.
const HARD_SPEC = {
  money: /\$\s?\d[\d.,]*(?:\s?[-–]\s?\d[\d.,]*)?\s?(?:million|billion|thousand|[mbk])?\b/gi,
  pct: /\b\d+(?:\.\d+)?\s?%/g,
  mult: /\b\d+(?:\.\d+)?\s?x\b/gi,
  count: /\b\d{1,4}\s+(?:people|employees|seats|headcount|customers|users|accounts|deals|reps|hires|roles|units|shares|basis points|bps)\b/gi,
};
function extractHardSpecifics(text) {
  const out = new Set();
  if (!text) return out;
  for (const re of Object.values(HARD_SPEC)) {
    const m = text.match(re);
    if (!m) continue;
    for (let t of m) {
      t = t.toLowerCase().replace(/\s+/g, "")
        .replace(/million/g, "m").replace(/billion/g, "b").replace(/thousand/g, "k")
        .replace(/–/g, "-");
      if (t) out.add(t);
    }
  }
  return out;
}
const UNTRUSTED = /<\/?untrusted_memory>/g;const STOPW = new Set("the a an is are was were of for to in on and or that with as at by from this its not be no into".split(" "));

function deriveSlug(fact) {
  const w = ent.normalize(fact).split(" ").filter((x) => !STOPW.has(x) && x.length > 2).slice(0, 5).join("-");
  return (w || "fact").slice(0, 48);
}

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  return db;
}

function parseFlags(argv) {
  const f = {};
  for (let i = 3; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) f[a.slice(2)] = (i + 1 < argv.length && !argv[i + 1].startsWith("--")) ? argv[++i] : true;
  }
  return f;
}

const nextId = (db) => db.prepare("SELECT COALESCE(MAX(id),0)+1 m FROM nodes").get().m;
const getMeta = (db, k) => (db.prepare("SELECT value FROM meta WHERE key=?").get(k) || {}).value;
const setMeta = (db, k, v) => db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)").run(k, v);

// EMBED-ONCE: a fact's MiniLM vector is computed once at ingest/weave and stored in
// vec_nodes. The nightly weave/consolidate KNN loops must REUSE that stored vector as
// the query rather than re-embedding every fact every night (which made cost grow with
// the bank). Returns the stored embedding blob, or null if the node was never embedded
// (caller falls back to embedOne only then). MiniLM is deterministic, so the stored
// vector is identical to a fresh embed of the same text.
function storedVecBlob(db, id) {
  try { const r = db.prepare("SELECT embedding FROM vec_nodes WHERE rowid=?").get(BigInt(id)); return r ? r.embedding : null; }
  catch { return null; }
}
async function queryVec(db, node) {
  const v = storedVecBlob(db, node.id);
  if (v) return v;
  return toVecBlob(await embedOne(node.fact || node.signature));
}

function uniqueSig(db, base) {
  if (!db.prepare("SELECT 1 FROM nodes WHERE signature=?").get(base)) return base;
  let i = 2; while (db.prepare("SELECT 1 FROM nodes WHERE signature=?").get(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// ---- embeddings -------------------------------------------------------------
function injectText(node, edgesBySig) {
  const f = (node.fact || "").trim();
  if (f) return f;
  return buildNodeText(node.signature, edgesBySig.get(node.signature) || []);
}

async function reembed(db, onlyIds) {
  const rows = onlyIds
    ? db.prepare(`SELECT id, signature, fact FROM nodes WHERE id IN (${onlyIds.map(() => "?").join(",")})`).all(...onlyIds)
    : db.prepare("SELECT id, signature, fact FROM nodes").all();
  if (!rows.length) return;
  const edges = db.prepare("SELECT src, rel, dst FROM edges").all();
  const eb = new Map();
  rows.forEach((r) => eb.set(r.signature, []));
  edges.forEach((e) => { if (eb.has(e.src)) eb.get(e.src).push(e); if (eb.has(e.dst)) eb.get(e.dst).push(e); });
  const texts = rows.map((r) => injectText(r, eb));
  const vecs = await embedTexts(texts);
  const tx = db.transaction(() => {
    rows.forEach((r, i) => {
      db.prepare("UPDATE nodes SET text=? WHERE id=?").run(texts[i], r.id);
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(r.id));
      // Re-embedding means this node is ACTIVE again; ensure it isn't ALSO left in the
      // cold vec_archive (revive path), or it would surface from both KNN pools.
      db.prepare("DELETE FROM vec_archive WHERE rowid=?").run(BigInt(r.id));
      db.prepare("INSERT INTO vec_nodes(rowid, embedding) VALUES (?, ?)").run(BigInt(r.id), toVecBlob(vecs[i]));
    });
  });
  tx();
}

// ---- graph guards -----------------------------------------------------------
function repairGraph(db) {
  const now = new Date().toISOString();
  db.prepare("UPDATE nodes SET memory_id='' WHERE memory_id='live'").run();
  // Self-heal prior pollution: blank `fact:`-sig 'scaffolding' stubs are illegitimate (a fact
  // signature was wrongly resurrected as a content-less entity by the old repairGraph). Delete
  // them here; the dangling-edge scan below then drops any edges that pointed at them.
  db.prepare("DELETE FROM nodes WHERE notes='scaffolding' AND signature LIKE 'fact:%' AND (fact IS NULL OR fact='')").run();
  const sigs = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  const referenced = new Set();
  for (const e of db.prepare("SELECT src, dst FROM edges").all()) { referenced.add(e.src); referenced.add(e.dst); }
  let restored = 0, droppedFactEdges = 0;
  for (const s of [...referenced].filter((x) => x && !sigs.has(x))) {
    // A dangling FACT endpoint means the fact was consolidated/pruned/demoted away. It must
    // NOT be resurrected as a blank entity hub: that mints content-less 'scaffolding' stubs
    // and silently re-homes sequence/supersedes chains onto a fake node (the root cause of
    // "100% of sequence edges dangle onto blank stubs" in the live store). Drop the dangling
    // edges instead; any lineage that must survive a demotion already lives in detail_of.
    if (s.startsWith("fact:")) {
      droppedFactEdges += db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(s, s).changes;
      continue;
    }
    // A dangling ENTITY endpoint is a legitimate hub the weave referenced; resurrect it.
    const id = nextId(db);
    db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
      VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(id, s, "", "entity", "semantic", "semantic", 0.5, now, now, now, "scaffolding", "", "");
    restored += 1;
  }
  return restored;
}

const degreeMap = (db) => {
  const d = new Map();
  for (const e of db.prepare("SELECT src, dst FROM edges").all()) { d.set(e.src, (d.get(e.src) || 0) + 1); d.set(e.dst, (d.get(e.dst) || 0) + 1); }
  return d;
};

// ---- MIGRATE ----------------------------------------------------------------
function migrateModel(db) {
  const now = new Date().toISOString();
  const nodes = db.prepare("SELECT * FROM nodes").all();
  let facts = 0, entities = 0, resig = 0;
  const tx = db.transaction(() => {
    for (const n of nodes) {
      if (n.memory_id && n.memory_id !== "" && n.memory_id !== "live") {
        const sig = (n.signature || "").startsWith("fact:") ? n.signature : uniqueSig(db, `fact:${deriveSlug(n.fact || ent.labelOf(n.signature))}`);
        if (sig !== n.signature) { db.prepare("UPDATE nodes SET signature=? WHERE id=?").run(sig, n.id); resig += 1; }
        db.prepare("UPDATE nodes SET kind='fact' WHERE id=?").run(n.id);
        facts += 1;
      } else {
        db.prepare("UPDATE nodes SET kind='entity', memory_id='' WHERE id=?").run(n.id);
        entities += 1;
      }
    }
  });
  tx();
  const restored = repairGraph(db);
  return { facts, entities, resignatured: resig, entity_hubs_restored: restored };
}

// ---- INGEST -----------------------------------------------------------------
async function ingestHarness(db, file, prune, asOf) {
  const raw = prof("ingest.parse", () => JSON.parse(fs.readFileSync(file, "utf8")));
  const mems = Array.isArray(raw) ? raw : (raw.memories || []);
  const now = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
  // Preload existing memory_id -> {id,fact,salience,notes} ONCE (first-wins by id, matching
  // the previous unordered byMem.get). Re-confirming the full harness is the common case, so
  // the old per-memory prepared.get + unconditional salience UPDATE made ingest O(total store)
  // every checkpoint (measured 11.3s of pure no-op writes at ~17k mems). We now skip writes for
  // fully-unchanged memories — bit-identical end state, cost falls to O(changed). The in-memory
  // `ex` row is mutated on each write so a later duplicate memory_id sees prior tx state,
  // preserving the old transaction-visibility semantics.
  const exByMem = new Map();
  for (const r of db.prepare("SELECT id, memory_id, fact, salience, notes FROM nodes WHERE memory_id<>'' AND memory_id<>'live' ORDER BY id").all()) {
    if (!exByMem.has(r.memory_id)) exByMem.set(r.memory_id, r);
  }
  const delVec = db.prepare("DELETE FROM vec_nodes WHERE rowid=?");
  const updChanged = db.prepare("UPDATE nodes SET fact=?, salience=?, text='', notes=CASE WHEN notes='archive' THEN NULL ELSE notes END WHERE id=?");
  const updRevive = db.prepare("UPDATE nodes SET salience=?, notes=NULL WHERE id=?");
  const updSal = db.prepare("UPDATE nodes SET salience=? WHERE id=?");
  const insNode = db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
        VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`);
  const res = { harness_count: mems.length, created: 0, refreshed: 0, pruned: 0 };
  const harnessIds = new Set(mems.map((m) => m.id || m.memory_id).filter(Boolean));
  const tx = db.transaction(() => {
    for (const m of mems) {
      const mid = m.id || m.memory_id; if (!mid) continue;
      const fact = String(m.fact || "").replace(UNTRUSTED, "").trim();
      const category = m.category || "fact";
      const ex = exByMem.get(mid);
      if (ex) {
        const newFact = fact || ex.fact;
        if (newFact !== ex.fact) {
          // BUG-FIX: text changed for an existing memory — its stored vector is now stale.
          // Drop the vec row + text so the nightly embed-missing re-embeds it (keeps
          // vector ↔ text in sync). Also REVIVE a re-confirmed Tier-3 archive node back to
          // the active tier: re-ingestion by the source of truth is a strong reactivation
          // signal, so it earns its way out of the keyword-only bookshelf.
          delVec.run(BigInt(ex.id));
          updChanged.run(newFact, category, ex.id);
          ex.fact = newFact; ex.salience = category; if (ex.notes === "archive") ex.notes = null;
        } else if (ex.notes === "archive") {
          // re-confirmed but text unchanged: still revive from archive (re-embed via missing).
          updRevive.run(category, ex.id);
          ex.salience = category; ex.notes = null;
        } else if (ex.salience !== category) {
          updSal.run(category, ex.id);
          ex.salience = category;
        }
        // else: fully unchanged (fact, salience, not archived) -> SKIP the no-op write.
        res.refreshed += 1; continue;
      }
      const cls = CAT2CLASS[category] || "semantic";
      const sig = uniqueSig(db, `fact:${deriveSlug(fact)}`);
      const id = nextId(db);
      insNode.run(id, sig, mid, "fact", cls, category, INIT[cls], now, now, now, "harness-ingest", fact, "");
      exByMem.set(mid, { id, memory_id: mid, fact, salience: category, notes: "harness-ingest" });
      res.created += 1;
    }
    if (prune) {
      const stale = db.prepare("SELECT id, signature, memory_id FROM nodes WHERE kind='fact' AND memory_id<>''").all().filter((n) => !harnessIds.has(n.memory_id));
      for (const n of stale) {
        db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id, now, "pruned: left harness");
        // Delete the node's EDGES too. Without this, a sequence/supersedes/related_to edge
        // pointing at this pruned fact is left dangling, and the next repairGraph pass used
        // to resurrect the endpoint as a blank entity stub (the sequence-edge corruption).
        db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
        db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
        db.prepare("DELETE FROM vec_archive WHERE rowid=?").run(BigInt(n.id));
        db.prepare("DELETE FROM detail_of WHERE detail_sig=? OR gist_sig=?").run(n.signature, n.signature);
        db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
        res.pruned += 1;
      }
    }
  });
  prof(`ingest.refreshLoop(mems=${mems.length})`, () => tx());
  prof("ingest.repairGraph", () => repairGraph(db));
  // NOTE: embedding is intentionally NOT done here. New facts are embedded once-per-day
  // by the nightly pass (weave embeds any node missing a vec row, incrementally), so
  // ingest stays O(new) instead of re-embedding the whole store on every memory write.
  const dbIds = new Set(db.prepare("SELECT memory_id FROM nodes WHERE memory_id<>''").all().map((r) => r.memory_id));
  res.missing = mems.map((m) => m.id || m.memory_id).filter((x) => x && !dbIds.has(x));
  res.complete = res.missing.length === 0;
  return res;
}

function verifySync(db, file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const mems = Array.isArray(raw) ? raw : (raw.memories || []);
  const dbIds = new Set(db.prepare("SELECT memory_id FROM nodes WHERE memory_id<>''").all().map((r) => r.memory_id));
  const missing = mems.map((m) => m.id || m.memory_id).filter((x) => x && !dbIds.has(x));
  return { harness_count: mems.length, memory_ids_in_db: dbIds.size, missing, complete: missing.length === 0 };
}

// ---- SCHEMA-ACCELERATED CONSOLIDATION (neuroscience: Tse/Morris schema effect) ----
// A fact that attaches to an ESTABLISHED *specific* entity schema (a topic/person/system many
// related facts point to) consolidates faster and decays slower than an isolated fact. We measure
// "schema fit" as the establishment of the strongest entity the fact mentions — but EXCLUDING
// ubiquitous connectors (entities mentioned by a large fraction of all facts, e.g. the user
// themselves or their team), which carry no discriminating schema signal. Normalized 0..1.
const SCHEMA_FULL = 6;            // entity mentioned by >=6 *specific* facts = fully-established schema
const SCHEMA_UBIQUITOUS = 0.20;   // entities mentioned by > this fraction of facts are generic connectors
const SCHEMA_HALFLIFE_BONUS = 0.6; // up to +60% half-life for a fully schema-embedded fact
// NOTE: salient is an IMPORTANCE class (Sev1/2, security, exec decision), set at encoding
// (category 'decision') or by AGENT content-elevation during the dream — never auto-earned by
// reactivation frequency. Repetition makes facts durable (semantic), not important.

function computeSchemaFit(db) {
  const factCount = db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT}`).get().c || 1;
  const ubiqCut = Math.max(8, Math.ceil(SCHEMA_UBIQUITOUS * factCount));
  const entDeg = new Map();
  for (const r of db.prepare("SELECT dst FROM edges WHERE rel='mentions'").all()) entDeg.set(r.dst, (entDeg.get(r.dst) || 0) + 1);
  const byFact = new Map();
  for (const r of db.prepare("SELECT src, dst FROM edges WHERE rel='mentions'").all()) {
    const d = entDeg.get(r.dst) || 0;
    if (d >= ubiqCut) continue; // skip ubiquitous connectors (self/team/etc.)
    if (!byFact.has(r.src)) byFact.set(r.src, []);
    byFact.get(r.src).push(d);
  }
  const fit = new Map();
  for (const [f, degs] of byFact) fit.set(f, Math.min(1, Math.max(0, ...degs) / SCHEMA_FULL));
  return fit;
}
// connectedness-weighted promotion threshold: 3 (isolated) -> 1 (fully schema-fit)
const promoThreshold = (schemaNorm) => Math.max(1, Math.round(3 - 2 * schemaNorm));

// ---- DREAM core: decay + auto-reactivate + evaporate + housekeeping ----------
function dreamCore(db, flags) {
  const now = flags["as-of"] ? new Date(flags["as-of"]) : new Date(Date.now() + (Number(flags["advance-days"]) || 0) * 86400000);
  const nowIso = now.toISOString();
  const runId = flags["run-id"] || `dream-${nowIso.slice(0, 10)}`;
  const lastDream = getMeta(db, "last_dream") || "1970-01-01T00:00:00.000Z";
  const journal = [];
  const J = (op, sig, reason) => journal.push({ dreamed_at: nowIso, run_id: runId, op, memory_id: "", signature: sig || "", category: "", original_fact: "", result_fact: "", reason });

  // Active facts = Tier 1+2 (embedded, in graph). Archived (Tier 3) facts are inert cold
  // storage: skipped by decay/weave so they cost no nightly work, reachable only by keyword.
  const facts = db.prepare("SELECT * FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all();
  const bp = budgetParams(facts.length);
  const schema = prof("dreamCore.schemaFit", () => computeSchemaFit(db));

  // DECAY facts. Half-life accelerated under budget pressure, EXTENDED by schema fit
  // (schema-embedded facts persist; islands fade fastest).
  prof("dreamCore.decayFacts", () => {
  for (const n of facts) {
    const sf = schema.get(n.signature) || 0;
    const H = (HALFLIFE[n.class] || HALFLIFE.episodic) * T.forgetMultiplier * (1 + SCHEMA_HALFLIFE_BONUS * sf) / bp.decayAccel;
    const dDays = Math.max(0, (now.getTime() - Date.parse(n.last_decayed || n.first_seen || nowIso)) / 86400000);
    db.prepare("UPDATE nodes SET strength=?, last_decayed=? WHERE id=?").run(clamp01(n.strength * Math.pow(2, -dDays / H)), nowIso, n.id);
  }
  });
  // EDGE decay. Write only when the value actually changes: unit-decay relations
  // (mentions, supersedes -> factor 1.0) multiply to the identical weight, so the old
  // unconditional UPDATE rewrote all ~49k mention edges every night as a pure no-op
  // (measured ~1.1s growing with edge count). write-iff-changed is bit-identical
  // (x*1.0===x for finite x; malformed weights still normalize since the result differs).
  prof("dreamCore.decayEdges", () => {
  const updW = db.prepare("UPDATE edges SET weight=? WHERE rowid=?");
  for (const e of db.prepare("SELECT rowid, rel, weight FROM edges").all()) {
    const f = EDGE_DECAY[e.rel] || EDGE_DECAY.default;
    const nw = clamp01(e.weight * f);
    if (nw !== e.weight) updW.run(nw, e.rowid);
  }
  });
  J("keep", "", `DECAY: ${facts.length} facts (pressure=${bp.pressure}, decayAccel=${bp.decayAccel}, schema-aware); edges`);

  // AUTO-REACTIVATE: a fact reappears when a NEW fact (since last dream) shares one of its
  // entities. Each fact reactivates AT MOST ONCE per run (reactivations counts NIGHTS re-seen,
  // not co-mentions) — so a tier promotion needs persistence across runs, not one busy night.
  // Schema-supported reactivation boosts more (and promotes at a lower threshold).
  const newFacts = db.prepare(`SELECT * FROM nodes WHERE ${ACTIVE_FACT} AND first_seen > ?`).all(lastDream);
  const newIdSet = new Set(newFacts.map((n) => n.id));
  const triggers = new Map(); // sibling fact id -> count of distinct new facts that re-cued it
  for (const nf of newFacts) {
    const ents = db.prepare("SELECT dst FROM edges WHERE src=? AND rel='mentions'").all(nf.signature).map((r) => r.dst);
    const cued = new Set();
    for (const e of ents) {
      for (const s of db.prepare("SELECT n.id FROM edges g JOIN nodes n ON n.signature=g.src WHERE g.dst=? AND g.rel='mentions' AND n.kind='fact'").all(e)) {
        if (s.id !== nf.id && !newIdSet.has(s.id)) cued.add(s.id);
      }
    }
    for (const id of cued) triggers.set(id, (triggers.get(id) || 0) + 1);
  }
  const reentered = new Set();
  let promoSem = 0;
  for (const [id, nTrig] of triggers) {
    const s = db.prepare("SELECT * FROM nodes WHERE id=?").get(id);
    if (!s) continue;
    const sf = schema.get(s.signature) || 0;
    const reacts = s.reactivations + 1; // exactly one per run
    let cls = s.class;
    // Repetition builds DURABILITY: episodic -> semantic (schema-accelerated). It does NOT
    // confer IMPORTANCE: there is no auto path to 'salient' — salient is an importance tag set
    // at encoding (category 'decision') or by agent content-elevation (Sev1/2, security, exec
    // decision) during the dream judgment phase. Frequency != criticality.
    if (cls === "episodic" && reacts >= promoThreshold(sf)) {
      cls = "semantic"; promoSem += 1;
      J("reinforce", s.signature, `PROMOTE episodic->semantic (reacts=${reacts}, schema=${sf.toFixed(2)}, thresh=${promoThreshold(sf)})`);
    }
    // boost scales with schema fit and (capped) number of distinct re-cues this run
    const boost = 0.10 * (1 + 0.5 * sf) * Math.min(1.5, 1 + 0.15 * (nTrig - 1));
    db.prepare("UPDATE nodes SET strength=?, reactivations=?, class=?, last_reactivated=? WHERE id=?").run(clamp01(s.strength + boost), reacts, cls, nowIso, s.id);
    reentered.add(s.signature);
  }
  if (reentered.size) J("reinforce", "", `REACTIVATE: ${reentered.size} facts via ${newFacts.length} new subjects; promoted ${promoSem} ->semantic`);

  // EVAPORATE faded facts (decay-gated; not new AND not reactivated this run).
  // Episodic below the (pressure-adaptive) threshold always; weak re-derivable semantic only under pressure.
  // In TIERED mode we never physically delete a fact here — demotion (below) moves
  // overflow to Tier 3 instead, so faded facts stay recoverable by keyword. Archive nodes
  // are always excluded (they are inert and must never be deleted by decay).
  const protectedSigs = new Set([...newFacts.map((n) => n.signature), ...reentered]);
  let evap = 0, evapSem = 0;
  if (!TIERED()) {
    for (const n of db.prepare(`SELECT * FROM nodes WHERE ${ACTIVE_FACT} AND class='episodic' AND strength < ?`).all(bp.forgetThreshold)) {
      if (protectedSigs.has(n.signature)) continue;
      db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id || "", nowIso, `S=${n.strength.toFixed(3)}<${bp.forgetThreshold} episodic`);
      db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
      db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
      J("evaporate", n.signature, `S=${n.strength.toFixed(3)} episodic (threshold ${bp.forgetThreshold})`);
      evap += 1;
    }
    if (bp.semanticFade > 0) {
      for (const n of db.prepare(`SELECT * FROM nodes WHERE ${ACTIVE_FACT} AND class='semantic' AND strength < ?`).all(bp.semanticFade)) {
        if (protectedSigs.has(n.signature)) continue;
        db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id || "", nowIso, `S=${n.strength.toFixed(3)}<${bp.semanticFade} weak-semantic (over budget)`);
        db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
        db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
        db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
        J("evaporate", n.signature, `S=${n.strength.toFixed(3)} weak-semantic over-budget`);
        evapSem += 1;
      }
    }
  }

  // HARD CEILING (faithful to Scout's native harness: a physical max of ENTRY_MAX entries).
  // Decay/evaporate above are the graceful path; in batch/headless runs there is no agent to
  // perform merges, so we deterministically evict the weakest facts down to the cap. Salient
  // is protected first, then this-run-new/reactivated, then lowest strength is dropped.
  // SKIPPED in TIERED mode: there the Tier-2 demotion (below) bounds the embedded set by
  // MOVING overflow to Tier 3, never deleting — so the physical ENTRY_MAX delete must not run.
  let evapCap = 0;
  const factCountNow = () => db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT}`).get().c;
  if (!TIERED() && factCountNow() > ENTRY_MAX) {
    const over = factCountNow() - ENTRY_MAX;
    // Facts that some other fact SUPERSEDES are the preserved "from" value of a correction —
    // protect them so the transition stays answerable (empty set when supersede is unused).
    const supTargets = new Set(db.prepare("SELECT dst FROM edges WHERE rel='supersedes'").all().map((r) => r.dst));
    const cands = db.prepare(
      `SELECT * FROM nodes WHERE ${ACTIVE_FACT} ORDER BY (class='salient') ASC, strength ASC, last_decayed ASC`
    ).all();
    const evict = [];
    // pass 1: evict weakest non-protected, non-salient, non-supersede-target
    for (const n of cands) { if (evict.length >= over) break; if (protectedSigs.has(n.signature) || n.class === "salient" || supTargets.has(n.signature)) continue; evict.push(n); }
    // pass 2 (rare): still over → drop protected/salient weakest, since the cap is physical
    if (evict.length < over) { for (const n of cands) { if (evict.length >= over) break; if (evict.includes(n)) continue; evict.push(n); } }
    for (const n of evict) {
      db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id || "", nowIso, `evicted: over hard cap ${ENTRY_MAX} (S=${(n.strength||0).toFixed(3)})`);
      db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
      db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
      db.prepare("DELETE FROM detail_of WHERE detail_sig=? OR gist_sig=?").run(n.signature, n.signature);
      J("evaporate", n.signature, `evicted over hard cap ${ENTRY_MAX}`);
      evapCap += 1;
    }
  }

  // TIER 2 CAP: demote the weakest EMBEDDED facts to Tier 3 (raw keyword archive) when
  // the graph+vector store exceeds TIER2_MAX. Demotion ≠ deletion: the node + its raw
  // fact text stay in the db (notes='archive'), but it loses its vector and graph edges,
  // so it no longer costs nightly weave/embed work and is reachable only by keyword
  // search. Protect salient + gist + this-run-new/reactivated; demote details/oldest
  // first. This is what keeps cost bounded while "remembering everything".
  let demoted = 0;
  if (TIER2_MAX > 0) {
    const embeddedCount = () => db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT}`).get().c;
    if (embeddedCount() > TIER2_MAX) {
      const over = embeddedCount() - TIER2_MAX;
      const supTargets = new Set(db.prepare("SELECT dst FROM edges WHERE rel='supersedes'").all().map((r) => r.dst));
      // Demotion priority (keep the active set bounded NO MATTER WHAT, like a real
      // associative store): detail first, then weak/old episodic, then weak/old semantic,
      // and finally — only if still over — the weakest/oldest GIST and SALIENT too. Even
      // important old memories can fade from active recall to the keyword "bookshelf"
      // (still findable, just not in the hot RAG set). Hard-protect ONLY this-run-new and
      // supersede targets (needed for the current operation). This guarantees the cap holds
      // so nightly cost stays bounded — the C4 accumulation fix.
      const cands = db.prepare(
        `SELECT * FROM nodes WHERE ${ACTIVE_FACT} ORDER BY (notes='detail') DESC, (class='salient') ASC, (notes='gist') ASC, strength ASC, last_decayed ASC`
      ).all();
      const isHardProtected = (n) => protectedSigs.has(n.signature) || supTargets.has(n.signature);
      const demote = [];
      // pass 1: prefer to keep salient/gist — demote everything else first
      for (const n of cands) {
        if (demote.length >= over) break;
        if (isHardProtected(n) || n.class === "salient" || n.notes === "gist") continue;
        demote.push(n);
      }
      // pass 2: still over cap (salient/gist alone exceed it) — demote the weakest/oldest
      // of those too, so the embedded set is ALWAYS bounded. Only new/supersede stay.
      if (demote.length < over) {
        const picked = new Set(demote.map((n) => n.id));
        for (const n of cands) {
          if (demote.length >= over) break;
          if (picked.has(n.id) || isHardProtected(n)) continue;
          demote.push(n); picked.add(n.id);
        }
      }
      // Atomic: a crash mid-demotion must not leave an active node without its vector/edges.
      const txD = db.transaction(() => {
        for (const n of demote) {
          db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
          // MOVE the embedding to vec_archive (principle 1 pay-once / principle 3 demote-
          // don't-delete): the cold fact stays reachable by SIMILARITY (recall.js tier-2c
          // queries vec_archive secondarily, capped below active seeds), while leaving
          // vec_nodes — the only table any nightly KNN touches — bounded (principle 2).
          const rid = BigInt(n.id);
          const blob = storedVecBlob(db, n.id);
          db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(rid);
          if (blob) {
            db.prepare("DELETE FROM vec_archive WHERE rowid=?").run(rid);
            db.prepare("INSERT INTO vec_archive(rowid, embedding) VALUES (?, ?)").run(rid, blob);
          }
          db.prepare("UPDATE nodes SET notes='archive', last_decayed=? WHERE id=?").run(nowIso, n.id);
          J("evaporate", n.signature, `demoted to Tier3 archive (over Tier2 cap ${TIER2_MAX})`);
          demoted += 1;
        }
      });
      txD();
    }
  }

  // ENTITY HUB PRUNE (bounds vector-index growth — audit C3). Entity hubs are embedded
  // and never decay, so over a long run distinct entities could grow the KNN cost without
  // bound. Drop hubs that no active fact mentions anymore (degree 0 into them): they are
  // dead scaffolding. Cheap, and keeps the embedded set ~= active facts + live entities.
  let prunedHubs = 0;
  {
    const liveDst = new Set(db.prepare("SELECT DISTINCT dst FROM edges WHERE rel='mentions'").all().map((r) => r.dst));
    const hubs = db.prepare("SELECT id, signature FROM nodes WHERE kind='entity'").all();
    const txP = db.transaction(() => {
      for (const h of hubs) {
        if (liveDst.has(h.signature)) continue;
        db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(h.signature, h.signature);
        db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(h.id));
        db.prepare("DELETE FROM nodes WHERE id=?").run(h.id);
        prunedHubs += 1;
      }
    });
    txP();
  }

  // HOUSEKEEPING
  const cut60 = new Date(now.getTime() - 60 * 86400000).toISOString();
  const cut30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const tRem = db.prepare("DELETE FROM tombstones WHERE forgotten_at < ?").run(cut60).changes;
  const eRem = db.prepare("DELETE FROM edges WHERE weight < 0.10").run().changes;
  const jRem = db.prepare("DELETE FROM dream_journal WHERE dreamed_at < ?").run(cut30).changes;

  repairGraph(db);
  setMeta(db, "last_dream", nowIso);
  const final = db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT}`).get().c;
  const archivedNow = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND notes='archive'").get().c;
  const after = budgetParams(final);
  const overBy = Math.max(0, final - ENTRY_TARGET);
  const summary = `RUN ${runId}: active facts ${facts.length}->${final} (target ${ENTRY_TARGET}, status ${after.status}); reactivated ${reentered.size} (promoted ${promoSem}->sem), evaporated ${evap}+${evapSem}sem, demoted ${demoted}, pruned ${prunedHubs} hubs; archive=${archivedNow}.`;
  J("keep", "", summary);
  const ins = db.prepare(`INSERT INTO dream_journal(dreamed_at,run_id,op,memory_id,signature,category,original_fact,result_fact,reason)
    VALUES (@dreamed_at,@run_id,@op,@memory_id,@signature,@category,@original_fact,@result_fact,@reason)`);
  db.transaction(() => journal.forEach((j) => ins.run(j)))();
  const result = { runId, summary, facts: final, archived: archivedNow, target: ENTRY_TARGET, max: ENTRY_MAX, status: after.status, pressure: after.pressure, evaporated_episodic: evap, evaporated_semantic: evapSem, evicted_over_cap: evapCap, demoted_to_tier3: demoted, pruned_hubs: prunedHubs, reactivated: reentered.size, promoted_semantic: promoSem };
  if (overBy > 0) result.action_needed = `Still ${overBy} over target. Run 'consolidate' and merge the reported clusters (agent) to reduce entry count.`;
  return result;
}

// ---- WEAVE: connect every fact (zero islands) -------------------------------
// Build a forms-aware entity vocab: label-derived forms (formsFor) UNION any extra
// surface forms stored on the hub node's text column (set by LLM/corpus extraction
// and alias folding), so abbreviations and first-name aliases still match.
function vocabWithForms(db) {
  const rows = db.prepare("SELECT signature, text FROM nodes WHERE kind='entity'").all();
  return rows.map((r) => {
    const base = ent.formsFor(r.signature);
    const extra = (r.text || "").split("|").map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3);
    return { sig: r.signature, type: ent.typeOf(r.signature), forms: [...new Set([...base, ...extra])] };
  });
}

// Fold an alias entity hub into a canonical one: move its surface forms onto the
// canonical hub, repoint its mention edges, then delete the alias node + vec row.
function mergeEntityHub(db, canonicalSig, aliasSig) {
  if (canonicalSig === aliasSig) return;
  const can = db.prepare("SELECT id, text FROM nodes WHERE signature=? AND kind='entity'").get(canonicalSig);
  const al = db.prepare("SELECT id, text FROM nodes WHERE signature=? AND kind='entity'").get(aliasSig);
  if (!can || !al) return;
  const forms = new Set([...(can.text || "").split("|"), ...(al.text || "").split("|"), ent.labelOf(aliasSig)]
    .map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 3));
  db.prepare("UPDATE nodes SET text=? WHERE id=?").run([...forms].join("|"), can.id);
  // repoint mention edges dst alias -> canonical (dedup), drop self/dupes
  for (const e of db.prepare("SELECT rowid, src, rel FROM edges WHERE dst=?").all(aliasSig)) {
    const dup = db.prepare("SELECT 1 FROM edges WHERE src=? AND rel=? AND dst=?").get(e.src, e.rel, canonicalSig);
    if (dup || e.src === canonicalSig) db.prepare("DELETE FROM edges WHERE rowid=?").run(e.rowid);
    else db.prepare("UPDATE edges SET dst=? WHERE rowid=?").run(canonicalSig, e.rowid);
  }
  db.prepare("DELETE FROM edges WHERE src=?").run(aliasSig);
  db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(al.id));
  db.prepare("DELETE FROM nodes WHERE id=?").run(al.id);
}

async function weave(db, opts) {
  const now = (opts && opts.asOf) ? new Date(opts.asOf).toISOString() : new Date().toISOString();
  const K = (opts && opts.k) || 3;
  const SIM = (opts && opts.sim) || 0.45;
  const llm = (opts && opts.llm) ? getLLM(llmEnv()) : { available: false };

  // INCREMENTAL WEAVE (env MEMORY_INCREMENTAL_WEAVE=1): brain-faithful — only process
  // NEW facts (first_seen > last_weave) and DIRTY ones (merge survivors whose text
  // changed: gist updated since last_weave). Existing facts already have their entity
  // and sibling edges; a new fact AMENDS its old neighbors by linking to them
  // (recall walks edges bidirectionally, so new->old suffices), and a newly-created
  // entity hub re-links only the old facts that textually mention it (scoped, not O(N)).
  // This makes nightly cost scale with NEW material, not total store size. Default off
  // (full re-derivation) preserves exact legacy behavior.
  const incremental = (opts && opts.incremental) || T.incrementalWeave;
  const lastWeave = incremental ? (getMeta(db, "last_weave") || "1970-01-01T00:00:00.000Z") : "1970-01-01T00:00:00.000Z";
  const isToWeave = (n) => !incremental
    || (n.first_seen && n.first_seen > lastWeave)
    || (n.notes === "gist" && n.last_reactivated && n.last_reactivated > lastWeave);

  // 1) entity vocab from existing entity hubs
  let vocab = vocabWithForms(db);

  // 2) extract new entities from facts -> create hubs. SELF-BOOTSTRAPPING: the corpus
  //    extractor learns the entity vocabulary from recurrence (no seed/deny lists), so a
  //    candidate becomes a hub only if it recurs across facts (or has a strong email signal).
  //    When an LLM is enabled it ADDS a typed read (catches single-name principals and
  //    types orgs/places correctly); the two are unioned for best recall.
  const allActive = db.prepare("SELECT id, signature, fact, first_seen, notes, last_reactivated FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all();
  const factRows = incremental ? allActive.filter(isToWeave) : allActive;
  const haveSig = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  let newHubs = 0;
  const corpusEnts = prof(`weave.extractCorpus(facts=${factRows.length})`, () => ent.extractEntitiesCorpus(factRows.map((f) => f.fact || ""), { minFacts: (opts && opts.minFacts) || 2 }));
  let llmEnts = [];
  if (llm.available && factRows.length) {
    try { llmEnts = await profA(`weave.extractEntitiesLLM(facts=${factRows.length})`, () => judge.extractEntitiesLLM(factRows.map((f) => f.fact || ""), llm)); }
    catch (e) { process.stderr.write(`[weave] llm extract failed: ${e.message}\n`); }
  }
  const allEnts = new Map();
  for (const e of [...corpusEnts, ...llmEnts]) {
    if (!allEnts.has(e.sig)) allEnts.set(e.sig, { sig: e.sig, type: e.type, forms: new Set(e.forms) });
    else e.forms.forEach((f) => allEnts.get(e.sig).forms.add(f));
  }
  const newHubSigs = [];
  const tx1 = db.transaction(() => {
    for (const e of allEnts.values()) {
      if (haveSig.has(e.sig)) continue;
      const id = nextId(db);
      const formsStr = [...e.forms].filter((f) => f.length >= 3).join("|");
      db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
        VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(id, e.sig, "", "entity", "semantic", "semantic", 0.5, now, now, now, "weave-extract", "", formsStr);
      haveSig.add(e.sig); newHubs += 1; newHubSigs.push(e.sig);
    }
  });
  tx1();

  // 2.5) CANONICALIZATION (LLM): fold alias hubs ("Jamie" -> "person:jamie-chen",
  //      "SF" -> "place:san-francisco") into one canonical hub before linking.
  //      In incremental mode, only run when NEW hubs appeared (no new entities => no new
  //      aliases to reconcile) — bounds the nightly LLM cost.
  let aliasesMerged = 0;
  if (llm.available && (!incremental || newHubs > 0)) {
    const hubs = db.prepare("SELECT signature FROM nodes WHERE kind='entity'").all()
      .map((r) => ({ sig: r.signature, label: ent.labelOf(r.signature) }));
    let groups = [];
    try { groups = await profA(`weave.canonicalizeLLM(hubs=${hubs.length})`, () => judge.canonicalizeLLM(hubs, llm)); }
    catch (e) { process.stderr.write(`[weave] llm canon failed: ${e.message}\n`); }
    const tx = db.transaction(() => {
      for (const g of groups) for (const a of g.aliases) { mergeEntityHub(db, g.canonical, a); aliasesMerged += 1; }
    });
    prof(`weave.canonApply(groups=${groups.length})`, () => tx());
  }
  vocab = vocabWithForms(db);

  // 3) co-mention edges fact -> entity. For toWeave (new/dirty) facts: link all entities
  //    they mention. AMENDMENT: when new hubs were created, also link the EXISTING facts
  //    that textually mention them (scoped to those hubs' forms — an index-free LIKE over
  //    active facts, bounded by #new-hubs, not a full O(N) re-scan).
  const hasEdge = db.prepare("SELECT 1 FROM edges WHERE src=? AND dst=? AND rel=?");
  const addEdge = (src, rel, dst, w) => { if (src === dst) return; if (!hasEdge.get(src, dst, rel)) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(src, rel, dst, w, now, now); };
  let mentionEdges = 0;
  const tx2 = db.transaction(() => {
    for (const f of factRows) {
      for (const sig of ent.coMentions(f.fact || "", vocab)) { addEdge(f.signature, "mentions", sig, 0.8); mentionEdges += 1; }
    }
    if (incremental && newHubSigs.length) {
      const newVocab = vocabWithForms(db).filter((v) => newHubSigs.includes(v.sig));
      const toWeaveSigs = new Set(factRows.map((f) => f.signature));
      for (const f of allActive) {
        if (toWeaveSigs.has(f.signature)) continue; // already linked above
        for (const sig of ent.coMentions(f.fact || "", newVocab)) { addEdge(f.signature, "mentions", sig, 0.8); mentionEdges += 1; }
      }
    }
  });
  prof(`weave.mentionEdges(factRows=${factRows.length},vocab=${vocab.length})`, () => tx2());

  // 4) embed any ACTIVE node missing a vec row (new entity hubs / facts). Tier-3 archive
  //    nodes are intentionally un-embedded — never re-embed them (that's what makes them
  //    cheap), so they are excluded here.
  const missing = db.prepare("SELECT id FROM nodes WHERE id NOT IN (SELECT rowid FROM vec_nodes) AND (notes IS NULL OR notes<>'archive')").all().map((r) => r.id);
  if (missing.length) await profA(`weave.reembed(missing=${missing.length})`, () => reembed(db, missing));
  // 5) vector sibling links fact <-> fact, CORROBORATED.
  //    shared entity (co-mention overlap) -> related_to (trusted).
  //    else high similarity only      -> similar_to  (low-confidence suggestion).
  //    pure low-sim proximity is NOT committed (no fabrication).
  const HIGH = (opts && opts.high) || 0.62;
  const mentionsOf = (sig) => new Set(db.prepare("SELECT dst FROM edges WHERE src=? AND rel='mentions'").all(sig).map((r) => r.dst));
  let relatedEdges = 0, similarEdges = 0;
  // Sibling linking runs only for toWeave (new/dirty) facts: each links to its k nearest
  // among ALL active facts, AMENDING those old neighbors (recall traverses edges
  // bidirectionally, so a single new->old edge connects both ways). Old facts already
  // hold their sibling edges from the night they were woven.
  const factNodes = incremental
    ? db.prepare("SELECT id, signature, fact, first_seen, notes, last_reactivated FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all().filter(isToWeave)
    : db.prepare("SELECT id, signature, fact FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all();
  await profA(`weave.siblingLink(n=${factNodes.length})`, async () => {
  for (const f of factNodes) {
    const fe = mentionsOf(f.signature);
    const qv = await queryVec(db, f);
    const nbrs = db.prepare(`SELECT n.signature s, n.kind k, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>?`).all(qv, K + 8, f.id);
    let added = 0;
    for (const nb of nbrs) {
      if (nb.k !== "fact" || added >= K) continue;
      const sim = 1 - nb.d;
      const shared = [...mentionsOf(nb.s)].some((x) => fe.has(x));
      if (shared && sim >= SIM) { addEdge(f.signature, "related_to", nb.s, Number(sim.toFixed(3))); relatedEdges += 1; added += 1; }
      else if (sim >= HIGH) { addEdge(f.signature, "similar_to", nb.s, Number(sim.toFixed(3))); similarEdges += 1; added += 1; }
    }
  }
  });

  // 5.5) SUPERSEDE-aware consolidation (opt-in via --supersede). A CORRECTION is a DOUBLE
  // signal: it reactivates the prior fact AND overrides it, so the corrective fact should
  // consolidate MORE strongly than a plain restatement, while the superseded "from" value is
  // PRESERVED (pinned against cap-eviction) so the transition stays answerable. Mirrors how a
  // human remembers a correction more vividly than the steady state it replaced.
  // ---- Shared same-subject scaffold (SUPERSEDE 5.5 + SEQUENCE 5.6) ----------------
  // Both steps link a NEW fact to a prior version of the SAME standing statement; they differ
  // only in the rule (supersede = a correction that demotes the prior value; sequence = a
  // neutral temporal evolution that preserves both). The corpus-frequency tables are computed
  // ONCE here — entFreq scans ALL ~1M mention edges at 50k, so it must not run twice — and the
  // sequence step is ALWAYS-ON, so the scaffold is hoisted out of the SUP-gated block.
  const toks = (s) => new Set(ent.normalize(s || "").split(" ").filter((w) => w.length > 4 && !STOPW.has(w)));
  const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
  const scopeOf = (s) => { const m = String(s || "").match(/^\s*\[([^\]]{1,40})\]/); return m ? ent.normalize(m[1]) : ""; };
  const subjFull = db.prepare("SELECT id, signature, fact, first_seen, strength, class, notes, last_reactivated FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all();
  const subjBySig = new Map(subjFull.map((r) => [r.signature, r]));
  // Entity-hub corpus frequency. A genuine same-subject restatement shares a SPECIFIC entity
  // (a named person/account/project that tags few facts), NOT a generic scope/role tag
  // (e.g. [executive-team], [principal]) shared by hundreds of unrelated standing-intent
  // facts. Sharing a generic hub/scope is the exact false-corroboration that chained
  // "operations cadence" -> "treasury FY27" (different topics, same voice) into bogus chains.
  // *_MAX scale with the active corpus.
  const entFreq = new Map();
  for (const r of db.prepare("SELECT dst FROM edges WHERE rel='mentions'").all()) entFreq.set(r.dst, (entFreq.get(r.dst) || 0) + 1);
  const scopeFreq = new Map();
  for (const r of subjFull) { const s = scopeOf(r.fact); if (s) scopeFreq.set(s, (scopeFreq.get(s) || 0) + 1); }
  const SPECIFIC_MAX = Math.max(4, Math.round(0.01 * subjFull.length));
  const SCOPE_MAX = Math.max(4, Math.round(0.02 * subjFull.length));
  // A restatement/correction is always a NEW fact, so in incremental mode only SCAN toWeave
  // facts (the prior value is found among ALL active via subjBySig/KNN).
  const subjSource = incremental ? subjFull.filter(isToWeave) : subjFull;

  let supersedeEdges = 0;
  const SUP = (opts && opts.supersede) || T.supersede;
  if (SUP) await profA("weave.supersede", async () => {
    const CUE = /\b(correct(?:ion|ed|s)?|chang(?:e|ed|ing)?|updat(?:e|ed)?|revis(?:e|ed)?|no longer|instead of|rather than|supersed(?:e|ed|es)?|overrid(?:e|den|es)?|replac(?:e|ed|es)?|moved? (?:to|up|earlier|from)|push(?:ed)? (?:to|up|earlier)|now \w+ not)\b/i;
    for (const f of subjSource) {
      if (!f.fact || !CUE.test(f.fact)) continue;
      const fe = mentionsOf(f.signature);   // entity hubs (may be empty — e.g. single-name principals)
      const ft = toks(f.fact);              // content tokens
      const fScope = scopeOf(f.fact);
      const fScopeSpecific = fScope && (scopeFreq.get(fScope) || 0) <= SCOPE_MAX;
      const qv = await queryVec(db, f);
      const nbrs = db.prepare(`SELECT n.signature s, n.kind k, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 12) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>?`).all(qv, f.id);
      // Pick the BEST (most similar) qualifying predecessor, not the first one scanned, so a
      // loosely-related older neighbour can't grab the supersede link ahead of the true prior
      // version. A version is the SAME fact with a changed value -> high content overlap
      // (token-Jaccard >= .34) OR a shared SPECIFIC named entity OR a shared SPECIFIC scope
      // with some overlap; a single shared word (the old rule) is too weak and caused drift.
      let target = null, bestSim = -1;
      for (const nb of nbrs) {
        if (nb.k !== "fact") continue;
        const o = subjBySig.get(nb.s); if (!o) continue;
        const sim = 1 - nb.d;
        if (!(sim >= 0.5 && sim <= 0.96) || sim <= bestSim) continue;
        const older = Date.parse(o.first_seen || 0) < Date.parse(f.first_seen || 0);
        if (!older) continue;
        const ojac = jaccard(ft, toks(o.fact));
        const sharedSpecificEnt = fe.size && [...mentionsOf(nb.s)].some((x) => fe.has(x) && (entFreq.get(x) || 0) <= SPECIFIC_MAX);
        const sharedSpecificScope = fScopeSpecific && scopeOf(o.fact) === fScope && ojac >= 0.12;
        if (ojac >= 0.34 || sharedSpecificEnt || sharedSpecificScope) { target = o; bestSim = sim; }
      }
      if (!target || hasEdge.get(f.signature, target.signature, "supersedes")) continue;
      addEdge(f.signature, "supersedes", target.signature, 0.9);
      // corrective fact consolidates MORE strongly (override = high-signal event)
      const newClass = f.class === "episodic" ? "semantic" : f.class;
      db.prepare("UPDATE nodes SET strength=?, class=?, reactivations=reactivations+1, last_reactivated=? WHERE signature=?")
        .run(clamp01((f.strength || 0) + 0.18), newClass, now, f.signature);
      // the prior fact is re-cued by the correction but kept BELOW the current value
      db.prepare("UPDATE nodes SET strength=?, last_reactivated=? WHERE signature=?")
        .run(clamp01((target.strength || 0) + 0.05), now, target.signature);
      supersedeEdges += 1;
    }
  });

  // 5.6) SEQUENCE-aware lineage. A standing statement is RE-STATED across many days, and over
  // time it EVOLVES — a clause is added ("...treat the relationship reset as confirmed once
  // service stabilized and the remediation plan was accepted"). Unlike a supersede (a
  // correction that demotes the prior value), every version here is valid history, so we link
  // them with a NEUTRAL `sequence` edge (older -> newer) and demote nothing.
  //
  // Why this is the temporal-recall fix: the evolved DELTA is the lowest-cosine, lowest-
  // strength version of itself (its distinctive added clause makes it LESS similar to a generic
  // "what's the status" query), so it sits ~80 ranks below the bare restatements and KNN never
  // seeds it. But ANY bare restatement DOES rank high; recall.js then walks the sequence chain
  // from that hit and pulls the delta into the result — no date heuristic, no lexical anchor,
  // no privileged ranking. No correction CUE is required (a pure delta has none).
  //
  // The same-statement test is CORPUS-INDEPENDENT: an older fact whose content tokens are
  // strongly CONTAINED in this one, at high cosine, IS this statement at an earlier point in its
  // evolution. We deliberately do NOT use entity-rarity / scope / Jaccard heuristics here: those
  // were corpus-relative (a "specific" entity at 50k facts is a "common" one at 3k) and so made
  // chain-formation path-dependent — the nightly INCREMENTAL weave (small corpus) rejected the
  // very delta the offline full weave linked. They also reject true deltas by construction (a
  // delta's added clause drops Jaccard below 0.8, and hot subjects like "caldwell" never count as
  // "specific"). Containment + cosine alone is the whole signal; cohesion-checked to introduce no
  // cross-topic chains. CONTAINMENT (overlap coefficient = shared/min(|a|,|b|)) not Jaccard,
  // because the predecessor stays fully contained in the longer delta (~1.0) while Jaccard drops.
  //
  // Two refinements keep a standing statement's restatements in ONE connected chain instead of
  // fragmenting into disjoint shards (which strands a hit's far end):
  //  - KNN width SEQ_K is wide (40, not 12): a fact's immediate older predecessor would otherwise
  //    be crowded OUT of the candidate list by the many near-identical NEWER restatements of the
  //    same statement, so no link forms and the chain breaks.
  //  - we link to the CHRONOLOGICALLY-NEAREST qualifying older predecessor (max first_seen below
  //    f), not the max-cosine one, so the lineage is a clean linear walk; and the same-statement
  //    gate is shared>=3 AND (containment>=SEQ_CONTAIN OR cosine>=SEQ_SIM_HI) — the cosine-OR
  //    bridges day-to-day wording drift that momentarily drops containment just below the bar.
  let sequenceEdges = 0;
  const SEQ_K = 40;         // KNN candidate width (predecessor must be reachable among newer dups)
  const SEQ_CONTAIN = 0.8;  // older fact ~fully contained in the newer one (delta added a clause)
  const SEQ_SIM = 0.6;      // floor cosine to even consider a candidate
  const SEQ_SIM_HI = 0.85;  // cosine that alone proves same-statement (bridges containment drift)
  await profA("weave.sequence", async () => {
    for (const f of subjSource) {
      if (!f.fact) continue;
      const ft = toks(f.fact);
      const fTime = Date.parse(f.first_seen || 0);
      const qv = await queryVec(db, f);
      const nbrs = db.prepare(`SELECT n.signature s, n.kind k, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ${SEQ_K}) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>?`).all(qv, f.id);
      // Link to the chronologically-NEAREST strictly-OLDER version of the SAME statement (the
      // chain runs forward in time). shared>=3 (content tokens, len>4) prevents a trivially short
      // fact from false-linking on incidental overlap.
      let target = null, bestOlderTime = -1;
      for (const nb of nbrs) {
        if (nb.k !== "fact") continue;
        const o = subjBySig.get(nb.s); if (!o) continue;
        const sim = 1 - nb.d;
        if (sim < SEQ_SIM) continue;
        const oTime = Date.parse(o.first_seen || 0);
        if (!(oTime < fTime) || oTime <= bestOlderTime) continue;
        const ot = toks(o.fact);
        let shared = 0; for (const x of ot) if (ft.has(x)) shared++;
        if (shared < 3) continue;
        const containment = shared / Math.max(1, Math.min(ft.size, ot.size));
        if (containment < SEQ_CONTAIN && sim < SEQ_SIM_HI) continue;
        target = o; bestOlderTime = oTime;
      }
      if (!target) continue;
      if (hasEdge.get(target.signature, f.signature, "sequence") || hasEdge.get(f.signature, target.signature, "sequence")) continue;
      addEdge(target.signature, "sequence", f.signature, 0.8);
      sequenceEdges += 1;
    }
  });

  // 6) zero-island guarantee: any active fact still degree 0 -> link nearest as similar_to.
  //    Scans ALL active facts (not just toWeave): demotion of a neighbor can orphan an
  //    OLD fact, so the guarantee must cover the whole active set. Cheap — the KNN runs
  //    only for the (rare) actual islands.
  let rescued = 0;
  await profA(`weave.islandScan(active=${db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").get().c})`, async () => {
  const deg = degreeMap(db);
  const islandScan = db.prepare("SELECT id, signature, fact FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all();
  for (const f of islandScan) {
    if (deg.get(f.signature)) continue;
    const qv = await queryVec(db, f);
    const nb = db.prepare(`SELECT n.signature s, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 6) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>? AND n.kind='fact'`).all(qv, f.id)[0];
    if (nb) { addEdge(f.signature, "similar_to", nb.s, Number((1 - nb.d).toFixed(3))); rescued += 1; }
  }
  });

  if (incremental) setMeta(db, "last_weave", now);
  prof("weave.repairGraph", () => repairGraph(db));
  const degFinal = degreeMap(db);
  const islands = db.prepare("SELECT signature FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all().map((r) => r.signature).filter((s) => !degFinal.get(s));
  return { new_entity_hubs: newHubs, llm_entities: llmEnts.length, aliases_merged: aliasesMerged, mention_edges: mentionEdges, related_edges: relatedEdges, similar_edges: similarEdges, supersede_edges: supersedeEdges, sequence_edges: sequenceEdges, rescued_islands: rescued, remaining_islands: islands.length, incremental: !!incremental, weaved: factRows.length };
}

// ---- REFLECT: the LLM JUDGMENT pass (salience + semantic merge) -------------
// The headline LLM stage of a nightly dream. Two judgments the engine can't make
// mechanically:
//   SALIENCE  — tag the genuinely important facts so they survive cap-eviction and
//               decay slowly (importance != frequency).
//   MERGE     — roll up near-duplicate/incremental clusters into one richer fact,
//               so the bank stays under the entry cap by CONSOLIDATING rather than
//               blindly evicting. This is what lifts long-horizon synthesis recall.
// No-op (returns zeros) when no LLM is configured.
async function reflect(db, opts) {
  const now = (opts && opts.asOf) ? new Date(opts.asOf).toISOString() : new Date().toISOString();
  const llm = getLLM(llmEnv());
  if (!llm.available) return { llm: "none", note: "reflect requires the judgment knob (or DREAM_LLM); skipped", salient_tagged: 0, clusters_merged: 0, entries_reclaimed: 0 };

  const keepDetail0 = T.keepDetail || (opts && opts.keepDetail);
  // Nightly LLM cost must scale with NEW material, not total store size. Exclude Tier-3
  // archive ALWAYS (it is inert), and 'detail' in retain mode (already archived for
  // recall). This is the filter the audit flagged: archive was previously sent to the
  // salience LLM every night, so cost grew with the archive — the exact thing we forbid.
  const notColdSql = keepDetail0
    ? " AND (notes IS NULL OR notes NOT IN ('detail','archive'))"
    : " AND (notes IS NULL OR notes<>'archive')";

  // SALIENCE: judge importance over not-yet-salient facts. In incremental mode, only
  // judge facts NEW since the last reflect (importance is decided once, not re-judged
  // nightly) — bounds LLM cost to new material.
  const incrementalR = (opts && opts.incremental) || T.incrementalWeave;
  const lastReflect = incrementalR ? (getMeta(db, "last_reflect") || "1970-01-01T00:00:00.000Z") : "1970-01-01T00:00:00.000Z";
  const newOnlySql = incrementalR ? ` AND first_seen > '${lastReflect.replace(/'/g, "")}'` : "";
  let salientTagged = 0;
  const candidates = db.prepare(`SELECT signature AS sig, fact FROM nodes WHERE kind='fact' AND class!='salient'${notColdSql}${newOnlySql}`).all();
  let flagged = new Set();
  try { flagged = await profA(`reflect.salienceLLM(cand=${candidates.length})`, () => judge.salienceLLM(candidates, llm)); }
  catch (e) { process.stderr.write(`[reflect] salience failed: ${e.message}\n`); }
  const txS = db.transaction(() => {
    for (const sig of flagged) {
      db.prepare("UPDATE nodes SET class='salient', salience='decision', strength=? , last_reactivated=? WHERE signature=? AND kind='fact'")
        .run(clamp01((db.prepare("SELECT strength FROM nodes WHERE signature=?").get(sig) || {}).strength + 0.05 || 0.9), now, sig);
      salientTagged += 1;
    }
  });
  txS();

  // MERGE: get near-duplicate clusters, let the LLM decide + write the rollup, apply.
  // Incremental: only seed merge clusters from facts new since last reflect.
  const cons = await profA("reflect.consolidate", () => consolidate(db, { sim: (opts && opts.sim) || 0, excludeDetail: keepDetail0, seedAfter: incrementalR ? lastReflect : null }));
  const clusters = cons.clusters || [];
  let decisions = [];
  if (clusters.length) {
    try { decisions = await profA(`reflect.mergeClustersLLM(clusters=${clusters.length})`, () => judge.mergeClustersLLM(clusters, llm)); }
    catch (e) { process.stderr.write(`[reflect] merge failed: ${e.message}\n`); }
  }
  let clustersMerged = 0, reclaimed = 0, retained = 0;
  // RETAIN-DETAIL mode (env MEMORY_MERGE_KEEP=1): the merge writes a GIST survivor for
  // the projection, but the detailed constituents are KEPT in the db (flagged
  // notes='detail') instead of deleted — so recall (m_recall / recall.js over the full
  // side store) can still surface the specific fact when a question needs the detail.
  // The projection (exportHarness) injects the gist and skips 'detail'; the side DB is
  // the lookup layer. This is the "vague gist + look-it-up" model: the 500-cap bounds
  // what we INJECT, not what we REMEMBER. Default (unset) = destructive merge (legacy).
  const keepDetail = keepDetail0;
  // VAGUENESS TRACE (mathematically-measured "feeling of vagueness"): for each merge,
  // measure how much semantic spread we averaged into one gist = mean cosine distance of
  // the member embeddings to the cluster centroid. ~0 = we merged near-duplicates (a
  // faithful restatement); high = we collapsed a heterogeneous set into one summary
  // (genuinely lossy). Stored as a scalar on the survivor and surfaced by recall as a
  // "generalized summary" hint, so the agent knows to drill the time-indexed bookshelf for
  // specifics rather than enumerate from the gist. Dispersion is computed HERE (async
  // embed) and combined with the cumulative retained-detail count inside the txn below.
  const dispBySurvivor = new Map();
  const lossBySurvivor = new Map();
  for (const dec of decisions) {
    if (!dec) continue;
    const memFacts = dec.memberSigs
      .map((s) => (db.prepare("SELECT fact FROM nodes WHERE signature=? AND kind='fact'").get(s) || {}).fact)
      .filter(Boolean);
    if (memFacts.length < 2) continue;
    // SALIENT-LOSS (recall-biased): hard specifics (money/pct/mult/count; dates excluded) present
    // across the members but ABSENT from the merged gist text = answer-bearing information the
    // gist can no longer reconstruct. This is OUTPUT information loss, unlike dispersion which
    // only measures INPUT heterogeneity (a near-dup restatement that drops a figure has low
    // dispersion but total salient-loss — the false negative the old metric produced on q136).
    const memberSpecs = new Set();
    for (const f of memFacts) for (const t of extractHardSpecifics(f)) memberSpecs.add(t);
    if (memberSpecs.size) {
      const survSpecs = extractHardSpecifics(dec.fact);
      let dropped = 0;
      for (const t of memberSpecs) if (!survSpecs.has(t)) dropped += 1;
      lossBySurvivor.set(dec.survivorSig, { dropped, total: memberSpecs.size });
    }
    try {
      const vecs = (await embedTexts(memFacts)).map(unit);
      const dim = vecs[0].length;
      const c = new Float32Array(dim);
      for (const v of vecs) for (let i = 0; i < dim; i++) c[i] += v[i];
      const cu = unit(c);
      const disp = vecs.reduce((a, v) => a + (1 - dot(v, cu)), 0) / vecs.length;
      dispBySurvivor.set(dec.survivorSig, disp);
    } catch (e) { process.stderr.write(`[reflect] vagueness embed failed: ${e.message}\n`); }
  }
  const txM = db.transaction(() => {
    for (const dec of decisions) {
      if (!dec) continue;
      const survivor = db.prepare("SELECT * FROM nodes WHERE signature=? AND kind='fact'").get(dec.survivorSig);
      if (!survivor) continue;
      const members = dec.memberSigs.map((s) => db.prepare("SELECT * FROM nodes WHERE signature=? AND kind='fact'").get(s)).filter(Boolean);
      if (members.length < 2) continue;
      // survivor inherits the consolidated text + the strongest signal in the cluster.
      // It is now a GIST/schema node (notes='gist') — a fusion of several episodes, so
      // the projection treats it as timeless rather than placing it on the episodic timeline.
      const maxStrength = Math.max(...members.map((m) => m.strength || 0));
      const anySalient = members.some((m) => m.class === "salient");
      const maxReacts = Math.max(...members.map((m) => m.reactivations || 0));
      // first_seen is the immutable ORIGINAL record date ("when first noted") — it drives the
      // Source: citation the agent reads. A merge survivor may be a LATER re-emission of the
      // same fact; keeping the survivor's own (later) first_seen loses the original posting
      // date and makes "when was it first recorded/posted" unanswerable (e.g. q010: conference
      // posted day7, but a day10 re-emission survived -> agent cited day10). The gist must carry
      // the EARLIEST date across its constituents. Recency is unaffected: it keys off
      // last_reactivated (set to `now` here), not first_seen, and is only a rank tie-break.
      const minFirstSeen = members.reduce((m, n) => {
        const t = Date.parse(n.first_seen || "");
        return (Number.isFinite(t) && (m == null || t < m.t)) ? { t, s: n.first_seen } : m;
      }, null);
      const survFirstSeen = (minFirstSeen && minFirstSeen.s) || survivor.first_seen;
      db.prepare("UPDATE nodes SET fact=?, text=?, class=?, salience=?, strength=?, reactivations=?, last_reactivated=?, first_seen=?, notes='gist' WHERE id=?")
        .run(dec.fact, dec.fact, anySalient ? "salient" : (survivor.class === "episodic" ? "semantic" : survivor.class),
          anySalient ? "decision" : (survivor.salience || ""), clamp01(maxStrength + 0.05), maxReacts, now, survFirstSeen, survivor.id);
      // re-embed survivor to its new text so retrieval matches the merged content
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(survivor.id));
      for (const m of members) {
        if (m.id === survivor.id) continue;
        // copy the member's mention edges onto the survivor (so the gist stays connected)
        for (const e of db.prepare("SELECT dst, rel, weight FROM edges WHERE src=? AND rel='mentions'").all(m.signature)) {
          const dup = db.prepare("SELECT 1 FROM edges WHERE src=? AND rel='mentions' AND dst=?").get(survivor.signature, e.dst);
          if (!dup && survivor.signature !== e.dst) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(survivor.signature, "mentions", e.dst, e.weight, now, now);
        }
        // MOVE the member's chronological/correction lineage (sequence/supersedes) onto the
        // survivor so the timeline stays navigable from the active gist. Re-point both
        // directions, dedup, drop self-loops, then remove the originals from the member so
        // the chain is never duplicated (and never dangles once the member is demoted/deleted).
        for (const e of db.prepare("SELECT src, rel, dst, weight FROM edges WHERE (src=? OR dst=?) AND rel IN ('sequence','supersedes')").all(m.signature, m.signature)) {
          const nsrc = e.src === m.signature ? survivor.signature : e.src;
          const ndst = e.dst === m.signature ? survivor.signature : e.dst;
          if (nsrc === ndst) continue;
          const dup = db.prepare("SELECT 1 FROM edges WHERE src=? AND rel=? AND dst=?").get(nsrc, e.rel, ndst);
          if (!dup) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(nsrc, e.rel, ndst, e.weight, now, now);
        }
        db.prepare("DELETE FROM edges WHERE (src=? OR dst=?) AND rel IN ('sequence','supersedes')").run(m.signature, m.signature);
        if (keepDetail) {
          // RETAIN: keep the detailed fact in the DB as a lookup-only 'detail' node.
          // Not projected (gist is), but fully retrievable via recall. Link it to the
          // gist so a graph walk from the gist can reach the specifics.
          db.prepare("UPDATE nodes SET notes='detail', last_reactivated=? WHERE id=?").run(now, m.id);
          const dup = db.prepare("SELECT 1 FROM edges WHERE src=? AND rel='related_to' AND dst=?").get(survivor.signature, m.signature);
          if (!dup) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(survivor.signature, "related_to", m.signature, 0.6, now, now);
          // R1: durable gist->detail lineage that survives demotion (edges get GC'd
          // when the detail is demoted to Tier-3 archive; this cold table does not).
          db.prepare("INSERT OR IGNORE INTO detail_of(detail_sig, gist_sig, first_seen) VALUES (?,?,?)").run(m.signature, survivor.signature, now);
          // Reparent: if this member was itself a gist with its own retained details,
          // flatten the chain so those details now point at the new (current) survivor.
          // Collision-safe (copy-if-absent then drop old rows): a plain UPDATE can hit the
          // (detail_sig,gist_sig) PK when a detail already points at the survivor, and the
          // detail_sig<>survivor guard prevents a self-referential (survivor,survivor) row.
          db.prepare("INSERT OR IGNORE INTO detail_of(detail_sig, gist_sig, first_seen) SELECT detail_sig, ?, first_seen FROM detail_of WHERE gist_sig=? AND detail_sig<>?").run(survivor.signature, m.signature, survivor.signature);
          db.prepare("DELETE FROM detail_of WHERE gist_sig=?").run(m.signature);
          retained += 1;
        } else {
          // DESTRUCTIVE (legacy): tombstone + delete the member.
          db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(m.signature, m.memory_id || "", now, `merged into ${survivor.signature}`);
          db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(m.signature, m.signature);
          db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(m.id));
          db.prepare("DELETE FROM nodes WHERE id=?").run(m.id);
          db.prepare("DELETE FROM detail_of WHERE detail_sig=? OR gist_sig=?").run(m.signature, m.signature);
          reclaimed += 1;
        }
      }
      // Stamp the vagueness scalar. PRIMARY signal = salient-loss (recall-biased): if the gist
      // dropped ANY hard specific a member carried, tag it clearly vague (>=0.5, above the 0.35
      // hint threshold) so the agent drills for the exact figure — over-firing is harmless
      // (a hint on a gist that DOES carry the value is still answered directly). SECONDARY =
      // dispersion (halved) as a weak OR-signal for heterogeneous merges that carry no hard
      // token; kept gentle so genuine synthesis/generalization gists are not aggressively tagged.
      const disp = dispBySurvivor.get(dec.survivorSig);
      const loss = lossBySurvivor.get(dec.survivorSig);
      const detailCount = keepDetail
        ? (db.prepare("SELECT count(*) c FROM detail_of WHERE gist_sig=?").get(survivor.signature) || {}).c || members.length
        : members.length;
      const dispTerm = disp != null ? disp * Math.log2(1 + detailCount) : 0;
      let vagueness = null;
      if (loss && loss.dropped > 0) {
        vagueness = clamp01(0.5 + 0.5 * (loss.dropped / loss.total));
      } else if (disp != null) {
        vagueness = clamp01(0.5 * dispTerm);
      }
      if (vagueness != null) {
        db.prepare("UPDATE nodes SET vagueness=? WHERE id=?").run(vagueness, survivor.id);
      }
      clustersMerged += 1;
    }
  });
  txM();

  // re-embed any survivor whose vec row we dropped, then re-weave to heal islands.
  // Never re-embed Tier-3 archive nodes (they are intentionally un-embedded).
  const missing = db.prepare("SELECT id FROM nodes WHERE id NOT IN (SELECT rowid FROM vec_nodes) AND (notes IS NULL OR notes<>'archive')").all().map((r) => r.id);
  if (missing.length) await profA(`reflect.reembed(missing=${missing.length})`, () => reembed(db, missing));
  await profA("reflect.reweave", () => weave(db, { asOf: opts && opts.asOf, llm: false }));
  if (incrementalR) setMeta(db, "last_reflect", now);
  repairGraph(db);
  return { llm: llm.label, salient_tagged: salientTagged, clusters_seen: clusters.length, clusters_merged: clustersMerged, entries_reclaimed: reclaimed, details_retained: retained };
}

// ---- CONSOLIDATE (report merge candidates; pressure-aware threshold) --------
async function consolidate(db, opts) {
  const factCount = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  const bp = budgetParams(factCount);
  // Under entry-budget pressure, lower the similarity bar so more near-dups/rollups surface.
  const SIM = (opts && opts.sim) || bp.mergeSim;
  // Always exclude Tier-3 archive (un-embedded); also exclude detail in retain mode.
  const excl = (opts && opts.excludeDetail)
    ? " AND (notes IS NULL OR notes NOT IN ('detail','archive'))"
    : " AND (notes IS NULL OR notes<>'archive')";
  const facts = db.prepare(`SELECT id, signature, fact, first_seen FROM nodes WHERE kind='fact'${excl}`).all();
  const mentionsOf = (sig) => new Set(db.prepare("SELECT dst FROM edges WHERE src=? AND rel='mentions'").all(sig).map((r) => r.dst));
  // Incremental: only SEED clusters from new facts (a new fact may merge into an existing
  // cluster; its KNN still finds the old members). Existing-existing dup pairs were
  // already evaluated the night they arrived. seedAfter = last_reflect timestamp.
  const seedAfter = opts && opts.seedAfter ? opts.seedAfter : null;
  const seeds = seedAfter ? facts.filter((f) => (f.first_seen || "") > seedAfter) : facts;
  const seen = new Set();
  const clusters = [];
  for (const f of seeds) {
    if (seen.has(f.signature)) continue;
    const qv = await queryVec(db, f);
    const nbrs = db.prepare(`SELECT n.id, n.signature s, n.fact, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 10) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>? AND n.kind='fact'${excl}`).all(qv, f.id);
    const fe = mentionsOf(f.signature);
    const group = [{ sig: f.signature, fact: f.fact }];
    for (const nb of nbrs) {
      const sim = 1 - nb.d; if (sim < SIM) continue;
      const sharedEnt = [...mentionsOf(nb.s)].some((x) => fe.has(x));
      if (sharedEnt && !seen.has(nb.s)) { group.push({ sig: nb.s, fact: nb.fact, sim: Number(sim.toFixed(3)) }); seen.add(nb.s); }
    }
    if (group.length > 1) { group.forEach((g) => seen.add(g.sig)); clusters.push(group); }
    seen.add(f.signature);
  }
  // Reduction = sum(clusterSize-1): merging each cluster to one entry frees that many.
  const reducible = clusters.reduce((a, c) => a + (c.length - 1), 0);
  return {
    facts: factCount, target: ENTRY_TARGET, status: bp.status, pressure: bp.pressure, merge_sim: Number(SIM.toFixed(3)),
    candidate_merge_clusters: clusters.length, entries_reclaimable: reducible,
    projected_after_merge: factCount - reducible,
    guidance: "Agent: merge each cluster into ONE richer fact (m_remember new naming all neighbors -> m_forget constituents). Fewer entries, larger entries is the goal. Then re-run ingest-harness + weave.",
    clusters,
  };
}

// ---- SYNTHESIS: emit recurrence-family candidate pools (deterministic) -------
// Cosine union-find over ACTIVE facts (NO shared-entity gate — the motivating PPVNET cloud has
// no entity hub). A pool is emitted only when it is a TIGHT, DORMANT, multi-member cloud whose
// family has gone QUIET (no recent new member), and excludes facts already generalized (already
// a `detail_of` member, or a `gist`). This is the mechanical CANDIDATE gate; the LLM
// (`synthesize`) does the careful sub-theme carve / refuse. Dormancy uses reactivations + age,
// NOT last_reactivated (the weave bumps it nightly -> always 0d).
function emitCandidates(db, opts = {}) {
  const o = {
    tight: opts.tight != null ? opts.tight : 0.70,                       // cosine to union two facts
    k: opts.k || 12,                                                     // KNN width
    minSize: opts.minSize || 3,                                         // demote-eligible pool floor
    maxStrength: opts.maxStrength != null ? opts.maxStrength : 0.45,    // dormant: weak
    maxReactivations: opts.maxReactivations != null ? opts.maxReactivations : 1, // dormant: not reinforced
    minAge: opts.minAge != null ? opts.minAge : 14,                    // member had a chance to be re-asked (days)
    quietFor: opts.quietFor != null ? opts.quietFor : 14,              // cluster maturity: newest member older than this
  };
  const now = Date.now();
  const ageD = (iso) => (iso ? (now - Date.parse(iso)) / 86400000 : 0);
  const generalized = new Set(db.prepare("SELECT detail_sig FROM detail_of").all().map((r) => r.detail_sig));
  const facts = db.prepare(`SELECT id, signature, class, strength, reactivations, first_seen, COALESCE(fact,'') fact, notes FROM nodes WHERE ${ACTIVE_FACT}`).all()
    .filter((f) => f.notes !== "gist" && !generalized.has(f.signature));
  const byId = new Map(facts.map((f) => [f.id, f]));
  const parent = new Map(facts.map((f) => [f.id, f.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const f of facts) {
    const blob = storedVecBlob(db, f.id); if (!blob) continue;
    const nbrs = db.prepare(`SELECT n.id id, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>? AND ${ACTIVE_FACT}`).all(blob, o.k + 1, f.id);
    for (const nb of nbrs) { if (!byId.has(nb.id)) continue; if (1 - nb.d >= o.tight) union(f.id, nb.id); }
  }
  const groups = new Map();
  for (const f of facts) { const r = find(f.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
  const isDormant = (x) => (x.strength || 0) < o.maxStrength && (x.reactivations || 0) <= o.maxReactivations && ageD(x.first_seen) >= o.minAge;
  const pools = [];
  let pid = 0;
  for (const m of groups.values()) {
    if (m.length < o.minSize) continue;
    // Cluster maturity (rubber-duck #7): if ANY member (hot or cold) arrived within quietFor
    // days, the family is still active -> defer synthesis (don't abstract a still-growing cloud).
    const newestAgeAll = Math.min(...m.map((x) => ageD(x.first_seen)));
    if (newestAgeAll < o.quietFor) continue;
    const dormant = m.filter(isDormant);
    if (dormant.length < o.minSize) continue;
    // Mixed-strength (rubber-duck #5): reinforced siblings are EXEMPLARS for the concept but stay
    // hot (never demoted); only the dormant set is demote-eligible.
    const hot = m.filter((x) => !isDormant(x));
    pid += 1;
    pools.push({
      poolId: `pool-${pid}`,
      size: dormant.length,
      members: dormant.sort((a, b) => Date.parse(a.first_seen) - Date.parse(b.first_seen)).map((x) => ({
        sig: x.signature, fact: x.fact, strength: Number((x.strength || 0).toFixed(3)),
        reactivations: x.reactivations || 0, firstSeen: x.first_seen, ageDays: Math.round(ageD(x.first_seen)),
      })),
      hotSiblings: hot.map((x) => ({ sig: x.signature, fact: x.fact, strength: Number((x.strength || 0).toFixed(3)), reactivations: x.reactivations || 0 })),
    });
  }
  return { facts: facts.length, pools_found: pools.length, params: o, pools };
}

// ---- SYNTHESIS: apply ONE concept group (deterministic, transactional) -------
// Reuses the existing gist/detail machinery: the concept is a HOT gist; the members are demoted
// to the Tier-3 bookshelf (vector -> vec_archive, notes='archive', edges dropped) and linked to
// the concept by the durable `detail_of` cold lineage (what recall's 2a drill-down walks). The
// concept node + every member demotion happen in ONE transaction (rubber-duck #3): a failure
// rolls back the whole group, so there is NEVER an archived member without its concept anchor.
async function applyConcept(db, group, opts = {}) {
  const now = (opts.asOf ? new Date(opts.asOf) : new Date()).toISOString();
  const jrn = (op, sig, reason) => { try { db.prepare("INSERT INTO dream_journal(dreamed_at,run_id,op,memory_id,signature,category,original_fact,result_fact,reason) VALUES (?,?,?,?,?,?,?,?,?)").run(now, `synth-${now}`, op, "", sig || "", "", "", "", reason); } catch { /* journal best-effort */ } };
  const members = group.memberSigs
    .map((sig) => db.prepare(`SELECT id, signature, fact, first_seen, memory_id, strength FROM nodes WHERE signature=? AND ${ACTIVE_FACT}`).get(sig))
    .filter(Boolean);
  // idempotency: drop members already generalized under some concept
  const already = new Set(db.prepare("SELECT detail_sig FROM detail_of").all().map((r) => r.detail_sig));
  const fresh = members.filter((m) => !already.has(m.signature));
  if (fresh.length < 2) return { applied: false, reason: "fewer than 2 live un-generalized members" };

  // Durable lexical anchors (rubber-duck #2): bake span/scale into the concept text so a
  // date/topic query has terms to match and the projected gist is self-describing.
  let conceptText = group.concept;
  const extra = [group.span, group.scale].filter((s) => s && !conceptText.includes(s));
  if (extra.length) conceptText += ` (${extra.join(", ")})`;
  // the concept carries the family's ONSET date (earliest member) so the span is navigable
  const minFirst = fresh.reduce((m, n) => { const t = Date.parse(n.first_seen || ""); return (Number.isFinite(t) && (m == null || t < m.t)) ? { t, s: n.first_seen } : m; }, null);
  const conceptFirstSeen = (minFirst && minFirst.s) || now;

  const vec = await embedOne(conceptText);
  const blob = toVecBlob(vec);
  const tx = db.transaction(() => {
    // id must clear every id-space: a deleted node can leave an orphan vec_nodes/vec_archive
    // rowid above MAX(nodes.id), which would collide on the vec_nodes PK (rubber-duck: orphan vec).
    const vmax = (t) => { try { return db.prepare(`SELECT COALESCE(MAX(rowid),0)+1 m FROM ${t}`).get().m; } catch { return 0; } };
    const cid = Math.max(nextId(db), vmax("vec_nodes"), vmax("vec_archive"));
    const csig = uniqueSig(db, `fact:${deriveSlug(conceptText)}`);
    db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
      VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(cid, csig, "", "fact", "semantic", "fact", 0.62, conceptFirstSeen, now, now, "gist", conceptText, conceptText);
    db.prepare("INSERT INTO vec_nodes(rowid, embedding) VALUES (?, ?)").run(BigInt(cid), blob);
    for (const m of fresh) {
      // connect the concept to the entity hubs the member mentioned (keeps it non-island +
      // reachable by entity co-mention), then DEMOTE the member to the cold bookshelf.
      for (const e of db.prepare("SELECT dst, weight FROM edges WHERE src=? AND rel='mentions'").all(m.signature)) {
        const dup = db.prepare("SELECT 1 FROM edges WHERE src=? AND rel='mentions' AND dst=?").get(csig, e.dst);
        if (!dup && csig !== e.dst) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(csig, "mentions", e.dst, e.weight, now, now);
      }
      db.prepare("INSERT OR IGNORE INTO detail_of(detail_sig, gist_sig, first_seen) VALUES (?,?,?)").run(m.signature, csig, now);
      const rid = BigInt(m.id);
      const vblob = storedVecBlob(db, m.id);
      db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(m.signature, m.signature);
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(rid);
      if (vblob) { db.prepare("DELETE FROM vec_archive WHERE rowid=?").run(rid); db.prepare("INSERT INTO vec_archive(rowid, embedding) VALUES (?, ?)").run(rid, vblob); }
      db.prepare("UPDATE nodes SET notes='archive', last_decayed=? WHERE id=?").run(now, m.id);
      jrn("merge", m.signature, `synthesized under concept ${csig}`);
    }
    jrn("bridge", csig, `concept generalizes ${fresh.length} dormant instances`);
    return { concept_sig: csig, demoted: fresh.length };
  });
  const res = tx();
  return { applied: true, concept: conceptText, ...res };
}

// ---- SYNTHESIS: bounded multi-turn auto loop (engine-internal DREAM_LLM path) -
// The headless/bench front-end: emit -> judge(DREAM_LLM) -> validate -> apply -> re-emit until
// fixpoint or turn-cap. Stateless turns (all state in the db), best-effort & non-blocking (an
// LLM failure stops the loop, never corrupts the store), transcripted for audit. The live
// conversational skill drives the same emit-candidates / apply primitives in-context instead.
async function synthesizeAuto(db, opts = {}) {
  const llm = getLLM(llmEnv());
  if (!llm || !llm.available) return { ran: false, reason: "no LLM (judgment off / DREAM_LLM unset)" };
  const maxTurns = opts.maxTurns || 3;
  const transcript = [];
  let totalConcepts = 0, totalDemoted = 0, turn = 0;
  for (; turn < maxTurns; turn += 1) {
    const cand = emitCandidates(db, opts.detect || {});
    if (!cand.pools.length) break;
    let decisions = [];
    try { decisions = await judge.synthesizeClustersLLM(cand.pools, llm, {}); }
    catch (e) { transcript.push({ turn, error: String((e && e.message) || e) }); break; }
    let appliedThisTurn = 0;
    const applied = [];
    for (const dec of decisions) {
      for (const g of dec.groups) {
        try {
          const r = await applyConcept(db, g, { asOf: opts.asOf });
          if (r.applied) { totalConcepts += 1; totalDemoted += r.demoted; appliedThisTurn += 1; applied.push({ concept: r.concept, demoted: r.demoted }); }
        } catch (e) { transcript.push({ turn, applyError: String((e && e.message) || e), concept: g.concept }); }
      }
    }
    transcript.push({ turn, pools: cand.pools.length, decided: decisions.length, applied });
    if (!appliedThisTurn) break;
  }
  repairGraph(db);
  if (opts.transcript) { try { fs.appendFileSync(opts.transcript, transcript.map((t) => JSON.stringify(t)).join("\n") + "\n"); } catch { /* audit best-effort */ } }
  return { ran: true, turns: turn, concepts_created: totalConcepts, members_demoted: totalDemoted, llm: llm.label, transcript };
}

// ---- BUDGET (report entry budget + prioritized worklist) --------------------
async function budget(db) {
  const factCount = db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT}`).get().c;
  const bp = budgetParams(factCount);
  // forecast what a dream run would evaporate at current strengths (active facts only)
  const epEvap = db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT} AND class='episodic' AND strength < ?`).get(bp.forgetThreshold).c;
  const semEvap = bp.semanticFade > 0 ? db.prepare(`SELECT count(*) c FROM nodes WHERE ${ACTIVE_FACT} AND class='semantic' AND strength < ?`).get(bp.semanticFade).c : 0;
  const merge = await consolidate(db, {});
  const projected = factCount - epEvap - semEvap - merge.entries_reclaimable;
  return {
    facts: factCount, target: ENTRY_TARGET, max: ENTRY_MAX, status: bp.status, pressure: bp.pressure,
    over_target_by: Math.max(0, factCount - ENTRY_TARGET),
    adaptive_params: { forgetThreshold: bp.forgetThreshold, decayAccel: bp.decayAccel, mergeSim: bp.mergeSim, semanticFade: bp.semanticFade },
    forecast: { evaporate_episodic: epEvap, evaporate_semantic: semEvap, merge_clusters: merge.candidate_merge_clusters, entries_reclaimable_by_merge: merge.entries_reclaimable, projected_entries_after_full_pass: projected },
    recommendation: factCount <= ENTRY_TARGET
      ? "Within budget. Normal nightly dream maintains it."
      : `Over target by ${factCount - ENTRY_TARGET}. Run 'dream' (auto fades ${epEvap + semEvap}), then 'consolidate' and merge clusters (agent) to reclaim ~${merge.entries_reclaimable}. Projected ~${projected}.`,
  };
}

// ---- DOCTOR -----------------------------------------------------------------
function doctor(db) {
  const facts = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").get().c;
  const archived = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND notes='archive'").get().c;
  const entities = db.prepare("SELECT count(*) c FROM nodes WHERE kind='entity'").get().c;
  const edges = db.prepare("SELECT count(*) c FROM edges").get().c;
  const sigs = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  const dangling = db.prepare("SELECT src,dst FROM edges").all().filter((e) => !sigs.has(e.src) || !sigs.has(e.dst)).length;
  const deg = degreeMap(db);
  // Tier-3 archive nodes are intentionally edgeless (keyword-only) — not islands.
  const islands = db.prepare("SELECT signature FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes<>'archive')").all().map((r) => r.signature).filter((s) => !deg.get(s));
  const degsum = [...deg.values()].reduce((a, b) => a + b, 0);
  return { facts, tier3_archived: archived, entities, edges, fact_islands: islands.length, islands: islands.slice(0, 20), dangling_edges: dangling, avg_degree: edges ? Number((degsum / (facts + entities)).toFixed(2)) : 0, healthy: islands.length === 0 && dangling === 0 };
}

// ---- PROJECT helpers --------------------------------------------------------
// ENGINE-OWNED ANCHOR MEMORY (weave channel E). A standing "how to use memory" instruction the
// engine ALWAYS projects at the top of the always-on flat list, so every consumer (Clawpilot
// weave + the bench) inherits it identically — no system-prompt access required. It converts the
// per-gist vagueness tag into ACTION: on a generalized/compressed note, re-search (graph_recall)
// for the exact figure before concluding it is unavailable. Proven to reliably drive recovery
// (3/3) in the offline lookup probe; the tag alone is unreliable (1/3).
const ANCHOR_MEMORY_FACT =
  "[memory-usage] When a recalled note is marked as a generalized summary or says a value was " +
  "compressed/omitted, do not answer exact figures/dates from it directly — run graph_recall " +
  "for the specific value first. Exact numbers and dates are kept in the detailed store even " +
  "when the summary omits them; never enumerate a list or cite a precise figure from a summary " +
  "without confirming it against a specific recall.";
function anchorRecord() {
  return {
    memory_id: "memory-usage-anchor", signature: "memory-usage-anchor",
    category: "instruction", tier: "gist", strength: 1,
    first_seen: null, age: null,
    fact: ANCHOR_MEMORY_FACT, display: ANCHOR_MEMORY_FACT,
  };
}
// PROJECTION (CLS-tiered, sequence-first). The host injects this flat list; ordering
// is the only temporal channel attention has, so we don't squander it on strength.
// Two tiers, mirroring complementary learning systems:
//   GIST (timeless)  — merge survivors / schema facts. Salience-ordered, no age tag;
//                      these answer "what / who / the policy", which has no single time.
//   EPISODIC (dated) — the rest, in CHRONOLOGICAL order (oldest->newest) so list
//                      position encodes "when", each carrying a coarse, fuzzy age tag.
// "Now" for age tags: --as-of, else the latest memory (the bench simulates time).
function exportHarness(db, asOf) {
  // Detail nodes (notes='detail') are lookup-only — kept in the side DB for recall but
  // NOT injected; the projection carries the gist. Archive nodes (Tier 3) are never
  // projected either. This is the cap-on-inject, not-on-remember split. Everything else projects.
  const facts = db.prepare("SELECT * FROM nodes WHERE kind='fact' AND (notes IS NULL OR notes NOT IN ('detail','archive'))").all();
  const latest = facts.reduce((m, n) => { const t = Date.parse(n.first_seen || ""); return t && t > m ? t : m; }, 0);
  const nowRef = asOf ? new Date(asOf) : (latest ? new Date(latest) : new Date());

  const isGist = (n) => n.notes && /\bgist\b/.test(n.notes);
  const rank = (n) => ({ salient: 2, semantic: 1, episodic: 0 }[n.class] || 0);

  const gist = facts.filter(isGist)
    .sort((a, b) => rank(b) - rank(a) || (b.strength || 0) - (a.strength || 0) || a.signature.localeCompare(b.signature));
  const episodic = facts.filter((n) => !isGist(n))
    .sort((a, b) => (Date.parse(a.first_seen || "") || 0) - (Date.parse(b.first_seen || "") || 0) || a.signature.localeCompare(b.signature));

  const rec = (n, tier) => {
    const d = ageDays(n.first_seen, nowRef);
    const tag = tier === "episodic" ? ageTag(d) : null;
    return {
      memory_id: n.memory_id, signature: n.signature,
      category: n.salience || CLASS2CAT[n.class] || "fact",
      tier, strength: Number((n.strength || 0).toFixed(3)),
      first_seen: n.first_seen || null, age: tag,
      fact: (n.fact || "").trim(),
      // Ready-to-inject line: episodic facts are prefixed with their fuzzy age so the
      // temporal key survives into the host's context; gist facts stay timeless.
      display: tier === "episodic" ? `[${tag}] ${(n.fact || "").trim()}` : (n.fact || "").trim(),
    };
  };

  // Gist first (primacy for standing facts), then the episodic timeline in order.
  // The engine-owned anchor memory always leads (channel E).
  return [anchorRecord(), ...gist.map((n) => rec(n, "gist")), ...episodic.map((n) => rec(n, "episodic"))];
}

function recordProjection(db, file) {
  const pairs = JSON.parse(fs.readFileSync(file, "utf8"));
  db.transaction(() => pairs.forEach((p) => db.prepare("UPDATE nodes SET memory_id=? WHERE signature=?").run(p.memory_id, p.signature)))();
  return { recorded: pairs.length };
}

function exportViz(db) {
  const nodes = db.prepare("SELECT signature AS id, COALESCE(kind,'fact') kind, class, strength, reactivations, notes, memory_id, fact FROM nodes ORDER BY id").all();
  const proj = projectEmbeddings3D(db);
  for (const n of nodes) { const p = proj.get(n.id); if (p) { n.px = p[0]; n.py = p[1]; n.pz = p[2]; } }
  const ids = new Set(nodes.map((n) => n.id));
  const links = db.prepare("SELECT src AS source, dst AS target, rel, weight FROM edges ORDER BY weight DESC").all().filter((l) => ids.has(l.source) && ids.has(l.target));
  const html = fs.readFileSync(VIZ_TEMPLATE, "utf8").split(/\r?\n/);
  const idx = html.findIndex((l) => l.startsWith("const data = "));
  if (idx < 0) throw new Error("viz template data line not found");
  html[idx] = `const data = ${JSON.stringify({ nodes, links })};`;
  fs.mkdirSync(path.dirname(VIZ_OUT), { recursive: true });
  fs.writeFileSync(VIZ_OUT, html.join("\n"), "utf8");
  // The template references ./lib-3d-force-graph.min.js relatively; place the
  // vendored engine next to the rendered output so it loads offline.
  try {
    const libDst = path.join(path.dirname(VIZ_OUT), "lib-3d-force-graph.min.js");
    if (!fs.existsSync(libDst) && fs.existsSync(cfg.VIZ_LIB)) fs.copyFileSync(cfg.VIZ_LIB, libDst);
  } catch (e) { /* non-fatal */ }
  return { nodes: nodes.length, links: links.length, projected: proj.size, output: VIZ_OUT };
}

// Project 384-dim node embeddings to 3D via PCA (Gram-matrix power iteration) + per-axis
// whitening, so memories are positioned by MEANING. Disconnected facts land near
// semantically-similar neighbours instead of being flung into empty space by repulsion.
function projectEmbeddings3D(db) {
  const out = new Map();
  let rows;
  try { rows = db.prepare("SELECT n.signature s, v.embedding e FROM vec_nodes v JOIN nodes n ON n.id=v.rowid").all(); }
  catch { return out; }
  const N = rows.length; if (N < 4) return out;
  const D = 384;
  const X = rows.map((r) => { const b = r.e; const f = new Float32Array(b.buffer, b.byteOffset, D); return Array.from(f); });
  const mean = new Array(D).fill(0);
  for (const v of X) for (let j = 0; j < D; j++) mean[j] += v[j];
  for (let j = 0; j < D; j++) mean[j] /= N;
  for (const v of X) for (let j = 0; j < D; j++) v[j] -= mean[j];
  const G = []; for (let i = 0; i < N; i++) G.push(new Float64Array(N));
  for (let i = 0; i < N; i++) for (let k = i; k < N; k++) { let s = 0; const a = X[i], b = X[k]; for (let j = 0; j < D; j++) s += a[j] * b[j]; G[i][k] = s; G[k][i] = s; }
  const powerIter = (M, n, iters) => {
    let v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = Math.sin(i * 12.9898 + 1) * 43758.5453 % 1 || 0.1;
    let val = 0;
    for (let t = 0; t < iters; t++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; const Mi = M[i]; for (let j = 0; j < n; j++) s += Mi[j] * v[j]; w[i] = s; }
      let nrm = 0; for (let i = 0; i < n; i++) nrm += w[i] * w[i]; nrm = Math.sqrt(nrm) || 1;
      for (let i = 0; i < n; i++) w[i] /= nrm; val = nrm; v = w;
    }
    return { vec: v, val };
  };
  const deflate = (M, n, vec, val) => { for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] -= val * vec[i] * vec[j]; };
  const axes = [];
  for (let c = 0; c < 3; c++) { const e = powerIter(G, N, 220); axes.push({ vec: e.vec, val: Math.max(e.val, 1e-9) }); deflate(G, N, e.vec, e.val); }
  const coords = rows.map(() => [0, 0, 0]);
  for (let c = 0; c < 3; c++) {
    const sc = Math.sqrt(axes[c].val);
    const col = Array.from(axes[c].vec, (x) => x * sc);
    let m = 0; for (const x of col) m += x; m /= N;
    let sd = 0; for (const x of col) sd += (x - m) * (x - m); sd = Math.sqrt(sd / N) || 1;
    for (let i = 0; i < N; i++) coords[i][c] = (col[i] - m) / sd;
  }
  const R = 210; let maxr = 0;
  for (const p of coords) { const r = Math.hypot(p[0], p[1], p[2]); if (r > maxr) maxr = r; }
  const k = R / (maxr || 1);
  for (let i = 0; i < N; i++) out.set(rows[i].s, [coords[i][0] * k, coords[i][1] * k, coords[i][2] * k].map((x) => Number(x.toFixed(2))));
  return out;
}

function stats(db) {
  const byKind = db.prepare("SELECT COALESCE(kind,'?') kind, count(*) c FROM nodes GROUP BY kind").all();
  return { byKind, edges: db.prepare("SELECT count(*) c FROM edges").get().c, tombstones: db.prepare("SELECT count(*) c FROM tombstones").get().c, last_dream: getMeta(db, "last_dream") || null };
}

// ---- CLI --------------------------------------------------------------------

// `config` subcommand: inspect / set the five behavioral knobs (persisted to
// memory.config.json). Used by the LLM-driven install interview and by humans.
function configCmd(argv) {
  const sub = (argv[3] || "show").toLowerCase();
  if (sub === "show") {
    const r = tuning.resolve();
    return {
      configPath: r.configPath, configExists: r.configExists, knobs: r.knobs,
      resolved: { entryTarget: r.entryTarget, entryMax: r.entryMax, tier2Max: r.tier2Max, tiered: r.tiered, keepDetail: r.keepDetail, forgetMultiplier: r.forgetMultiplier, incrementalWeave: r.incrementalWeave, supersede: r.supersede, llmSpec: r.llmSpec },
      summary: tuning.describe(r),
    };
  }
  if (sub === "list" || sub === "knobs") {
    const out = {};
    for (const [name, spec] of Object.entries(tuning.KNOBS)) out[name] = { values: spec.values || "off | <provider>:<model>", default: spec.default, help: spec.help };
    return { knobs: out };
  }
  if (sub === "init") { const r = tuning.ensureConfig(); return { ...r, configPath: tuning.CONFIG_PATH }; }
  if (sub === "get") { const name = argv[4]; return { [name]: tuning.resolve().knobs[name] }; }
  if (sub === "set") {
    const name = argv[4], value = argv[5];
    if (!name || value === undefined) throw new Error("usage: config set <knob> <value>");
    const res = tuning.setKnob(name, value);
    if (!res.ok) throw new Error(res.error);
    return { set: { [name]: res.knobs[name] }, knobs: res.knobs, summary: tuning.describe(tuning.resolve()) };
  }
  throw new Error(`unknown config subcommand "${sub}". Use: show | list | set <knob> <value> | get <knob> | init`);
}

async function main() {
  const cmd = process.argv[2];
  const flags = parseFlags(process.argv);
  const db = openDb();
  try {
    let r, gate = false;
    if (cmd === "init") r = { initialized: true, db: DB_PATH, data_dir: DATA_DIR };
    else if (cmd === "migrate-model") r = migrateModel(db);
    else if (cmd === "ingest-harness") { r = await ingestHarness(db, flags.file, flags.prune === true || flags.prune === "true", flags["as-of"]); gate = !r.complete; }
    else if (cmd === "verify-sync") { r = verifySync(db, flags.file); gate = !r.complete; }
    else if (cmd === "dream") r = dreamCore(db, flags);
    else if (cmd === "weave") r = await weave(db, { k: Number(flags.k) || 3, sim: Number(flags.sim) || 0.45, asOf: flags["as-of"], llm: flags.llm === true || flags.llm === "true", supersede: flags.supersede === true || flags.supersede === "true" || T.supersede });
    else if (cmd === "reflect") r = await reflect(db, { asOf: flags["as-of"], sim: Number(flags.sim) || 0 });
    else if (cmd === "consolidate") r = await consolidate(db, { sim: Number(flags.sim) || 0 });
    else if (cmd === "emit-candidates") r = emitCandidates(db, { tight: flags.tight != null ? Number(flags.tight) : undefined, minSize: flags["min-size"] != null ? Number(flags["min-size"]) : undefined, quietFor: flags["quiet-for"] != null ? Number(flags["quiet-for"]) : undefined, minAge: flags["min-age"] != null ? Number(flags["min-age"]) : undefined, maxStrength: flags["max-strength"] != null ? Number(flags["max-strength"]) : undefined });
    else if (cmd === "synthesize") {
      const detect = {};
      for (const [f, k] of [["tight", "tight"], ["min-size", "minSize"], ["quiet-for", "quietFor"], ["min-age", "minAge"], ["max-strength", "maxStrength"]]) if (flags[f] != null) detect[k] = Number(flags[f]);
      r = await synthesizeAuto(db, { asOf: flags["as-of"], maxTurns: flags["max-turns"] != null ? Number(flags["max-turns"]) : undefined, transcript: flags.transcript, detect });
    }
    else if (cmd === "apply-concept") { const g = JSON.parse(fs.readFileSync(flags.file, "utf8")); r = await applyConcept(db, g, { asOf: flags["as-of"] }); repairGraph(db); }
    else if (cmd === "budget") r = await budget(db);
    else if (cmd === "doctor") { r = doctor(db); gate = !r.healthy; }
    else if (cmd === "export-harness") r = exportHarness(db, flags["as-of"]);
    else if (cmd === "record-projection") r = recordProjection(db, flags.file);
    else if (cmd === "export-viz") r = exportViz(db);
    else if (cmd === "stats") r = stats(db);
    else if (cmd === "config") r = configCmd(process.argv);
    else { console.error("Usage: node src/dream.js <init|migrate-model|ingest-harness|verify-sync|dream|weave|reflect|consolidate|budget|doctor|export-harness|record-projection|export-viz|stats|config> [flags]"); process.exitCode = 2; return; }
    console.log(JSON.stringify(r, null, 2));
    if (gate) process.exitCode = 3;
  } finally { db.close(); }
}
if (require.main === module) {
  main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
}

module.exports = { emitCandidates, applyConcept, synthesizeAuto, repairGraph };
