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

  // 2b) TIER 3 (bookshelf): keyword scan over the un-embedded archive. These cold facts
  // have no vector and no edges, so vector+graph recall can't reach them — but the detail
  // may be exactly what a specific question needs. Brute-force LIKE over significant query
  // terms (the "I know I read this somewhere, let me dig" tier). Cheap relative to the
  // bench's LLM calls; only scans rows the graph layer already excluded.
  const STOP = new Set("the a an is are was were of for to in on and or that with as at by from this its not be no into what which who whom whose when where why how did do does has have had will would should could about over under more most than then them they their our your you i me my we us".split(" "));
  const terms = [...new Set((args.query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((t) => !STOP.has(t)))].slice(0, 8);
  let archiveRows = [];
  if (terms.length) {
    const like = terms.map(() => "lower(fact) LIKE ?").join(" OR ");
    const params = terms.map((t) => `%${t}%`);
    // Bounded scan: cap rows materialized (recent-first) so a huge archive can't blow up
    // memory; we then re-rank the capped set by term-hit count + recency.
    const rows = db.prepare(
      `SELECT signature, fact, first_seen, strength, class FROM nodes WHERE kind='fact' AND notes='archive' AND (${like}) ORDER BY first_seen DESC LIMIT 200`
    ).all(...params);
    // rank by how many distinct query terms a row contains, then recency
    archiveRows = rows.map((r) => {
      const f = (r.fact || "").toLowerCase();
      const hits = terms.reduce((a, t) => a + (f.includes(t) ? 1 : 0), 0);
      return { ...r, hits };
    }).filter((r) => r.hits > 0 && !clusterSet.has(r.signature))
      .sort((a, b) => b.hits - a.hits || (Date.parse(b.first_seen || "") || 0) - (Date.parse(a.first_seen || "") || 0))
      .slice(0, Math.max(4, Math.floor(args.k / 2)));
  }

  // 3) Edges fully inside the cluster.
  const allEdges = db.prepare(`SELECT src, rel, dst, weight FROM edges`).all();
  const clusterEdges = allEdges
    .filter((e) => clusterSet.has(e.src) && clusterSet.has(e.dst))
    .sort((a, b) => b.weight - a.weight || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));

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
      nodeCount: clusterRows.length + archiveRows.length,
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
      }).concat(archiveRows.map((r) => {
        const d = ageDays(r.first_seen, nowRef);
        const sup = supersededBy.get(r.signature);
        return {
          id: r.signature, hops: 99, strength: Number((r.strength || 0).toFixed(4)), class: r.class,
          kind: "fact", fact: (r.fact || "").trim(),
          first_seen: r.first_seen || null, age_days: d, age: ageTag(d),
          superseded: !!sup, superseded_by: sup ? sup.survivor : null, tier: "archive",
        };
      })),
      edges: clusterEdges,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error("SEARCH ERROR:", e); process.exit(1); });
