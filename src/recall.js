"use strict";

// recall.js: semantic vector recall + graph expansion over memory.db.
// Real embeddings (sqlite-vec KNN) seed the search, then a recursive-CTE graph
// walk expands the cluster, ranked by the dream strength model.
//
//   node lib/recall.js --query "<text>" [--max-hops 2] [--seed-limit 4] [--k 12]

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { embedOne, toVecBlob } = require("./embed");
const cfg = require("../config");

const DB_PATH = cfg.DB_PATH;

function parseArgs(argv) {
  const args = { query: "", maxHops: 2, seedLimit: 4, k: 12, nodeLimit: 80 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--query") args.query = argv[++i] || "";
    else if (a === "--max-hops") args.maxHops = Number(argv[++i]);
    else if (a === "--seed-limit") args.seedLimit = Number(argv[++i]);
    else if (a === "--k") args.k = Number(argv[++i]);
    else if (a === "--node-limit") args.nodeLimit = Number(argv[++i]);
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

  const qvec = toVecBlob(await embedOne(args.query));

  // 1) Vector KNN -> candidate seeds (cosine distance; lower = closer).
  const knn = db.prepare(`
    SELECT n.signature AS signature, n.strength AS strength, n.class AS class, v.distance AS distance
    FROM (SELECT rowid, distance FROM vec_nodes WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
    JOIN nodes n ON n.id = v.rowid
    ORDER BY v.distance
  `).all(qvec, args.k);

  const seedRows = knn.slice(0, args.seedLimit);
  const seeds = seedRows.map((r) => r.signature);

  if (seeds.length === 0) {
    console.log(JSON.stringify({ query: args.query, seeds: [], cluster: { nodes: [], edges: [] }, summary: "No matching memory nodes found." }, null, 2));
    db.close();
    return;
  }

  // 2) Graph expansion: bidirectional recursive walk from seeds up to maxHops.
  const seedsJson = JSON.stringify(seeds);
  const clusterRows = db.prepare(`
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
           COALESCE(n.strength, 0) AS strength, n.class AS class, n.fact AS fact, n.kind AS kind
    FROM walk w LEFT JOIN nodes n ON n.signature = w.sig
    GROUP BY w.sig
    ORDER BY hops ASC, strength DESC, signature ASC
    LIMIT ?
  `).all(seedsJson, args.maxHops, args.nodeLimit);

  const clusterSet = new Set(clusterRows.map((r) => r.signature));

  // 3) Edges fully inside the cluster.
  const allEdges = db.prepare(`SELECT src, rel, dst, weight FROM edges`).all();
  const clusterEdges = allEdges
    .filter((e) => clusterSet.has(e.src) && clusterSet.has(e.dst))
    .sort((a, b) => b.weight - a.weight || a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));

  db.close();

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
      nodeCount: clusterRows.length,
      edgeCount: clusterEdges.length,
      nodes: clusterRows.map((r) => ({
        id: r.signature, hops: r.hops, strength: Number(r.strength.toFixed(4)), class: r.class,
        kind: r.kind, fact: (r.fact || "").trim(),
      })),
      edges: clusterEdges,
    },
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error("SEARCH ERROR:", e); process.exit(1); });
