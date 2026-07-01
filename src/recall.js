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
  // 3) month name (+ optional qualifier / day / year)
  const monthRe = new RegExp(`(late|early|mid|middle|end of|beginning of)?\\s*(${Object.keys(MONTHS).join("|")})\\b(?:\\s+(\\d{1,2})(?!\\d))?(?:\\s*[-–to]{1,3}\\s*(\\d{1,2})(?!\\d))?(?:,?\\s*(\\d{4}))?`, "i");
  m = q.match(monthRe);
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

async function main() {
  const args = parseArgs(process.argv);
  if (!args.query.trim()) {
    console.error('Usage: node lib/recall.js --query "<text>" [--max-hops 2]');
    process.exit(2);
  }

  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);

  // Supersede awareness. A correction is stored as an edge (newer)--supersedes-->(older),
  // so the edge's `dst` is the STALE "from" value. The dream design deliberately PRESERVES
  // that stale node (so the transition stays answerable for contradiction-resolution), which
  // means recall must DEMOTE — never drop — it. supersededBy maps stale -> surviving signature.
  const supersededBy = new Map();
  for (const e of db.prepare("SELECT src, dst, first_seen FROM edges WHERE rel='supersedes'").all()) {
    const prev = supersededBy.get(e.dst);
    // If a node was corrected more than once, keep the NEWEST surviving correction.
    if (!prev || (Date.parse(e.first_seen || "") || 0) >= (prev.t || 0)) {
      supersededBy.set(e.dst, { survivor: e.src, t: Date.parse(e.first_seen || "") || 0 });
    }
  }

  const qFloat = await embedOne(args.query);
  const qvec = toVecBlob(qFloat);

  // 1) Vector KNN -> candidate seeds (cosine distance; lower = closer). Seeds are FACTS
  //    only: entity hubs are also embedded, but a hub seed consumes a limited seed slot
  //    and (being generic) starts the graph walk from a broad connector, diluting the
  //    cluster. Hubs still enter the cluster as walk frontier via fact co-mention edges.
  const knn = db.prepare(`
    SELECT n.signature AS signature, n.strength AS strength, n.class AS class, v.distance AS distance
    FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
    JOIN nodes n ON n.id = v.rowid
    WHERE n.kind = 'fact'
    ORDER BY v.distance
  `).all(qvec, args.k * 2);

  // Seed selection with supersede demotion: when BOTH a stale version and its surviving
  // correction are vector-retrieved, we are choosing between two versions of the SAME fact —
  // sink the stale one below its survivor so the current value seeds the cluster (and lands
  // at the top of what the agent reads). When the survivor was not retrieved, the stale node
  // keeps its vector position (it may be the only answer we have). Pure distance order is
  // otherwise preserved.
  const knnSigs = new Set(knn.map((r) => r.signature));
  const supersededWithSurvivor = (sig) => {
    const s = supersededBy.get(sig);
    return !!(s && knnSigs.has(s.survivor));
  };
  const rankedKnn = knn
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const da = supersededWithSurvivor(a.r.signature) ? 1 : 0;
      const dbb = supersededWithSurvivor(b.r.signature) ? 1 : 0;
      if (da !== dbb) return da - dbb;
      return a.i - b.i;
    })
    .map((x) => x.r);

  const seedRows = rankedKnn.slice(0, args.seedLimit);
  const seeds = seedRows.map((r) => r.signature);

  // Graph expansion runs only when we have vector seeds; but the Tier-3 keyword search
  // below MUST run regardless (an archive-only DB, or a query whose answer was demoted,
  // has zero embedded seeds yet may be answerable from the bookshelf). So we no longer
  // early-return on empty seeds — we fall through to the keyword tier.
  let clusterRows = [];
  if (seeds.length > 0) {
    const seedsJson = JSON.stringify(seeds);
    clusterRows = db.prepare(`
      WITH RECURSIVE
      bidir(a, b, rel, weight) AS (
        SELECT src, dst, rel, weight FROM edges
        UNION ALL
        SELECT dst, src, rel, weight FROM edges
      ),
      walk(sig, hops) AS (
        SELECT value, 0 FROM json_each(?)
        UNION
        SELECT b.b, walk.hops + 1
        FROM walk JOIN bidir b ON b.a = walk.sig
        WHERE walk.hops < ?
      )
      SELECT w.sig AS signature, MIN(w.hops) AS hops,
             COALESCE(n.strength, 0) AS strength, n.class AS class, n.fact AS fact, n.kind AS kind,
             n.first_seen AS first_seen, n.notes AS notes
      FROM walk w LEFT JOIN nodes n ON n.signature = w.sig
      GROUP BY w.sig
      ORDER BY hops ASC, strength DESC, signature ASC
      LIMIT ?
    `).all(seedsJson, args.maxHops, args.nodeLimit);
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
    const seqAdj = new Map();
    for (const e of db.prepare("SELECT src, dst FROM edges WHERE rel='sequence'").all()) {
      if (!seqAdj.has(e.src)) seqAdj.set(e.src, new Set());
      if (!seqAdj.has(e.dst)) seqAdj.set(e.dst, new Set());
      seqAdj.get(e.src).add(e.dst);
      seqAdj.get(e.dst).add(e.src);
    }
    if (seqAdj.size) {
      const PER_CHAIN_MAX = 40; // bound ONE episode (collapses to a few distinct in 1c)
      const TOUCHED_MAX = 400;  // global guard across all touched chains
      const inCluster = new Set(clusterRows.map((r) => r.signature));
      const seedsOnChain = clusterRows.map((r) => r.signature).filter((s) => seqAdj.has(s));
      const chainSigs = new Set();
      let nextChain = 0;
      for (const seed of seedsOnChain) {
        if (chainIdBySig.has(seed)) continue; // component already expanded via another seed
        if (chainSigs.size >= TOUCHED_MAX) break;
        const id = nextChain++;
        const lseen = new Set();
        const stack = [seed];
        let count = 0;
        while (stack.length && count < PER_CHAIN_MAX) {
          const cur = stack.pop();
          if (lseen.has(cur)) continue;
          lseen.add(cur);
          chainIdBySig.set(cur, id);
          count += 1;
          if (!inCluster.has(cur)) chainSigs.add(cur);
          for (const nb of (seqAdj.get(cur) || [])) if (!lseen.has(nb)) stack.push(nb);
        }
      }
      if (chainSigs.size) {
        const ph = [...chainSigs].map(() => "?").join(",");
        const rows = db.prepare(
          `SELECT signature, COALESCE(strength,0) AS strength, class, fact, kind, first_seen, notes
           FROM nodes WHERE kind='fact' AND signature IN (${ph})`
        ).all(...chainSigs);
        for (const r of rows) if (sharesQueryTopic(r.fact)) clusterRows.push({ ...r, hops: 1, via: "sequence" });
      }
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
  const ARCHIVE_VEC_ON = process.env.DREAM_ARCHIVE_VEC !== "0";
  const ARCHIVE_VEC_SIM = Number(process.env.DREAM_ARCHIVE_VEC_SIM ?? 0.5);
  const ARCHIVE_VEC_BUDGET = Number(process.env.DREAM_ARCHIVE_VEC_BUDGET ?? Math.max(4, Math.floor(args.k / 2)));
  let archiveVecRows = [];
  if (ARCHIVE_VEC_ON) {
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
  const ARCHIVE_TIME_ON = process.env.DREAM_ARCHIVE_TIME !== "0";
  const ARCHIVE_TIME_BUDGET = Number(process.env.DREAM_ARCHIVE_TIME_BUDGET ?? Math.max(4, Math.floor(args.k / 2)));
  let archiveTimeRows = [];
  if (ARCHIVE_TIME_ON) {
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

  // 3) Edges fully inside the cluster.
  const allEdges = db.prepare(`SELECT src, rel, dst, weight FROM edges`).all();
  const clusterEdges = allEdges
    .filter((e) => clusterSet.has(e.src) && clusterSet.has(e.dst))
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

  db.close();

  // "Now" for relative-age tags: explicit --as-of, else the latest memory in the
  // cluster (the bench simulates time, so we anchor to the most recent fact seen).
  const latest = clusterRows.reduce((m, r) => {
    const t = Date.parse(r.first_seen || "");
    return t && t > m ? t : m;
  }, 0);
  const nowRef = args.asOf ? new Date(args.asOf) : (latest ? new Date(latest) : new Date());

  // ---- Activation ranking (P11) ------------------------------------------------------------
  // ACTIVATION = cosine + lambda*strength: rerank ACTIVE nodes so a reinforced consolidated fact
  // (high ACT-R base-level activation = recency x frequency x schema, held in `strength`) can
  // outrank a stale low-strength restatement that merely shares surface tokens. Cosine-dominant
  // and SEMANTICALLY GATED — the strength bonus applies only once a node clears a cosine floor,
  // so an off-topic strong fact is never promoted. This is seed/relevance SELECTION incl. strength,
  // NOT a global time-reorder of rendered context (ARCHITECTURE principle 6 caution).
  const ACT_LAMBDA = Number(process.env.DREAM_ACT_LAMBDA ?? 0.2);
  const ACT_COS_FLOOR = Number(process.env.DREAM_ACT_COS_FLOOR ?? 0.30);
  const ACT_SUPERSEDE_PENALTY = Number(process.env.DREAM_ACT_SUPERSEDE_PENALTY ?? 0.15);
  const dateIntent = parseDateRange(args.query, nowRef) != null;
  const histIntent = /\b(origin(?:al|ally)?|before it|previous(?:ly)?|used to|initially|initial|at the time|back then)\b/i.test(args.query || "");
  const activationOf = (c, s, superseded) => {
    const gate = c >= ACT_COS_FLOOR ? 1 : 0;
    let lam = ACT_LAMBDA;
    if (dateIntent && !histIntent) lam *= 0.5; // explicit-date lookup: favor cosine/date, damp strength
    let a = c + lam * (s || 0) * gate;
    if (superseded && !histIntent) a -= ACT_SUPERSEDE_PENALTY; // demote stale unless asked historically
    return a;
  };
  const activeNodes = clusterRows.map((r) => {
    const d = ageDays(r.first_seen, nowRef);
    const sup = supersededBy.get(r.signature);
    const cos = cosBySig.has(r.signature) ? cosBySig.get(r.signature) : 0;
    const activation = activationOf(cos, r.strength, !!sup);
    return {
      id: r.signature, hops: r.hops, strength: Number(r.strength.toFixed(4)), class: r.class,
      kind: r.kind, fact: (r.fact || "").trim(),
      first_seen: r.first_seen || null,
      age_days: d,
      age: ageTag(d),
      superseded: !!sup,
      superseded_by: sup ? sup.survivor : null,
      tier: (r.notes && /\bgist\b/.test(r.notes)) ? "gist" : (r.notes && /\bdetail\b/.test(r.notes)) ? "detail" : "episodic",
      via: r.via || undefined,
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
    })),
    cluster: {
      nodeCount: clusterRows.length + detailRows.length + archiveRows.length + archiveVecRows.length,
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
      })),
      edges: clusterEdges,
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((e) => { console.error("SEARCH ERROR:", e); process.exit(1); });
}

module.exports = { parseDateRange };
