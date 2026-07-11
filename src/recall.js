"use strict";

// recall.js: semantic vector recall + graph expansion over memory.db.
// Real embeddings (sqlite-vec KNN) seed the search, then a recursive-CTE graph
// walk expands the cluster, ranked by the dream strength model.
//
//   node lib/recall.js --query "<text>" [--max-hops 2] [--seed-limit 4] [--k 12]

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { embedOne, toVecBlob } = require("./embed");
const { ageDays, ageTag } = require("./timeline");
const cfg = require("../config");

const DB_PATH = cfg.DB_PATH;
const ACT_LAMBDA = 0.2;
const ACT_COS_FLOOR = 0.30;
const ACT_SUPERSEDE_PENALTY = 0.15;
const ACT_DETAIL_PENALTY = 0.12;

function activationScore(cosine, strength, opts = {}) {
  const gate = cosine >= ACT_COS_FLOOR ? 1 : 0;
  let lambda = ACT_LAMBDA;
  if (opts.dateIntent && !opts.histIntent) lambda *= 0.5;
  let score = cosine + lambda * (strength || 0) * gate;
  if (opts.superseded && !opts.histIntent) score -= ACT_SUPERSEDE_PENALTY;
  if (opts.detail) score -= ACT_DETAIL_PENALTY;
  score += opts.dateAdjustment || 0;
  return score;
}

function dateActivationAdjustment(firstSeen, range) {
  if (!range || !firstSeen) return 0;
  const day = String(firstSeen).slice(0, 10);
  if (day >= range.lo && day <= range.hi) return 0.2;
  if (day > range.hi) return -0.2;
  return 0;
}

function rankSeedCandidates(rows, opts = {}) {
  const survivors = opts.survivors || new Map();
  const pool = new Set(rows.map((r) => r.signature));
  return rows
    .map((r, index) => {
      const successor = survivors.get(r.signature);
      const superseded = !!(successor && pool.has(successor));
      const cosine = 1 - r.distance;
      return {
        ...r,
        seed_activation: activationScore(cosine, r.strength, {
          dateIntent: !!opts.dateIntent,
          histIntent: !!opts.histIntent,
          superseded,
          dateAdjustment: dateActivationAdjustment(r.first_seen, opts.dateRange),
        }),
        _seed_index: index,
      };
    })
    .sort((a, b) => (b.seed_activation - a.seed_activation) || (a.distance - b.distance) || (a._seed_index - b._seed_index));
}

// Decode a sqlite-vec float32 blob into a Float32Array. Node Buffers can sit at any
// byteOffset in a shared pool (not guaranteed 4-byte aligned), so read floats explicitly
// rather than aliasing the ArrayBuffer (which would throw on an unaligned offset).
function fromVecBlob(buf) {
  const f = new Float32Array(buf.length / 4);
  for (let i = 0; i < f.length; i += 1) f[i] = buf.readFloatLE(i * 4);
  return f;
}
// Embeddings are L2-normalized (embed.js normalize:true), so cosine similarity == dot product.
function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

function loadSupersededBy(db, signatures) {
  const sigs = [...new Set(signatures)].filter(Boolean);
  const out = new Map();
  if (!sigs.length) return out;
  const json = JSON.stringify(sigs);
  const rows = db.prepare(`
    SELECT src, dst, first_seen
    FROM edges
    WHERE rel='supersedes'
      AND (
        src IN (SELECT value FROM json_each(?))
        OR dst IN (SELECT value FROM json_each(?))
      )
  `).all(json, json);
  for (const e of rows) {
    const prev = out.get(e.dst);
    const t = Date.parse(e.first_seen || "") || 0;
    if (!prev || t >= prev.t) out.set(e.dst, { survivor: e.src, t });
  }
  return out;
}

function parseArgs(argv) {
  const args = { query: "", maxHops: 2, seedLimit: 4, k: 12, nodeLimit: 80, asOf: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--query") args.query = argv[++i] || "";
    else if (a === "--max-hops") args.maxHops = Number(argv[++i]);
    else if (a === "--seed-limit") args.seedLimit = Number(argv[++i]);
    else if (a === "--k") args.k = Number(argv[++i]);
    else if (a === "--node-limit") args.nodeLimit = Number(argv[++i]);
    else if (a === "--as-of") args.asOf = argv[++i] || "";
    else if (!a.startsWith("--")) args.query += `${args.query ? " " : ""}${a}`;
  }
  args.maxHops = Math.max(1, Math.min(3, args.maxHops || 2));
  args.seedLimit = Math.max(1, Math.min(8, args.seedLimit || 4));
  args.k = Math.max(args.seedLimit, Math.min(50, args.k || 12));
  args.nodeLimit = Math.max(10, Math.min(200, args.nodeLimit || 80));
  return args;
}

