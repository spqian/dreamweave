"use strict";

// dream.js — the memory consolidation engine. Every nightly stage is implemented here.
// memory.db is the durable source of truth; the harness bank is its nightly projection.
//
// Subcommands:
//   migrate-model              one-time: split nodes into kind=fact / kind=entity, re-signature facts
//   ingest-harness  --file F [--prune]   harness -> db, memory_id-keyed, lossless (sync)
//   verify-sync     --file F             hard gate: every harness id present in db (exit 3 if not)
//   dream           [--advance-days N]   decay + auto-reactivate + evaporate + housekeeping (+journal)
//   weave                                co-mention + vector links; GUARANTEES zero fact islands
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
const cfg = require("../config");

const DATA_DIR = cfg.DATA_DIR;
const DB_PATH = cfg.DB_PATH; // env MEMORY_DB overrides (e.g. dry-run forecasts)
const VIZ_TEMPLATE = cfg.VIZ_TEMPLATE; // tracked template (empty data line)
const VIZ_OUT = cfg.VIZ_OUT;           // per-user rendered output

const HALFLIFE = { salient: 365, semantic: 180, episodic: 3 };
const INIT = { salient: 0.90, semantic: 0.70, episodic: 0.30 };
const CAT2CLASS = { decision: "salient", fact: "semantic", context: "episodic", preference: "semantic" };
const CLASS2CAT = { salient: "decision", semantic: "fact", episodic: "context" };
const FORGET = 0.15;
const EDGE_DECAY = { mentions: 1.0, related_to: 0.985, similar_to: 0.97, supersedes: 1.0, default: 0.99 }; // multiplicative per run

// ---- ENTRY BUDGET ----------------------------------------------------------
// The harness caps memory ENTRIES (= fact nodes; entity hubs are free db-side scaffolding).
// Hard max 500; performance degrades past 250. Target 250 as the sweet spot. As the bank
// approaches/exceeds target, dreaming escalates fading + merging. We prefer MERGE (fewer,
// richer entries) over deletion — entry SIZE may grow to keep the COUNT down.
const ENTRY_TARGET = Number(process.env.MEMORY_ENTRY_TARGET || 250);
const ENTRY_MAX = Number(process.env.MEMORY_ENTRY_MAX || 500);

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
const UNTRUSTED = /<\/?untrusted_memory>/g;
const STOPW = new Set("the a an is are was were of for to in on and or that with as at by from this its not be no into".split(" "));

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
      db.prepare("INSERT INTO vec_nodes(rowid, embedding) VALUES (?, ?)").run(BigInt(r.id), toVecBlob(vecs[i]));
    });
  });
  tx();
}

