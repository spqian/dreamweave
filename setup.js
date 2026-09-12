"use strict";

// Host-neutral bootstrap for the agent-memory engine (no host skill installation).
//   node setup.js
//
// - verifies the native + ESM dependencies are installed (run `npm install` first)
// - creates the per-user data dir and initializes a fresh memory.db (full schema)
// - warms the local embedding model (first run downloads ~90MB once, then cached)
// - prints the data locations and next steps
//
// Everything is path-portable via config.js (override with AGENT_MEMORY_DIR etc.).

const fs = require("fs");
const cfg = require("./config");
const tuning = require("./src/tuning");

function ok(m) { console.log("  \u2713 " + m); }
function info(m) { console.log("    " + m); }

async function main() {
  console.log("agent-memory setup\n");

  // 1) Dependencies present?
  const missing = [];
  for (const dep of ["better-sqlite3", "sqlite-vec", "@huggingface/transformers"]) {
    try { require.resolve(dep); }
    catch { missing.push(dep); }
  }
  if (missing.length) {
    console.error("  \u2717 Missing dependencies: " + missing.join(", "));
    console.error("    Run `npm install` in this folder first, then re-run `npm run setup`.");
    process.exit(1);
  }
  ok("dependencies present (better-sqlite3, sqlite-vec, @huggingface/transformers)");

  // 2) Data dir + fresh database (schema via dream.js openDb).
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  ok("data dir: " + cfg.DATA_DIR);

  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("./src/schema");
  const db = new Database(cfg.DB_PATH);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  ensureSchema(db);
  const counts = {
    nodes: db.prepare("SELECT count(*) c FROM nodes").get().c,
    edges: db.prepare("SELECT count(*) c FROM edges").get().c,
  };
  db.close();
  ok(`database ready: ${cfg.DB_PATH} (nodes=${counts.nodes}, edges=${counts.edges})`);

  // 3) Warm the embedding model (downloads once into the cache dir).
  process.stdout.write("    warming embedding model (" + cfg.MODEL + ") \u2026 first run downloads once\n");
  try {
    const { embedOne } = require("./src/embed");
    const v = await embedOne("agent memory bootstrap");
    ok(`embedding model ready (${v.length}-dim, cache: ${cfg.MODEL_CACHE})`);
  } catch (e) {
    console.error("  \u2717 model warm-up failed: " + e.message);
    console.error("    (needs network on first run; re-run setup once online)");
    process.exit(1);
  }

  // 4) Ensure a behavioral config exists (defaults deliver the target three-tier UX).
  const { created } = tuning.ensureConfig();
  ok(`behavior config ${created ? "created (defaults)" : "present"}: ${tuning.CONFIG_PATH}`);
  console.log("    active behavior:\n      " + tuning.describe().replace(/\n  /g, "\n      "));
  console.log(`    (these are the ${Object.keys(tuning.KNOBS).length} knobs — an AI importing this package should INTERVIEW`);
  console.log("     the user and persist choices via: node src/dream.js config set <knob> <value>)");

  console.log("\nReady. To use it, ask your agent to:");
  info("1. Read INSTALL.md and select the adapter for your host agent.");
  info("2. node src/recall.js --query \"<question>\"   # vector + graph recall");

  console.log("\nSee README.md for the full nightly loop and host-agent integration.");
}

main().catch((e) => { console.error("SETUP ERROR:", e); process.exit(1); });