// Parse a temporal window from a natural-language query so the cold bookshelf can be
// looked up by TIME (not just semantic/keyword). first_seen is stored ISO ("2026-06-25T..")
// which a query like "June 25" never LIKE-matches — this bridges NL dates to an ISO range.
// Returns { lo, hi } inclusive ISO-date bounds (YYYY-MM-DD) or null when no date intent.
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
function pad2(n) { return String(n).padStart(2, "0"); }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function parseDateRange(query, nowRef) {
  const q = String(query || "").toLowerCase();
  const defYear = (nowRef instanceof Date && !Number.isNaN(nowRef.getTime())) ? nowRef.getFullYear() : new Date().getFullYear();
  // 1) ISO full date  2026-06-25
  let m = q.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const d = `${m[1]}-${m[2]}-${m[3]}`; return { lo: d, hi: d }; }
  // 2) ISO month  2026-06
  m = q.match(/(\d{4})-(\d{2})(?!\d)/);
  if (m) { const y = +m[1], mo = +m[2]; return { lo: `${m[1]}-${m[2]}-01`, hi: `${m[1]}-${m[2]}-${pad2(lastDay(y, mo))}` }; }
  // 3) numeric date (US host convention): 2/27 or 2/27/2026.
  m = q.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/(\d{4}))?\b/);
  if (m) {
    const mo = +m[1], yr = m[3] ? +m[3] : defYear, d = Math.min(+m[2], lastDay(yr, mo));
    const iso = `${yr}-${pad2(mo)}-${pad2(d)}`;
    return { lo: iso, hi: iso };
  }
  // 4) cross-month named range: May 27 to June 2 [2026].
  const monthNames = Object.keys(MONTHS).join("|");
  m = q.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\s*(?:-|–|to|through)\\s*(${monthNames})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\b`, "i"));
  if (m) {
    const mo1 = MONTHS[m[1]], mo2 = MONTHS[m[4]];
    let y1 = m[3] ? +m[3] : defYear;
    let y2 = m[6] ? +m[6] : y1;
    if (!m[6] && mo2 < mo1) y2 += 1;
    const d1 = Math.min(+m[2], lastDay(y1, mo1));
    const d2 = Math.min(+m[5], lastDay(y2, mo2));
    return { lo: `${y1}-${pad2(mo1)}-${pad2(d1)}`, hi: `${y2}-${pad2(mo2)}-${pad2(d2)}` };
  }
  // 5) month name (+ optional qualifier / day / year)
  const monthRe = new RegExp(`(late|early|mid|middle|end of|beginning of)?\\s*(${Object.keys(MONTHS).join("|")})\\b(?:\\s+(\\d{1,2})(?!\\d))?(?:\\s*[-–to]{1,3}\\s*(\\d{1,2})(?!\\d))?(?:,?\\s*(\\d{4}))?`, "i");
  m = q.match(monthRe);
  if (m) {
    if (m[2].toLowerCase() === "may" && !m[1] && !m[3] && !m[5]) {
      const temporalMay = /\b(?:in|during|from|since|through|throughout)\s+may\b|\bmay\s+(?:events?|incidents?|changes?|updates?|notes?|summary|timeline|records?)\b/i.test(q);
      if (!temporalMay) m = null;
    }
  }
  if (m) {
    const qual = m[1] || "", mo = MONTHS[m[2]], d1 = m[3] ? +m[3] : null, d2 = m[4] ? +m[4] : null, yr = m[5] ? +m[5] : defYear;
    const ld = lastDay(yr, mo);
    if (d1 && d2) return { lo: `${yr}-${pad2(mo)}-${pad2(Math.min(d1, d2))}`, hi: `${yr}-${pad2(mo)}-${pad2(Math.min(ld, Math.max(d1, d2)))}` };
    if (d1) { const d = `${yr}-${pad2(mo)}-${pad2(Math.min(d1, ld))}`; return { lo: d, hi: d }; }
    // whole month, optionally narrowed by qualifier
    let lo = 1, hi = ld;
    if (/late|end of/.test(qual)) { lo = 21; hi = ld; }
    else if (/early|beginning of/.test(qual)) { lo = 1; hi = 10; }
    else if (/mid|middle/.test(qual)) { lo = 11; hi = 20; }
    return { lo: `${yr}-${pad2(mo)}-${pad2(lo)}`, hi: `${yr}-${pad2(mo)}-${pad2(hi)}` };
  }
  // 6) RELATIVE phrases resolved against nowRef (the --as-of anchor, else system now). Explicit
  // dates/months above take precedence; this fills natural temporal language so queries like
  // "what happened last week", "yesterday", "in the past 3 days" reliably trigger the date-window
  // (archive_time) scan instead of falling back to blind topical recall. Windows are rolling
  // [nowRef-N, nowRef] inclusive; the DB compares on the date prefix so events on `hi` are included.
  const base = (nowRef instanceof Date && !Number.isNaN(nowRef.getTime())) ? new Date(nowRef) : new Date();
  const iso = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  const back = (n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() - n); return d; };
  const win = (n) => ({ lo: iso(back(n)), hi: iso(base) });
  const clampN = (s, max) => Math.max(1, Math.min(max, parseInt(s, 10) || 1));
  if (/\bday before yesterday\b/.test(q)) { const d = iso(back(2)); return { lo: d, hi: d }; }
  if (/\byesterday\b/.test(q)) { const d = iso(back(1)); return { lo: d, hi: d }; }
  if (/\btoday\b/.test(q)) { const d = iso(base); return { lo: d, hi: d }; }
  // "last/past N day(s)|week(s)|month(s)"
  m = q.match(/\b(?:last|past|previous|prior)\s+(\d{1,3})\s+(day|week|month)s?\b/);
  if (m) { const unit = m[2], mult = unit === "day" ? 1 : unit === "week" ? 7 : 31; return win(clampN(m[1], unit === "day" ? 90 : unit === "week" ? 26 : 24) * mult); }
  // "last/past few|several|couple days|weeks"
  if (/\b(?:last|past|recent|these past)\s+(?:few|several|couple(?:\s+of)?)\s+days\b/.test(q)) return win(7);
  if (/\b(?:last|past|recent|these past)\s+(?:few|several|couple(?:\s+of)?)\s+weeks\b/.test(q)) return win(21);
  // singular period windows
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+week\b/.test(q)) return win(7);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+month\b/.test(q)) return win(31);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+quarter\b/.test(q)) return win(92);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+year\b/.test(q)) return win(365);
  if (/\b(?:recently|lately|of late|in recent days)\b/.test(q)) return win(10);
  return null;
}

const STOP = new Set(
  "the a an is are was were of for to in on and or that with as at by from this its not be no into what which who whom whose when where why how did do does has have had will would should could about over under more most than then them they their our your you i me my we us work works working update updates updated status note notes keep keeps keeping kept reminder reminders daily weekly monthly today yesterday tomorrow".split(" ")
);

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/^\s*\[[^\]]+\]\s*/, " ")
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scopeTag(text) {
  const m = String(text || "").match(/^\s*\[([^\]]{1,80})\]/);
  return m ? normalizeForMatch(m[1]) : "";
}

function phraseHits(hay, phrases) {
  if (!phrases.length) return 0;
  const padded = ` ${hay} `;
  return phrases.reduce((a, p) => a + (padded.includes(` ${p} `) ? 1 : 0), 0);
}

function compareDetailCandidate(a, b) {
  return (b.phraseHits - a.phraseHits)
    || (b.hits - a.hits)
    || (b.parentIsSeed - a.parentIsSeed)
    || (a.parentHops - b.parentHops)
    || (b.parentStrength - a.parentStrength)
    || ((b.strength || 0) - (a.strength || 0))
    || ((Date.parse(b.first_seen || "") || 0) - (Date.parse(a.first_seen || "") || 0));
}

function collapseKeys(fact, enumerative) {
  const norm = normalizeForMatch(fact);
  const scope = scopeTag(fact);
  const keys = [];
  if (norm) keys.push(`text:${norm}`);
  // Non-enumerative queries need one representative sidecar per scoped daily
  // re-emission, not one atom per day. Enumerative queries may legitimately need
  // several facts under the same scope, so exact-text collapse still applies.
  if (scope && !enumerative) keys.push(`scope:${scope}`);
  return keys;
}

// Significant query terms shared by the lexical-seed channel and the Tier-3 keyword tiers.
// Mirrors the `terms` extraction downstream (kept in one place so both stay in sync).
function significantTerms(query, limit) {
  return [...new Set((String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((t) => !STOP.has(t)))].slice(0, limit || 10);
}

// HYBRID LEXICAL SEEDS. Dense cosine seeding buries a specific committed fact whose long
// sentence dilutes its embedding (measured: the gold q122 answer sits at cosine rank #9)
// beneath ~100 generic near-duplicate restatements of the same standing posture — even
// though that fact UNIQUELY carries the query's discriminating terms (lexical rank #1, 5
// term hits vs <=3 for every competitor). A pure term-overlap LIKE scan over ACTIVE facts
// surfaces such a fact. We return its strongest matches as SUPPLEMENTARY seeds: they are
// ADDED to (never substituted for) the cosine seeds, so a purely-semantic query is
// unchanged, while a lexically-distinctive fact gets pulled into the graph walk where the
// downstream cosine-dominant activation ranker can float it. Additive by construction, so
// the blast radius is bounded — an off-topic lexical coincidence merely adds a node the
// ranker scores low. `minHitsFloor`/`budget` are exposed for testing.
function selectLexicalSeeds(db, query, opts = {}) {
  const budget = opts.budget != null ? opts.budget : 2;
  const terms = opts.terms || significantTerms(query);
  if (terms.length < 2 || budget <= 0) return [];
  // Require a lexically-distinctive match: at least 2 terms, and at least ~40% of the
  // query's significant terms — enough to demand the fact is ABOUT the query, not a
  // one-token coincidence, without over-fitting to any single question.
  const minHits = Math.max(opts.minHitsFloor || 2, Math.ceil(terms.length * 0.4));
  const perTerm = terms.map(() => "(lower(fact) LIKE ?)");
  const hitExpr = perTerm.map((p) => `(CASE WHEN ${p} THEN 1 ELSE 0 END)`).join(" + ");
  const likeParams = terms.map((t) => `%${t}%`);
  const rows = db.prepare(
    `SELECT signature, COALESCE(strength, 0) AS strength, (${hitExpr}) AS hits
     FROM nodes
     WHERE kind='fact' AND (notes IS NULL OR notes <> 'archive') AND (${perTerm.join(" OR ")})
     ORDER BY hits DESC, strength DESC
     LIMIT 100`
  ).all(...likeParams, ...likeParams);
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
  const out = [];
  for (const r of rows) {
    if (r.hits < minHits) break; // rows are hit-desc, so once below floor all remaining are too
    if (exclude.has(r.signature)) continue;
    out.push({ signature: r.signature, hits: r.hits, strength: r.strength });
    if (out.length >= budget) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.query.trim()) {
    console.error('Usage: node lib/recall.js --query "<text>" [--max-hops 2]');
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);

  const qFloat = await embedOne(args.query);
  const qvec = toVecBlob(qFloat);
  const seedNowRef = args.asOf ? new Date(args.asOf) : new Date();
  const seedDateRange = parseDateRange(args.query, seedNowRef);
  const seedDateIntent = seedDateRange != null;
  const histIntent = seedDateIntent
    || /\b(as of|during|origin(?:al|ally)?|before it|previous(?:ly)?|used to|initially|initial|at the time|back then)\b/i.test(args.query || "");

  // 1) Vector KNN -> candidate seeds (cosine distance; lower = closer). Seeds are FACTS
  //    only: entity hubs are also embedded, but a hub seed consumes a limited seed slot
  //    and (being generic) starts the graph walk from a broad connector, diluting the
  //    cluster. Hubs still enter the cluster as walk frontier via fact co-mention edges.
  const knn = db.prepare(`
    SELECT n.signature AS signature, n.strength AS strength, n.class AS class, n.first_seen AS first_seen, v.distance AS distance
    FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
    JOIN nodes n ON n.id = v.rowid
    WHERE n.kind = 'fact'
    ORDER BY v.distance
  `).all(qvec, Math.max(args.k * 8, 64));

  // A correction is stored as (newer)--supersedes-->(older). Load only edges
  // touching the bounded candidate pool instead of scanning every correction in
  // the store; stale candidates remain available but rank below a co-retrieved
  // survivor.
  const seedSupersededBy = loadSupersededBy(db, knn.map((r) => r.signature));

  // Seed selection with supersede demotion: when BOTH a stale version and its surviving
  // correction are vector-retrieved, we are choosing between two versions of the SAME fact —
  // sink the stale one below its survivor so the current value seeds the cluster (and lands
  // at the top of what the agent reads). When the survivor was not retrieved, the stale node
  // keeps its vector position (it may be the only answer we have). Pure distance order is
  // otherwise preserved.
  const rankedKnn = rankSeedCandidates(knn, {
    dateIntent: seedDateIntent,
    histIntent,
    dateRange: seedDateRange,
    survivors: new Map([...seedSupersededBy].map(([stale, v]) => [stale, v.survivor])),
  });

  const seedRows = rankedKnn.slice(0, args.seedLimit);
  const cosineSeeds = seedRows.map((r) => r.signature);

  // Supplement the cosine seeds with lexically-distinctive ACTIVE facts (hybrid dense+sparse
  // seeding). ADDITIVE: cosine seeds are never displaced, so semantic-only queries are
  // unchanged; a fact that uniquely carries the query's discriminating terms but has merely
  // mediocre cosine (long-sentence embedding dilution, drowned in a dense restatement cluster)
  // now seeds the walk and can be floated by the downstream activation ranker.
  const lexSeedRows = selectLexicalSeeds(db, args.query, { exclude: new Set(cosineSeeds), budget: 2 });
  const lexSeeds = lexSeedRows.map((r) => r.signature);
  const lexSeedSet = new Set(lexSeeds);
  const seeds = [...cosineSeeds, ...lexSeeds];

  // Graph expansion runs only when we have vector seeds; but the Tier-3 keyword search
  // below MUST run regardless (an archive-only DB, or a query whose answer was demoted,
  // has zero embedded seeds yet may be answerable from the bookshelf). So we no longer
  // early-return on empty seeds — we fall through to the keyword tier.
  let clusterRows = [];
  if (seeds.length > 0) {
    const seedsJson = JSON.stringify(seeds);
    // The graph is undirected for recall, so we walk edges in BOTH directions. Earlier this
    // materialised a `bidir` UNION view over the whole edges table and joined the recursive walk
    // against it — but a CTE-derived view is not indexable, so every recursion step full-scanned
    // ~2x the edge count (measured 17s over a 1.16M-edge store). Joining the base `edges` table
    // directly in two recursive terms lets SQLite use idx_edges_src / idx_edges_dst, so each step
    // touches only the local frontier (measured 2.5s, byte-identical reachable set). maxHops is
    // bound twice (once per direction term).
    clusterRows = db.prepare(`
      WITH RECURSIVE
      walk(sig, hops) AS (
        SELECT value, 0 FROM json_each(?)
        UNION
        SELECT e.dst, walk.hops + 1 FROM walk JOIN edges e ON e.src = walk.sig WHERE walk.hops < ?
        UNION
        SELECT e.src, walk.hops + 1 FROM walk JOIN edges e ON e.dst = walk.sig WHERE walk.hops < ?
      )
      SELECT w.sig AS signature, MIN(w.hops) AS hops,
             COALESCE(n.strength, 0) AS strength, n.class AS class, n.fact AS fact, n.kind AS kind,
             n.first_seen AS first_seen, n.notes AS notes, n.vagueness AS vagueness
      FROM walk w LEFT JOIN nodes n ON n.signature = w.sig
      GROUP BY w.sig
      ORDER BY hops ASC, strength DESC, signature ASC
      LIMIT ?
    `).all(seedsJson, args.maxHops, args.maxHops, args.nodeLimit);
  }

  // 1b) SEQUENCE-CHAIN EXPANSION. A `sequence` edge records the temporally-ordered evolution of
  // ONE standing statement (built nightly in dream.js). The bounded graph walk above only reaches
  // +/- maxHops along a chain, so a long lineage hit at one end loses the far end — exactly the
  // failure where a generic high-ranking restatement is retrieved but the low-cosine *delta*
  // ("...reset confirmed...") sits dozens of ranks away and never seeds. Here ANY retrieved chain
  // member pulls in its ENTIRE connected sequence component (one EPISODE), so one hit returns the
  // whole event chain. Each touched component is expanded INDEPENDENTLY (per-chain budget) so no
  // single chain starves the others under a shared budget, and every member is tagged with a
  // component id (`chain_id`) so the consumer can complete the chain of the SPECIFIC hit it
  // belongs to instead of a global cross-topic pool. 1c then collapses near-identical members.
  //
  // TOPIC-COHESION GATE: a connected `sequence` component can span MORE than one standing
  // statement if two lineages were ever linked, and even a clean single-statement chain is
  // useless to THIS query when it belongs to an unrelated topic that merely shares a high-ranking
  // restatement's neighbourhood. Pulling a whole off-topic lineage in floods recall with
  // cross-topic deltas (measured: 5-8 of 15 delivered slots were unrelated chains like "Yuki's
  // forecast bridge" on Caldwell/ERP queries). So an EXPANDED member (one not already in the
  // cluster on its own merits) is admitted only if it shares >=2 significant content tokens with
  // the query — keeping the queried statement's own evolution while dropping unrelated lineages.
  const qTokens = new Set((args.query.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 4 && !STOP.has(w)));
  const sharesQueryTopic = (txt) => {
    let n = 0;
    for (const w of new Set((String(txt || "").toLowerCase().match(/[a-z0-9]+/g) || []))) {
      if (w.length > 4 && !STOP.has(w) && qTokens.has(w) && ++n >= 2) return true;
    }
    return false;
  };
  let chainIdBySig = new Map();
  if (clusterRows.length) {
    const PER_CHAIN_MAX = 40; // bound ONE episode (collapses to a few distinct in 1c)
    const TOUCHED_MAX = 400;  // global guard across all touched chains
    const inCluster = new Set(clusterRows.map((r) => r.signature));
    const chainSigs = new Set();
    const component = db.prepare(`
      WITH RECURSIVE walk(sig) AS (
        SELECT ?
        UNION
        SELECT e.dst FROM walk JOIN edges e ON e.src=walk.sig WHERE e.rel='sequence'
        UNION
        SELECT e.src FROM walk JOIN edges e ON e.dst=walk.sig WHERE e.rel='sequence'
      )
      SELECT sig FROM walk LIMIT ?
    `);
    let nextChain = 0;
    for (const seed of inCluster) {
      if (chainIdBySig.has(seed)) continue; // component already expanded via another seed
      if (chainSigs.size >= TOUCHED_MAX) break;
      const members = component.all(seed, PER_CHAIN_MAX).map((r) => r.sig);
      if (members.length <= 1) continue;
      const id = nextChain++;
      for (const sig of members) {
        chainIdBySig.set(sig, id);
        if (!inCluster.has(sig)) chainSigs.add(sig);
      }
    }
    if (chainSigs.size) {
      const ph = [...chainSigs].map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT signature, COALESCE(strength,0) AS strength, class, fact, kind, first_seen, notes, vagueness
         FROM nodes WHERE kind='fact' AND signature IN (${ph})`
      ).all(...chainSigs);
      for (const r of rows) if (sharesQueryTopic(r.fact)) clusterRows.push({ ...r, hops: 1, via: "sequence" });
    }
  }

  // 1c) IDENTICAL-RESTATEMENT COLLAPSE. A standing statement is re-emitted VERBATIM on many days
  // (only first_seen differs). Returning 100 identical lines floods the cluster and buries
  // distinct facts; collapse them to ONE representative carrying the observed span so "still
  // active on date X?" stays answerable. Distinct (delta) versions differ in text -> never
  // collapsed; they are surfaced via the sequence chain above. first_seen on the representative
  // is the LATEST sighting (recency-correct "still asserted as of"); observed_since keeps the
  // origin. No-op when there are no verbatim duplicates (every node keeps observed_count=1).
  if (clusterRows.length) {
    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const repByText = new Map();
    const collapsed = [];
    for (const r of clusterRows) {
      const key = norm(r.fact);
      if (!key) { collapsed.push(r); continue; }
      const rep = repByText.get(key);
      if (!rep) {
        const nr = { ...r, observed_count: 1, observed_since: r.first_seen || null };
        repByText.set(key, nr);
        collapsed.push(nr);
        continue;
      }
      rep.observed_count += 1;
      const rt = Date.parse(r.first_seen || "");
      if (Number.isFinite(rt)) {
        const ft = Date.parse(rep.first_seen || "");
        if (!Number.isFinite(ft) || rt > ft) rep.first_seen = r.first_seen;     // latest sighting
        const st = Date.parse(rep.observed_since || "");
        if (!Number.isFinite(st) || rt < st) rep.observed_since = r.first_seen;  // origin
      }
      if ((r.hops || 0) < (rep.hops || 0)) rep.hops = r.hops;
    }
    clusterRows = collapsed;
  }

  const clusterSet = new Set(clusterRows.map((r) => r.signature));

  // Significant query terms (shared by the detail-expansion and archive tiers below).
  // Domain stopwords keep standing-intent/daily-status words ("work", "updates",
  // "keep", "note") from opening the archive floodgates by themselves.
  const terms = [...new Set((args.query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((t) => !STOP.has(t)))].slice(0, 8);
  const phrases = [];
  for (let i = 0; i < terms.length - 1; i += 1) phrases.push(`${terms[i]} ${terms[i + 1]}`);
  for (let i = 0; i < terms.length - 2; i += 1) phrases.push(`${terms[i]} ${terms[i + 1]} ${terms[i + 2]}`);

  // 2a) R2 — PARENT-FIRST DETAIL SIDECAR.
  // A retrieved GIST is an instinct; R2 may drill down to archived atomic details only
  // when the parent is strong and the detail is genuinely unreachable. These sidecars
  // are globally budgeted/collapsed so they add dated specifics without flooding or
  // displacing the primary seed/gist/graph cluster.
  const enumerative = /\b(all|each|every|list|enumerate|which|who\s+were|how\s+many|name\s+the)\b/i.test(args.query);
  const detailBudget = enumerative ? 5 : 4;
  const parentLimit = enumerative ? 5 : 4;
  const seedSet = new Set(seeds);
  const seedRank = new Map(seeds.map((s, i) => [s, i]));
  const minTermHits = terms.length <= 1 ? 1 : 2;
  const strongGists = clusterRows
    .filter((r) => r.notes && /\bgist\b/.test(r.notes))
    .filter((r) => seedSet.has(r.signature) || (r.hops <= 1 && (r.strength || 0) >= 0.55))
    .sort((a, b) => {
      const ar = seedRank.has(a.signature) ? seedRank.get(a.signature) : 999;
      const br = seedRank.has(b.signature) ? seedRank.get(b.signature) : 999;
      return ar - br || a.hops - b.hops || (b.strength || 0) - (a.strength || 0) || a.signature.localeCompare(b.signature);
    })
    .slice(0, parentLimit);
  let detailRows = [];
  if (strongGists.length) {
    let detailStmt = null;
    try {
      detailStmt = db.prepare(
        `SELECT n.signature AS signature, n.fact AS fact, n.first_seen AS first_seen,
                n.strength AS strength, n.class AS class, n.notes AS notes
         FROM detail_of d JOIN nodes n ON n.signature = d.detail_sig
         WHERE d.gist_sig = ? AND n.kind='fact' AND n.notes='archive'`
      );
    } catch (e) { detailStmt = null; /* pre-migration DB without detail_of */ }
    if (detailStmt) {
      const bySig = new Map();
      for (const g of strongGists) {
        for (const r of detailStmt.all(g.signature)) {
          if (clusterSet.has(r.signature)) continue;
          const hay = `${normalizeForMatch(r.fact)} ${String(r.first_seen || "").toLowerCase()}`;
          const hits = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
          const ph = phraseHits(hay, phrases);
          // Tight relevance gate: require a phrase hit or multi-term evidence (unless
          // enumerative). This keeps broad daily standing-intent atoms out.
          if (!enumerative && !(ph > 0 || hits >= minTermHits)) continue;
          const cand = {
            ...r,
            hits,
            phraseHits: ph,
            parent: g.signature,
            parentHops: g.hops,
            parentStrength: g.strength || 0,
            parentIsSeed: seedSet.has(g.signature) ? 1 : 0,
          };
          const prev = bySig.get(r.signature);
          if (!prev || compareDetailCandidate(cand, prev) < 0) bySig.set(r.signature, cand);
        }
      }
      const usedKeys = new Set();
      for (const r of [...bySig.values()].sort(compareDetailCandidate)) {
        const keys = collapseKeys(r.fact, enumerative);
        if (keys.some((k) => usedKeys.has(k))) continue;
        for (const k of keys) usedKeys.add(k);
        detailRows.push(r);
        if (detailRows.length >= detailBudget) break;
      }
    }
  }
  const detailSet = new Set(detailRows.map((r) => r.signature));

  // 2b) TIER 3 (bookshelf): keyword scan over the un-embedded archive. These cold facts
  // have no vector and no edges, so vector+graph recall can't reach them — but the detail
  // may be exactly what a specific question needs. Brute-force LIKE over significant query
  // terms (the "I know I read this somewhere, let me dig" tier). Cheap relative to the
  // bench's LLM calls; only scans rows the graph layer already excluded.
  let archiveRows = [];
  if (terms.length) {
    // Match each term against the fact text OR the encode date (first_seen): dated facts
    // often carry the date only in first_seen, not in the text, so a text-only scan misses
    // exactly the temporal/attribution atoms these queries need.
    const perTerm = terms.map(() => "(lower(fact) LIKE ? OR ifnull(lower(first_seen),'') LIKE ?)");
    const whereLike = perTerm.join(" OR ");
    const hitExpr = perTerm.map((p) => `(CASE WHEN ${p} THEN 1 ELSE 0 END)`).join(" + ");
    const likeParams = [];
    for (const t of terms) likeParams.push(`%${t}%`, `%${t}%`);
    // R3(a): SCORE-then-limit. Rank by term-hit count in SQL FIRST, then recency, and only
    // then LIMIT — so an old-but-correct row for a common term ("Caldwell", "board") is no
    // longer truncated out by a recent-first pre-limit before scoring ever happens.
    const rows = db.prepare(
      `SELECT signature, fact, first_seen, strength, class, (${hitExpr}) AS hits
       FROM nodes WHERE kind='fact' AND notes='archive' AND (${whereLike})
       ORDER BY hits DESC, first_seen DESC LIMIT 200`
    ).all(...likeParams, ...likeParams);
    const archiveUsedKeys = new Set(detailRows.flatMap((r) => collapseKeys(r.fact, enumerative)));
    for (const r of rows
      .filter((x) => x.hits > 0 && !clusterSet.has(x.signature) && !detailSet.has(x.signature))
      .sort((a, b) => b.hits - a.hits || (Date.parse(b.first_seen || "") || 0) - (Date.parse(a.first_seen || "") || 0))) {
      const keys = collapseKeys(r.fact, enumerative);
      if (keys.some((k) => archiveUsedKeys.has(k))) continue;
      for (const k of keys) archiveUsedKeys.add(k);
      archiveRows.push(r);
      if (archiveRows.length >= Math.max(4, Math.floor(args.k / 2))) break;
    }
  }
  const archiveSet = new Set(archiveRows.map((r) => r.signature));

  // 2c) TIER 3 (bookshelf) — VECTOR recall over demoted facts. The keyword tier (2b) only
  // finds literal term overlap; this finds the semantically-adjacent archived DETAIL that a
  // cross-reference/synthesis question needs but never names verbatim. Vectors live in the
  // separate vec_archive table (MOVED there at demotion, never re-embedded — principle 1),
  // so this is a SECONDARY, bounded, deduped path. It is tagged tier='archive' so the ranker
  // (dream-search) scores it in the cold band and caps it BELOW the primary seed/gist cluster:
  // it ADDS reachable facts without displacing the active seeds (the A/B starvation failure).
  // Bounded, deduped, cold-band SECONDARY path (always on): archived facts reached by vector
  // similarity via vec_archive. Tagged tier='archive' so the ranker caps it below the active
  // seed/gist cluster — it ADDS reachable facts without displacing active seeds.
  const ARCHIVE_VEC_SIM = 0.5;
  const ARCHIVE_VEC_BUDGET = Math.max(4, Math.floor(args.k / 2));
  let archiveVecRows = [];
  {
    try {
      const av = db.prepare(`
        SELECT n.signature AS signature, n.fact AS fact, n.first_seen AS first_seen,
               n.strength AS strength, n.class AS class, v.distance AS distance
        FROM (SELECT rowid, distance FROM vec_archive WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
        JOIN nodes n ON n.id = v.rowid
        WHERE n.kind='fact' AND n.notes='archive'
        ORDER BY v.distance
      `).all(qvec, Math.max(args.k * 2, 20));
      const usedKeys = new Set([...detailRows, ...archiveRows].flatMap((r) => collapseKeys(r.fact, enumerative)));
      for (const r of av) {
        const sim = 1 - r.distance;
        if (sim < ARCHIVE_VEC_SIM) break; // ordered by distance: once below the gate, stop
        if (clusterSet.has(r.signature) || detailSet.has(r.signature) || archiveSet.has(r.signature)) continue;
        const keys = collapseKeys(r.fact, enumerative);
        if (keys.some((k) => usedKeys.has(k))) continue;
        for (const k of keys) usedKeys.add(k);
        archiveVecRows.push({ ...r, sim });
        if (archiveVecRows.length >= ARCHIVE_VEC_BUDGET) break;
      }
    } catch (e) { archiveVecRows = []; /* store predates vec_archive: skip */ }
  }
  const archiveVecSet = new Set(archiveVecRows.map((r) => r.signature));

  // 2d) TIER 3 (bookshelf) — TIME-WINDOW recall over demoted facts. Tiers 2b/2c reach the
  // archive by keyword/vector similarity but are BLIND to time: a query like "what happened on
  // June 25" names a DATE, not the topic words, so the right archived details are never matched.
  // first_seen is stored ISO ("2026-06-25T.."), which NL dates never LIKE-match. Here we parse a
  // date window from the query and pull archived facts whose first_seen falls inside it, ranked by
  // in-window term relevance then recency. Fires ONLY when the query bears a date (the temporal
  // intent signal), so standing/topical queries never drag in random archived rows. Tagged
  // tier='archive' via='archive_time' so the ranker keeps it in the cold band below active seeds.
  const ARCHIVE_TIME_BUDGET = Math.max(4, Math.floor(args.k / 2));
  let archiveTimeRows = [];
  {
    const asOfDate = args.asOf ? new Date(args.asOf) : new Date();
    const range = parseDateRange(args.query, asOfDate);
    if (range) {
      try {
        const rows = db.prepare(`
          SELECT n.signature AS signature, n.fact AS fact, n.first_seen AS first_seen,
                 n.strength AS strength, n.class AS class
          FROM nodes n
          WHERE n.kind='fact' AND n.notes='archive'
            AND substr(n.first_seen,1,10) BETWEEN ? AND ?
          ORDER BY n.first_seen DESC
        `).all(range.lo, range.hi);
        const usedKeys = new Set([...detailRows, ...archiveRows, ...archiveVecRows].flatMap((r) => collapseKeys(r.fact, enumerative)));
        const scored = rows.map((r) => {
          const hay = normalizeForMatch(r.fact || "");
          const hits = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
          return { ...r, hits };
        }).sort((a, b) => (b.hits - a.hits) || String(b.first_seen).localeCompare(String(a.first_seen)));
        for (const r of scored) {
          if (clusterSet.has(r.signature) || detailSet.has(r.signature) || archiveSet.has(r.signature) || archiveVecSet.has(r.signature)) continue;
          const keys = collapseKeys(r.fact, enumerative);
          if (keys.some((k) => usedKeys.has(k))) continue;
          for (const k of keys) usedKeys.add(k);
          archiveTimeRows.push(r);
          if (archiveTimeRows.length >= ARCHIVE_TIME_BUDGET) break;
        }
      } catch (e) { archiveTimeRows = []; }
    }
  }

  // 2e) ACTIVE date-window detail SIDECAR. Tier 2d reaches only the COLD bookshelf by time; but at
  // moderate horizons the answer to a dated query is usually still an ACTIVE record whose exact-date
  // snapshot ranks just OUTSIDE the cosine seed cap — a specific enumerated "currently on file" list
  // carries lower cosine than the abstract policy gist that paraphrases it, so pure KNN never
  // surfaces (or even reaches) it. When the query names an explicit date/range, pull ACTIVE facts
  // (detail/gist) whose first_seen falls in the window, term-gated + budgeted, and score them by
  // real cosine + a bounded date bonus so the on-date record surfaces. This is RECONSTRUCTIVE
  // temporal navigation entered from the semantic anchor: it fires ONLY on date intent, so timeless
  // standing-preference queries (recency guards) are untouched, and it is term-gated so it never
  // drags in random dated rows.
  const ACTIVE_DATE_BUDGET = 6;
  const ACTIVE_DATE_BOOST = 0.2;
  let activeTimeRows = [];
  {
    const asOfDate2 = args.asOf ? new Date(args.asOf) : new Date();
    const range2 = parseDateRange(args.query, asOfDate2);
    if (range2) {
      try {
        const rows = db.prepare(`
          SELECT n.id AS id, n.signature AS signature, n.fact AS fact, n.first_seen AS first_seen,
                 n.strength AS strength, n.class AS class, n.notes AS notes
          FROM nodes n
          WHERE n.kind='fact' AND (n.notes IS NULL OR n.notes<>'archive')
            AND substr(n.first_seen,1,10) BETWEEN ? AND ?
        `).all(range2.lo, range2.hi);
        // Dedup by TEXT only (enumerative=true skips the scope key): the whole point of a
        // date-window pull is to surface the specific dated record even when a scope-mate (e.g.
        // an abstract "family items stay private" gist) is already present in another tier.
        const usedKeys = new Set([...detailRows, ...archiveRows, ...archiveVecRows, ...archiveTimeRows].flatMap((r) => collapseKeys(r.fact, true)));
        const temporalWords = new Set([...Object.keys(MONTHS), "happened", "event", "events", "incident", "incidents", "change", "changed", "changes", "update", "updates", "summary", "timeline", "record", "records"]);
        const topicTerms = terms.filter((t) =>
          !temporalWords.has(t)
          && !/^\d+$/.test(t)
          && !/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)
        );
        const scored = rows.map((r) => {
          const hay = normalizeForMatch(r.fact || "");
          const hits = topicTerms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
          return { ...r, hits };
        }).filter((r) => topicTerms.length === 0 || r.hits >= 1)
          .sort((a, b) => (b.hits - a.hits) || String(b.first_seen).localeCompare(String(a.first_seen)));
        for (const r of scored) {
          if (clusterSet.has(r.signature) || detailSet.has(r.signature) || archiveSet.has(r.signature) || archiveVecSet.has(r.signature)) continue;
          const keys = collapseKeys(r.fact, true);
          if (keys.some((k) => usedKeys.has(k))) continue;
          for (const k of keys) usedKeys.add(k);
          activeTimeRows.push(r);
          if (activeTimeRows.length >= ACTIVE_DATE_BUDGET) break;
        }
        if (activeTimeRows.length) {
          const ph = activeTimeRows.map(() => "?").join(",");
          const vrows = db.prepare(`SELECT rowid, embedding FROM vec_nodes WHERE rowid IN (${ph})`).all(...activeTimeRows.map((r) => r.id));
          const cosById = new Map();
          for (const v of vrows) if (v.embedding) cosById.set(v.rowid, dot(qFloat, fromVecBlob(v.embedding)));
          for (const r of activeTimeRows) r.cos = cosById.has(r.id) ? cosById.get(r.id) : 0;
        }
      } catch (e) { activeTimeRows = []; }
    }
  }

  // 3) Edges fully inside the cluster.
  const clusterJson = JSON.stringify([...clusterSet]);
  const clusterEdges = (clusterSet.size ? db.prepare(`
    SELECT src, rel, dst, weight
    FROM edges
    WHERE src IN (SELECT value FROM json_each(?))
      AND dst IN (SELECT value FROM json_each(?))
  `).all(clusterJson, clusterJson) : [])
    .sort((a, b) => b.weight - a.weight || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));

  // Real per-node cosine for ACTIVE cluster nodes (A2 activation ranking). The bounded seed
  // KNN (k*2) misses reinforced consolidated facts that only reach the pool via the graph walk;
  // those get scored by a flat tier band downstream and sink below stale-but-similar restatements.
  // Fetch each active node's embedding once (while the db is open) so activation = cosine +
  // lambda*strength can rank the true answer above surface-similar noise. Embeddings are
  // L2-normalized, so cosine == dot(qFloat, nodeVec).
  const cosBySig = new Map();
  for (const r of seedRows) cosBySig.set(r.signature, 1 - r.distance); // seeds already carry it
  const needCos = clusterRows.map((r) => r.signature).filter((s) => !cosBySig.has(s));
  if (needCos.length) {
    const ph = needCos.map(() => "?").join(",");
    const idRows = db.prepare(`SELECT id, signature FROM nodes WHERE signature IN (${ph})`).all(...needCos);
    if (idRows.length) {
      const idToSig = new Map(idRows.map((r) => [r.id, r.signature]));
      const ph2 = idRows.map(() => "?").join(",");
      const vrows = db.prepare(`SELECT rowid, embedding FROM vec_nodes WHERE rowid IN (${ph2})`).all(...idRows.map((r) => r.id));
      for (const v of vrows) {
        const sig = idToSig.get(v.rowid);
        if (sig != null && v.embedding) cosBySig.set(sig, dot(qFloat, fromVecBlob(v.embedding)));
      }
    }
  }

  // "Now" for relative-age tags: explicit --as-of, else the latest memory in the
  // cluster (the bench simulates time, so we anchor to the most recent fact seen).
  const latest = clusterRows.reduce((m, r) => {
    const t = Date.parse(r.first_seen || "");
    return t && t > m ? t : m;
  }, 0);
  const nowRef = args.asOf ? new Date(args.asOf) : (latest ? new Date(latest) : new Date());
  const dateRange = parseDateRange(args.query, nowRef);
  const dateIntent = dateRange != null;

  // 2f) ANCHOR-DAY active recall (DATELESS episode reconstruction). Tiers 2d/2e reconstruct a dated
  // window ONLY when the query NAMES a date. But a specifics/completeness question usually names only
  // the TOPIC ("what exact format did Jordan record for Marcus, and did he move any calendar items
  // THAT SESSION?") — no date, yet the answer is the set of items from the DAY the topic anchors to.
  // Tier 2a drills a gist down its SEMANTIC tree (gist -> its own detail_of children); this instead
  // reconstructs the TEMPORAL EPISODE: the sibling facts recorded the SAME DAY as the strongest
  // on-topic DATED hit, which 2a never reaches because they are not detail_of the matched gist. This
  // is what lets the agent enumerate an episode's specifics AND reason about ABSENCE ("nothing else
  // moved that day") — a ranked top-K cannot confirm a negative. Fires only when specifics are sought
  // (enumerative / "exact" / "that session" intent, or the top anchor is a vagueness-flagged gist)
  // AND the query bears NO explicit date (2d/2e own that case), so standing/synthesis queries are
  // untouched. Anchor days come from the highest-cosine NON-gist dated records (a gist's first_seen is
  // a latest-sighting, not the episode date). Term-gated + budgeted so it ADDS the episode's relevant
  // records without flooding; tagged via='anchor_day'. Engine-native so BOTH the live graph-recall
  // skill and any flat projection inherit it (not a bench-only file trick).
  const specificsIntent = enumerative || /\b(exact|exactly|precise|verbatim|specific|list|which|how\s+many|enumerate|that\s+(session|meeting|day|call|week|conversation)|in\s+that\s+(session|meeting|call))\b/i.test(args.query || "");
  const ANCHOR_COS_FLOOR = 0.30;
  let anchorDayRows = [];
  if (!dateIntent && terms.length) {
    const dayOf = (fs) => String(fs || "").slice(0, 10);
    const isGistRow = (r) => !!(r.notes && /\bgist\b/.test(r.notes));
    const anchorCand = clusterRows
      .filter((r) => !isGistRow(r) && dayOf(r.first_seen))
      .map((r) => ({ r, cos: cosBySig.has(r.signature) ? cosBySig.get(r.signature) : 0 }))
      .sort((a, b) => b.cos - a.cos);
    // The top overall hit being a vagueness-flagged gist is itself a "specifics live elsewhere" signal.
    let topAnchorIsVagueGist = false;
    {
      let best = null, bc = -1;
      for (const r of clusterRows) {
        const c = cosBySig.has(r.signature) ? cosBySig.get(r.signature) : 0;
        if (c > bc) { bc = c; best = r; }
      }
      topAnchorIsVagueGist = !!(best && isGistRow(best) && best.vagueness != null && best.vagueness >= 0.35);
    }
    if ((specificsIntent || topAnchorIsVagueGist) && anchorCand.length && anchorCand[0].cos >= ANCHOR_COS_FLOOR) {
      const days = [];
      for (const c of anchorCand) {
        const d = dayOf(c.r.first_seen);
        if (d && !days.includes(d)) days.push(d);
        if (days.length >= 2) break;
      }
      if (days.length) {
        try {
          const dph = days.map(() => "?").join(",");
          const rows = db.prepare(`
            SELECT n.id AS id, n.signature AS signature, n.fact AS fact, n.first_seen AS first_seen,
                   n.strength AS strength, n.class AS class, n.notes AS notes
            FROM nodes n
            WHERE n.kind='fact' AND n.notes IN ('detail','gist','harness-ingest')
              AND substr(n.first_seen,1,10) IN (${dph})
          `).all(...days);
          const usedKeys = new Set([...detailRows, ...archiveRows, ...archiveVecRows, ...archiveTimeRows, ...activeTimeRows].flatMap((r) => collapseKeys(r.fact, true)));
          const scored = rows.map((r) => {
            const hay = normalizeForMatch(r.fact || "");
            const hits = terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
            return { ...r, hits };
          }).filter((r) => r.hits >= 1)
            .sort((a, b) => (b.hits - a.hits) || String(b.first_seen).localeCompare(String(a.first_seen)));
          const ANCHOR_DAY_BUDGET = 12;
          for (const r of scored) {
            if (clusterSet.has(r.signature) || detailSet.has(r.signature) || archiveSet.has(r.signature) || archiveVecSet.has(r.signature)) continue;
            if (activeTimeRows.some((x) => x.signature === r.signature)) continue;
            if (anchorDayRows.some((x) => x.signature === r.signature)) continue;
            const keys = collapseKeys(r.fact, true);
            if (keys.some((k) => usedKeys.has(k))) continue;
            for (const k of keys) usedKeys.add(k);
            anchorDayRows.push(r);
            if (anchorDayRows.length >= ANCHOR_DAY_BUDGET) break;
          }
          if (anchorDayRows.length) {
            const ph = anchorDayRows.map(() => "?").join(",");
            const vrows = db.prepare(`SELECT rowid, embedding FROM vec_nodes WHERE rowid IN (${ph})`).all(...anchorDayRows.map((r) => r.id));
            const cosById = new Map();
            for (const v of vrows) if (v.embedding) cosById.set(v.rowid, dot(qFloat, fromVecBlob(v.embedding)));
            for (const r of anchorDayRows) r.cos = cosById.has(r.id) ? cosById.get(r.id) : 0;
          }
        } catch (e) { anchorDayRows = []; }
      }
    }
  }

  const supersededBy = loadSupersededBy(db, [
    ...clusterRows,
    ...detailRows,
    ...archiveRows,
    ...archiveVecRows,
    ...archiveTimeRows,
    ...activeTimeRows,
    ...anchorDayRows,
  ].map((r) => r.signature));

  db.close();

  // ---- Activation ranking (P11) ------------------------------------------------------------
  // ACTIVATION = cosine + lambda*strength: rerank ACTIVE nodes so a reinforced consolidated fact
  // (high ACT-R base-level activation = recency x frequency x schema, held in `strength`) can
  // outrank a stale low-strength restatement that merely shares surface tokens. Cosine-dominant
  // and SEMANTICALLY GATED — the strength bonus applies only once a node clears a cosine floor,
  // so an off-topic strong fact is never promoted. This is seed/relevance SELECTION incl. strength,
  // NOT a global time-reorder of rendered context (ARCHITECTURE principle 6 caution).
  // Detail is the granular lookup-only tier (a merge's kept members / drilled corrections). When a
  // detail fact is pulled into the GENERAL semantic cluster (graph/sequence walk) it must not out-rank
  // co-retrieved gist/episodic facts of similar cosine: for a window/synthesis query ("how did X evolve
  // over these days") an out-of-window detail revision otherwise seeds the top of what the agent reads,
  // right beside the timeless gist, and the answerer conflates them into a false in-window narrative
  // (q035: a March $465M revision surfacing for a January window). A modest penalty sinks such detail
  // below same-topic gist/episodic while leaving high-cosine detail (exact-figure lookups whose closest
  // match IS the detail) reachable. The specifics/enumeration path (tiers 2e/2f, active_time/anchor_day)
  // sets its own boosted activation and bypasses this, so intentional detail surfacing is unaffected.
  // A LEXICALLY-SEEDED detail is likewise an intentional surfacing (the query's discriminating terms
  // matched it directly), so it is exempted from this penalty upstream (see isDetail computation).
  const activationOf = (c, s, superseded, detail, firstSeen) => {
    return activationScore(c, s, {
      dateIntent,
      histIntent,
      superseded,
      detail,
      dateAdjustment: dateActivationAdjustment(firstSeen, dateRange),
    });
  };
  const activeNodes = clusterRows.map((r) => {
    const d = ageDays(r.first_seen, nowRef);
    const sup = supersededBy.get(r.signature);
    const cos = cosBySig.has(r.signature) ? cosBySig.get(r.signature) : 0;
    const isDetail = !!(r.notes && /\bdetail\b/.test(r.notes)) && !lexSeedSet.has(r.signature);
    const activation = activationOf(cos, r.strength, !!sup, isDetail, r.first_seen);
    return {
      id: r.signature, hops: r.hops, strength: Number(r.strength.toFixed(4)), class: r.class,
      kind: r.kind, fact: (r.fact || "").trim(),
      first_seen: r.first_seen || null,
      age_days: d,
      age: ageTag(d),
      superseded: !!sup,
      superseded_by: sup ? sup.survivor : null,
      tier: (r.notes && /\bgist\b/.test(r.notes)) ? "gist" : (r.notes && /\bdetail\b/.test(r.notes)) ? "detail" : "episodic",
      vagueness: (r.notes && /\bgist\b/.test(r.notes) && r.vagueness != null) ? Number(r.vagueness.toFixed(3)) : undefined,
      via: r.via || (lexSeedSet.has(r.signature) ? "lexical" : undefined),
      chain_id: chainIdBySig.has(r.signature) ? chainIdBySig.get(r.signature) : undefined,
      observed_count: (r.observed_count && r.observed_count > 1) ? r.observed_count : undefined,
      observed_since: (r.observed_count && r.observed_count > 1) ? (r.observed_since || null) : undefined,
      semantic_similarity: Number(cos.toFixed(4)),
      activation: Number(activation.toFixed(4)),
    };
  });
  // Engine owns the ordering (P5/P11): emit active nodes most-activated first so the live
  // graph-recall skill (which preserves recall order) benefits, not only the bench ranker.
  activeNodes.sort((a, b) => (b.activation - a.activation) || (a.hops - b.hops) || String(a.id).localeCompare(String(b.id)));

  const out = {
    query: args.query,
    seeds,
    seedDetails: seedRows.map((r) => ({
      id: r.signature,
      similarity: Number((1 - r.distance).toFixed(4)),
      strength: Number(r.strength.toFixed(4)),
      class: r.class,
      activation: Number((r.seed_activation != null ? r.seed_activation : activationScore(1 - r.distance, r.strength, { dateIntent, histIntent })).toFixed(4)),
    })),
    cluster: {
      nodeCount: clusterRows.length + detailRows.length + archiveRows.length + archiveVecRows.length + archiveTimeRows.length + activeTimeRows.length + anchorDayRows.length,
      edgeCount: clusterEdges.length,
      nodes: activeNodes.concat(detailRows.map((r) => {
        // R2 detail constituent reached via the durable gist->detail pointer only after
        // demotion to the archive. It is a first-class drill-down answer, NOT a generic
        // keyword hit, so tag it as such and expose parent gist + provenance.
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        const archived = r.notes === "archive";
        return {
          id: r.signature, hops: 1, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null,
          tier: archived ? "archive_detail" : "detail", archived, via: "detail_of", parent: r.parent,
        };
      })).concat(archiveRows.map((r) => {
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        return {
          id: r.signature, hops: 99, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null, tier: "archive",
        };
      })).concat(archiveVecRows.map((r) => {
        // Archived fact reached by SIMILARITY via vec_archive (vector moved here at demotion).
        // Cold-band tier='archive' so the ranker caps it below the active cluster; it widens
        // the reachable pool (cross-ref/synthesis graph-gap) without displacing seeds.
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        return {
          id: r.signature, hops: 99, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null, tier: "archive", via: "archive_vec",
          avsim: Number((r.sim || 0).toFixed(4)),
        };
      })).concat(archiveTimeRows.map((r) => {
        // Archived fact reached by TIME window (query named a date) — cold-band tier='archive'.
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        return {
          id: r.signature, hops: 99, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null, tier: "archive", via: "archive_time",
        };
      })).concat(activeTimeRows.map((r) => {
        // Active dated record surfaced by the date-window sidecar (query named a date). Scored by
        // real cosine + a bounded date bonus so the on-date answer outranks the abstract paraphrase
        // gist; tagged via='active_time'. detail/gist tier per its notes.
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        const cos = typeof r.cos === "number" ? r.cos : 0;
        return {
          id: r.signature, hops: 1, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null,
          tier: (r.notes && /\bgist\b/.test(r.notes)) ? "gist" : "detail",
          via: "active_time",
          semantic_similarity: Number(cos.toFixed(4)),
          activation: Number((cos + ACTIVE_DATE_BOOST).toFixed(4)),
        };
      })).concat(anchorDayRows.map((r) => {
        // Same-day episode sibling reached by DATELESS anchor-day recall (tier 2f): the query sought
        // specifics but named no date, so we reconstructed the day of the strongest on-topic hit and
        // pulled its topic-relevant co-occurring records. Tagged via='anchor_day' so the consumer sees
        // an episode cluster (shared Source date) and can enumerate specifics / reason about absence.
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        const cos = typeof r.cos === "number" ? r.cos : 0;
        return {
          id: r.signature, hops: 1, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null,
          tier: (r.notes && /\bgist\b/.test(r.notes)) ? "gist" : "detail",
          via: "anchor_day",
          semantic_similarity: Number(cos.toFixed(4)),
          activation: Number((cos + 0.1).toFixed(4)),
        };
      })),
      edges: clusterEdges,
    },
  };

  // Active date/episode sidecars participate in the SAME relevance ordering as
  // ordinary active graph nodes. Appending them after archive rows defeats their
  // bounded date bonus and can make the exact on-date record invisible to consumers
  // that preserve engine order.
  const rankedActive = out.cluster.nodes
    .filter((n) => Number.isFinite(n.activation))
    .sort((a, b) => (b.activation - a.activation) || (a.hops - b.hops) || String(a.id).localeCompare(String(b.id)));
  const unranked = out.cluster.nodes.filter((n) => !Number.isFinite(n.activation));
  out.cluster.nodes = [...rankedActive, ...unranked];

  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error("SEARCH ERROR:", e); process.exit(1); });
}

module.exports = { parseDateRange, selectLexicalSeeds, significantTerms, activationScore, rankSeedCandidates };