// ---- graph guards -----------------------------------------------------------
function repairGraph(db) {
  const now = new Date().toISOString();
  db.prepare("UPDATE nodes SET memory_id='' WHERE memory_id='live'").run();
  const sigs = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  const referenced = new Set();
  for (const e of db.prepare("SELECT src, dst FROM edges").all()) { referenced.add(e.src); referenced.add(e.dst); }
  let restored = 0;
  for (const s of [...referenced].filter((x) => x && !sigs.has(x))) {
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
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const mems = Array.isArray(raw) ? raw : (raw.memories || []);
  const now = asOf ? new Date(asOf).toISOString() : new Date().toISOString();
  const byMem = db.prepare("SELECT * FROM nodes WHERE memory_id=?");
  const res = { harness_count: mems.length, created: 0, refreshed: 0, pruned: 0 };
  const harnessIds = new Set(mems.map((m) => m.id || m.memory_id).filter(Boolean));
  const tx = db.transaction(() => {
    for (const m of mems) {
      const mid = m.id || m.memory_id; if (!mid) continue;
      const fact = String(m.fact || "").replace(UNTRUSTED, "").trim();
      const category = m.category || "fact";
      const ex = byMem.get(mid);
      if (ex) { db.prepare("UPDATE nodes SET fact=?, salience=? WHERE id=?").run(fact || ex.fact, category, ex.id); res.refreshed += 1; continue; }
      const cls = CAT2CLASS[category] || "semantic";
      const sig = uniqueSig(db, `fact:${deriveSlug(fact)}`);
      const id = nextId(db);
      db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
        VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(id, sig, mid, "fact", cls, category, INIT[cls], now, now, now, "harness-ingest", fact, "");
      res.created += 1;
    }
    if (prune) {
      const stale = db.prepare("SELECT id, signature, memory_id FROM nodes WHERE kind='fact' AND memory_id<>''").all().filter((n) => !harnessIds.has(n.memory_id));
      for (const n of stale) {
        db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id, now, "pruned: left harness");
        db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
        db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
        res.pruned += 1;
      }
    }
  });
  tx();
  repairGraph(db);
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
  const factCount = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c || 1;
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

  const facts = db.prepare("SELECT * FROM nodes WHERE kind='fact'").all();
  const bp = budgetParams(facts.length);
  const schema = computeSchemaFit(db);

  // DECAY facts. Half-life accelerated under budget pressure, EXTENDED by schema fit
  // (schema-embedded facts persist; islands fade fastest).
  for (const n of facts) {
    const sf = schema.get(n.signature) || 0;
    const H = (HALFLIFE[n.class] || HALFLIFE.episodic) * (1 + SCHEMA_HALFLIFE_BONUS * sf) / bp.decayAccel;
    const dDays = Math.max(0, (now.getTime() - Date.parse(n.last_decayed || n.first_seen || nowIso)) / 86400000);
    db.prepare("UPDATE nodes SET strength=?, last_decayed=? WHERE id=?").run(clamp01(n.strength * Math.pow(2, -dDays / H)), nowIso, n.id);
  }
  // EDGE decay
  for (const e of db.prepare("SELECT rowid, rel, weight FROM edges").all()) {
    const f = EDGE_DECAY[e.rel] || EDGE_DECAY.default;
    db.prepare("UPDATE edges SET weight=? WHERE rowid=?").run(clamp01(e.weight * f), e.rowid);
  }
  J("keep", "", `DECAY: ${facts.length} facts (pressure=${bp.pressure}, decayAccel=${bp.decayAccel}, schema-aware); edges`);

  // AUTO-REACTIVATE: a fact reappears when a NEW fact (since last dream) shares one of its
  // entities. Each fact reactivates AT MOST ONCE per run (reactivations counts NIGHTS re-seen,
  // not co-mentions) — so a tier promotion needs persistence across runs, not one busy night.
  // Schema-supported reactivation boosts more (and promotes at a lower threshold).
  const newFacts = db.prepare("SELECT * FROM nodes WHERE kind='fact' AND first_seen > ?").all(lastDream);
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
  const protectedSigs = new Set([...newFacts.map((n) => n.signature), ...reentered]);
  let evap = 0, evapSem = 0;
  for (const n of db.prepare("SELECT * FROM nodes WHERE kind='fact' AND class='episodic' AND strength < ?").all(bp.forgetThreshold)) {
    if (protectedSigs.has(n.signature)) continue;
    db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id || "", nowIso, `S=${n.strength.toFixed(3)}<${bp.forgetThreshold} episodic`);
    db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
    db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
    db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
    J("evaporate", n.signature, `S=${n.strength.toFixed(3)} episodic (threshold ${bp.forgetThreshold})`);
    evap += 1;
  }
  if (bp.semanticFade > 0) {
    for (const n of db.prepare("SELECT * FROM nodes WHERE kind='fact' AND class='semantic' AND strength < ?").all(bp.semanticFade)) {
      if (protectedSigs.has(n.signature)) continue;
      db.prepare("INSERT INTO tombstones(signature,memory_id,forgotten_at,reason) VALUES (?,?,?,?)").run(n.signature, n.memory_id || "", nowIso, `S=${n.strength.toFixed(3)}<${bp.semanticFade} weak-semantic (over budget)`);
      db.prepare("DELETE FROM edges WHERE src=? OR dst=?").run(n.signature, n.signature);
      db.prepare("DELETE FROM vec_nodes WHERE rowid=?").run(BigInt(n.id));
      db.prepare("DELETE FROM nodes WHERE id=?").run(n.id);
      J("evaporate", n.signature, `S=${n.strength.toFixed(3)} weak-semantic over-budget`);
      evapSem += 1;
    }
  }

  // HARD CEILING (faithful to Scout's native harness: a physical max of ENTRY_MAX entries).
  // Decay/evaporate above are the graceful path; in batch/headless runs there is no agent to
  // perform merges, so we deterministically evict the weakest facts down to the cap. Salient
  // is protected first, then this-run-new/reactivated, then lowest strength is dropped.
  let evapCap = 0;
  const factCountNow = () => db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  if (factCountNow() > ENTRY_MAX) {
    const over = factCountNow() - ENTRY_MAX;
    // Facts that some other fact SUPERSEDES are the preserved "from" value of a correction —
    // protect them so the transition stays answerable (empty set when supersede is unused).
    const supTargets = new Set(db.prepare("SELECT dst FROM edges WHERE rel='supersedes'").all().map((r) => r.dst));
    const cands = db.prepare(
      "SELECT * FROM nodes WHERE kind='fact' ORDER BY (class='salient') ASC, strength ASC, last_decayed ASC"
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
      J("evaporate", n.signature, `evicted over hard cap ${ENTRY_MAX}`);
      evapCap += 1;
    }
  }

  // HOUSEKEEPING
  const cut60 = new Date(now.getTime() - 60 * 86400000).toISOString();
  const cut30 = new Date(now.getTime() - 30 * 86400000).toISOString();
  const tRem = db.prepare("DELETE FROM tombstones WHERE forgotten_at < ?").run(cut60).changes;
  const eRem = db.prepare("DELETE FROM edges WHERE weight < 0.10").run().changes;
  const jRem = db.prepare("DELETE FROM dream_journal WHERE dreamed_at < ?").run(cut30).changes;

  repairGraph(db);
  setMeta(db, "last_dream", nowIso);
  const final = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  const after = budgetParams(final);
  const overBy = Math.max(0, final - ENTRY_TARGET);
  const summary = `RUN ${runId}: facts ${facts.length}->${final} (target ${ENTRY_TARGET}, status ${after.status}); reactivated ${reentered.size} (promoted ${promoSem}->sem), evaporated ${evap}+${evapSem}sem; pruned ${tRem} tombstones/${eRem} edges/${jRem} journal.`;
  J("keep", "", summary);
  const ins = db.prepare(`INSERT INTO dream_journal(dreamed_at,run_id,op,memory_id,signature,category,original_fact,result_fact,reason)
    VALUES (@dreamed_at,@run_id,@op,@memory_id,@signature,@category,@original_fact,@result_fact,@reason)`);
  db.transaction(() => journal.forEach((j) => ins.run(j)))();
  const result = { runId, summary, facts: final, target: ENTRY_TARGET, max: ENTRY_MAX, status: after.status, pressure: after.pressure, evaporated_episodic: evap, evaporated_semantic: evapSem, evicted_over_cap: evapCap, reactivated: reentered.size, promoted_semantic: promoSem };
  if (overBy > 0) result.action_needed = `Still ${overBy} over target. Run 'consolidate' and merge the reported clusters (agent) to reduce entry count.`;
  return result;
}

