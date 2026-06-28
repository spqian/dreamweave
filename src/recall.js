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

  const qvec = toVecBlob(await embedOne(args.query));

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

  // 3) Edges fully inside the cluster.
  const allEdges = db.prepare(`SELECT src, rel, dst, weight FROM edges`).all();
  const clusterEdges = allEdges
    .filter((e) => clusterSet.has(e.src) && clusterSet.has(e.dst))
    .sort((a, b) => b.weight - a.weight || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));

  // ---- SUPERSEDE-CHAIN NARRATIVE SYNTHESIS (opt-in: DREAM_CHAIN_SYNTH=1) ------
  // Recall-side, representation-level. When a RETRIEVED fact participates in a
  // supersede chain (A<-B<-C corrections), gather the WHOLE chain (members that were
  // not themselves retrieved are looked up here) and emit it as a single, current-first
  // timeline. This addresses two measured failure classes that ranking alone cannot:
  //   - recall-miss: the dated transition is now ONE retrievable unit, not scattered atoms;
  //   - agent answer-selection: the resolved current value + its superseded history are
  //     stated together, so the synthesizer stops picking a stale distractor.
  // It is NEVER stored or re-embedded (no vector pollution — the rubber-duck's key risk),
  // the per-atom demotion logic above is untouched, and dates are RECORD dates (first_seen),
  // framed as "noted" rather than effective ("until"). Default OFF preserves exact legacy
  // output for a clean A/B.
  let chainMembers = [];
  if (process.env.DREAM_CHAIN_SYNTH === "1" && supersededBy.size) {
    const prevOf = new Map(); // survivor -> [stale, ...] (one hop down the chain)
    for (const [stale, s] of supersededBy.entries()) {
      if (!prevOf.has(s.survivor)) prevOf.set(s.survivor, []);
      prevOf.get(s.survivor).push(stale);
    }
    const headOf = (sig) => { // climb survivors to the current (un-superseded) head
      let cur = sig, guard = 0;
      while (supersededBy.has(cur) && guard++ < 16) cur = supersededBy.get(cur).survivor;
      return cur;
    };
    const retrieved = new Set([...clusterSet, ...detailSet, ...archiveSet, ...archiveVecSet]);
    const heads = new Set();
    for (const sig of retrieved) if (supersededBy.has(sig) || prevOf.has(sig)) heads.add(headOf(sig));
    const MAX_NARR = 3, MAX_MEMBERS = Math.max(2, Number(process.env.DREAM_CHAIN_DEPTH ?? 3));
    const textOf = db.prepare("SELECT fact, first_seen FROM nodes WHERE signature=? AND kind='fact'");
    for (const head of [...heads].slice(0, MAX_NARR)) {
      const members = [], seen = new Set(), stack = [head];
      while (stack.length && members.length < MAX_MEMBERS + 4) {
        const sig = stack.pop();
        if (seen.has(sig)) continue; seen.add(sig);
        const row = textOf.get(sig);
        if (row && row.fact) members.push({ sig, fact: row.fact.trim(), t: Date.parse(row.first_seen || "") || 0, first_seen: row.first_seen });
        for (const p of (prevOf.get(sig) || [])) stack.push(p);
      }
      if (members.length < 2) continue; // a single node is not a transition
      members.sort((a, b) => b.t - a.t); // newest first
      chainMembers.push({ head, members: members.slice(0, MAX_MEMBERS) });
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
      nodes: clusterRows.map((r) => {
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        return {
          id: r.signature, hops: r.hops, strength: Number(r.strength.toFixed(4)), class: r.class,
          kind: r.kind, fact: (r.fact || "").trim(),
          // Temporal signal for the synthesizer: a coarse RELATIVE age (brain-like,
          // fuzzy) plus the encode date and a sortable age-in-days. A merge survivor
          // (notes='gist') is a timeless schema fact; the rest are dated episodes.
          first_seen: r.first_seen || null,
          age_days: d,
          age: ageTag(d),
          // Sequencing signal: this node is the superseded ("from") side of a correction,
          // so a more recent fact overrides it. Consumers should rank it BELOW its survivor.
          superseded: !!sup,
          superseded_by: sup ? sup.survivor : null,
          tier: (r.notes && /\bgist\b/.test(r.notes)) ? "gist" : (r.notes && /\bdetail\b/.test(r.notes)) ? "detail" : "episodic",
        };
      }).concat(detailRows.map((r) => {
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
      })),
      edges: clusterEdges,
    },
  };

  // Prepend the synthesized supersede-chain timeline(s) as the highest-priority fact
  // node(s) so the synthesizer reads the resolved value + dated history first.
  if (chainMembers.length) {
    const narrNodes = chainMembers.map((cn) => {
      const m = cn.members, cur = m[0];
      const dateStr = (s) => (s && s.first_seen) ? ` (${s.first_seen.slice(0, 10)})` : "";
      const curD = ageDays(cur.first_seen, nowRef);
      const parts = [`As of ${ageTag(curD)}${dateStr(cur)}, the current record is: ${cur.fact}`];
      for (let i = 1; i < m.length; i++) {
        const lbl = i === 1 ? "This superseded an earlier record" : "Earlier still";
        parts.push(`${lbl}${dateStr(m[i])}: ${m[i].fact}`);
      }
      return {
        id: `narrative:${cn.head}`, hops: 0, strength: 1, class: "salient", kind: "fact",
        fact: parts.join(" "), first_seen: cur.first_seen || null,
        age_days: curD, age: ageTag(curD),
        superseded: false, superseded_by: null, tier: "narrative",
      };
    });
    out.cluster.nodes = narrNodes.concat(out.cluster.nodes);
    out.cluster.nodeCount += narrNodes.length;
  }

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error("SEARCH ERROR:", e); process.exit(1); });