// ---- WEAVE: connect every fact (zero islands) -------------------------------
async function weave(db, opts) {
  const now = (opts && opts.asOf) ? new Date(opts.asOf).toISOString() : new Date().toISOString();
  const K = (opts && opts.k) || 3;
  const SIM = (opts && opts.sim) || 0.45;

  // 1) entity vocab from existing entity hubs
  let entityRows = db.prepare("SELECT signature FROM nodes WHERE kind='entity'").all();
  let vocab = ent.buildVocab(entityRows);

  // 2) extract new entities from facts -> create hubs. SELF-BOOTSTRAPPING: the corpus
  //    extractor learns the entity vocabulary from recurrence (no seed/deny lists), so a
  //    candidate becomes a hub only if it recurs across facts (or has a strong email signal).
  const factRows = db.prepare("SELECT id, signature, fact FROM nodes WHERE kind='fact'").all();
  const haveSig = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  let newHubs = 0;
  const corpusEnts = ent.extractEntitiesCorpus(factRows.map((f) => f.fact || ""), { minFacts: (opts && opts.minFacts) || 2 });
  const tx1 = db.transaction(() => {
    for (const e of corpusEnts) {
      if (haveSig.has(e.sig)) continue;
      const id = nextId(db);
      db.prepare(`INSERT INTO nodes(id,signature,memory_id,kind,class,salience,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text)
        VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(id, e.sig, "", "entity", "semantic", "semantic", 0.5, now, now, now, "weave-extract", "", "");
      haveSig.add(e.sig); newHubs += 1;
    }
  });
  tx1();
  entityRows = db.prepare("SELECT signature FROM nodes WHERE kind='entity'").all();
  vocab = ent.buildVocab(entityRows);

  // 3) co-mention edges fact -> entity
  const hasEdge = db.prepare("SELECT 1 FROM edges WHERE src=? AND dst=? AND rel=?");
  const addEdge = (src, rel, dst, w) => { if (src === dst) return; if (!hasEdge.get(src, dst, rel)) db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,?,?,?)").run(src, rel, dst, w, now, now); };
  let mentionEdges = 0;
  const tx2 = db.transaction(() => {
    for (const f of factRows) {
      for (const sig of ent.coMentions(f.fact || "", vocab)) { addEdge(f.signature, "mentions", sig, 0.8); mentionEdges += 1; }
    }
  });
  tx2();

  // 4) embed any node missing a vec row (new entity hubs), so KNN can use them
  const missing = db.prepare("SELECT id FROM nodes WHERE id NOT IN (SELECT rowid FROM vec_nodes)").all().map((r) => r.id);
  if (missing.length) await reembed(db, missing);

  // 5) vector sibling links fact <-> fact, CORROBORATED.
  //    shared entity (co-mention overlap) -> related_to (trusted).
  //    else high similarity only      -> similar_to  (low-confidence suggestion).
  //    pure low-sim proximity is NOT committed (no fabrication).
  const HIGH = (opts && opts.high) || 0.62;
  const mentionsOf = (sig) => new Set(db.prepare("SELECT dst FROM edges WHERE src=? AND rel='mentions'").all(sig).map((r) => r.dst));
  let relatedEdges = 0, similarEdges = 0;
  const factNodes = db.prepare("SELECT id, signature, fact FROM nodes WHERE kind='fact'").all();
  for (const f of factNodes) {
    const fe = mentionsOf(f.signature);
    const qv = toVecBlob(await embedOne(f.fact || f.signature));
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

  // 5.5) SUPERSEDE-aware consolidation (opt-in via --supersede). A CORRECTION is a DOUBLE
  // signal: it reactivates the prior fact AND overrides it, so the corrective fact should
  // consolidate MORE strongly than a plain restatement, while the superseded "from" value is
  // PRESERVED (pinned against cap-eviction) so the transition stays answerable. Mirrors how a
  // human remembers a correction more vividly than the steady state it replaced.
  let supersedeEdges = 0;
  const SUP = (opts && opts.supersede) || process.env.MEMORY_SUPERSEDE === "1";
  if (SUP) {
    const CUE = /\b(correct(?:ion|ed|s)?|chang(?:e|ed|ing)?|updat(?:e|ed)?|revis(?:e|ed)?|no longer|instead of|rather than|supersed(?:e|ed|es)?|overrid(?:e|den|es)?|replac(?:e|ed|es)?|moved? (?:to|up|earlier|from)|push(?:ed)? (?:to|up|earlier)|now \w+ not)\b/i;
    const toks = (s) => new Set(ent.normalize(s || "").split(" ").filter((w) => w.length > 4 && !STOPW.has(w)));
    const full = db.prepare("SELECT id, signature, fact, first_seen, strength, class FROM nodes WHERE kind='fact'").all();
    const bySig = new Map(full.map((r) => [r.signature, r]));
    for (const f of full) {
      if (!f.fact || !CUE.test(f.fact)) continue;
      const fe = mentionsOf(f.signature);   // entity hubs (may be empty — e.g. single-name principals)
      const ft = toks(f.fact);              // content tokens, for entity-free corroboration
      const qv = toVecBlob(await embedOne(f.fact));
      const nbrs = db.prepare(`SELECT n.signature s, n.kind k, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 12) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>?`).all(qv, f.id);
      let target = null;
      for (const nb of nbrs) {
        if (nb.k !== "fact") continue;
        const o = bySig.get(nb.s); if (!o) continue;
        const sim = 1 - nb.d;
        const older = Date.parse(o.first_seen || 0) < Date.parse(f.first_seen || 0);
        // corroborate by a shared entity hub OR (when none) a shared content token.
        const sharedEnt = fe.size && [...mentionsOf(nb.s)].some((x) => fe.has(x));
        const sharedTok = [...toks(o.fact)].some((t) => ft.has(t));
        if (older && sim >= 0.5 && sim <= 0.96 && (sharedEnt || sharedTok)) { target = o; break; }
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
  }

  // 6) zero-island guarantee: any fact still degree 0 -> link nearest as similar_to (weak, agent retypes later).
  let rescued = 0;
  const deg = degreeMap(db);
  for (const f of factNodes) {
    if (deg.get(f.signature)) continue;
    const qv = toVecBlob(await embedOne(f.fact || f.signature));
    const nb = db.prepare(`SELECT n.signature s, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 6) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>? AND n.kind='fact'`).all(qv, f.id)[0];
    if (nb) { addEdge(f.signature, "similar_to", nb.s, Number((1 - nb.d).toFixed(3))); rescued += 1; }
  }

  repairGraph(db);
  const islands = [...db.prepare("SELECT signature FROM nodes WHERE kind='fact'").all().map((r) => r.signature)].filter((s) => !degreeMap(db).get(s));
  return { new_entity_hubs: newHubs, mention_edges: mentionEdges, related_edges: relatedEdges, similar_edges: similarEdges, supersede_edges: supersedeEdges, rescued_islands: rescued, remaining_islands: islands.length };
}

// ---- CONSOLIDATE (report merge candidates; pressure-aware threshold) --------
async function consolidate(db, opts) {
  const factCount = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  const bp = budgetParams(factCount);
  // Under entry-budget pressure, lower the similarity bar so more near-dups/rollups surface.
  const SIM = (opts && opts.sim) || bp.mergeSim;
  const facts = db.prepare("SELECT id, signature, fact FROM nodes WHERE kind='fact'").all();
  const mentionsOf = (sig) => new Set(db.prepare("SELECT dst FROM edges WHERE src=? AND rel='mentions'").all(sig).map((r) => r.dst));
  const seen = new Set();
  const clusters = [];
  for (const f of facts) {
    if (seen.has(f.signature)) continue;
    const qv = toVecBlob(await embedOne(f.fact || f.signature));
    const nbrs = db.prepare(`SELECT n.id, n.signature s, n.fact, v.distance d FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT 10) v JOIN nodes n ON n.id=v.rowid WHERE n.id<>? AND n.kind='fact'`).all(qv, f.id);
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

// ---- BUDGET (report entry budget + prioritized worklist) --------------------
async function budget(db) {
  const factCount = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  const bp = budgetParams(factCount);
  // forecast what a dream run would evaporate at current strengths
  const epEvap = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND class='episodic' AND strength < ?").get(bp.forgetThreshold).c;
  const semEvap = bp.semanticFade > 0 ? db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact' AND class='semantic' AND strength < ?").get(bp.semanticFade).c : 0;
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
  const facts = db.prepare("SELECT count(*) c FROM nodes WHERE kind='fact'").get().c;
  const entities = db.prepare("SELECT count(*) c FROM nodes WHERE kind='entity'").get().c;
  const edges = db.prepare("SELECT count(*) c FROM edges").get().c;
  const sigs = new Set(db.prepare("SELECT signature FROM nodes").all().map((r) => r.signature));
  const dangling = db.prepare("SELECT src,dst FROM edges").all().filter((e) => !sigs.has(e.src) || !sigs.has(e.dst)).length;
  const deg = degreeMap(db);
  const islands = db.prepare("SELECT signature FROM nodes WHERE kind='fact'").all().map((r) => r.signature).filter((s) => !deg.get(s));
  const degsum = [...deg.values()].reduce((a, b) => a + b, 0);
  return { facts, entities, edges, fact_islands: islands.length, islands: islands.slice(0, 20), dangling_edges: dangling, avg_degree: edges ? Number((degsum / (facts + entities)).toFixed(2)) : 0, healthy: islands.length === 0 && dangling === 0 };
}

// ---- PROJECT helpers --------------------------------------------------------
function exportHarness(db) {
  const facts = db.prepare("SELECT * FROM nodes WHERE kind='fact' ORDER BY strength DESC, signature ASC").all();
  return facts.map((n) => ({ memory_id: n.memory_id, signature: n.signature, category: n.salience || CLASS2CAT[n.class] || "fact", strength: Number((n.strength || 0).toFixed(3)), fact: (n.fact || "").trim() }));
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
    else if (cmd === "weave") r = await weave(db, { k: Number(flags.k) || 3, sim: Number(flags.sim) || 0.45, asOf: flags["as-of"], supersede: flags.supersede === true || flags.supersede === "true" || process.env.MEMORY_SUPERSEDE === "1" });
    else if (cmd === "consolidate") r = await consolidate(db, { sim: Number(flags.sim) || 0 });
    else if (cmd === "budget") r = await budget(db);
    else if (cmd === "doctor") { r = doctor(db); gate = !r.healthy; }
    else if (cmd === "export-harness") r = exportHarness(db);
    else if (cmd === "record-projection") r = recordProjection(db, flags.file);
    else if (cmd === "export-viz") r = exportViz(db);
    else if (cmd === "stats") r = stats(db);
    else { console.error("Usage: node lib/dream.js <init|migrate-model|ingest-harness|verify-sync|dream|weave|consolidate|budget|doctor|export-harness|record-projection|export-viz|stats> [flags]"); process.exitCode = 2; return; }
    console.log(JSON.stringify(r, null, 2));
    if (gate) process.exitCode = 3;
  } finally { db.close(); }
}
main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
