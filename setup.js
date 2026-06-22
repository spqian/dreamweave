"use strict";

// One-command bootstrap for the agent-memory engine.
//   node setup.js
//
// - verifies the native + ESM dependencies are installed (run `npm install` first)
// - creates the per-user data dir and initializes a fresh memory.db (full schema)
// - warms the local embedding model (first run downloads ~90MB once, then cached)
// - prints the data locations and next steps
//
// Everything is path-portable via config.js (override with AGENT_MEMORY_DIR etc.).

const fs = require("fs");
const path = require("path");
const cfg = require("./config");

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

  // 4) Install the two skills into the Scout skills dir, wiring the absolute engine path.
  const skillResult = installSkills();
  if (skillResult.installed) {
    ok(`skills installed into ${skillResult.dir}`);
    skillResult.names.forEach((n) => info("\u2022 " + n));
  } else {
    console.log("  \u2022 skills not auto-installed: " + skillResult.reason);
    info("manual: copy skills/dream and skills/graph-recall into your Scout skills dir,");
    info("then replace <AGENT_MEMORY> in their SKILL.md with: " + cfg.ROOT.replace(/\\/g, "/"));
  }

  console.log("\nReady. To use it, ask your agent to:");
  info("1. Run the nightly dream loop (see skills/dream/SKILL.md), or");
  info("2. node src/recall.js --query \"<question>\"   # vector + graph recall");
  if (skillResult.installed) info("(Restart Scout so it picks up the new skills.)");
  console.log("\nSee README.md for the full nightly loop and host-agent integration.");
}

// Copy the two skill folders into the Scout custom-skills dir and substitute the
// <AGENT_MEMORY> placeholder in their SKILL.md with this package's absolute path,
// so the skills can shell out to the engine with no manual wiring.
function installSkills() {
  const os = require("os");
  const home = os.homedir();
  // An explicitly-set SCOUT_SKILLS_DIR always wins (created if missing); never fall
  // through to an auto-detected dir when the caller pinned one.
  let target = process.env.SCOUT_SKILLS_DIR;
  if (!target) {
    const candidates = [path.join(home, ".copilot", "m-skills"), path.join(home, ".scout", "m-skills")];
    target = candidates.find((d) => fs.existsSync(d));
    if (!target) {
      const parent = [path.join(home, ".copilot"), path.join(home, ".scout")].find((d) => fs.existsSync(d));
      if (!parent) return { installed: false, reason: "no ~/.copilot or ~/.scout dir found (is Scout installed?)" };
      target = path.join(parent, "m-skills");
    }
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    const engine = cfg.ROOT.replace(/\\/g, "/"); // forward slashes work cross-platform in node CLI paths
    const names = [];
    for (const skill of ["dream", "graph-recall"]) {
      const srcDir = path.join(cfg.ROOT, "skills", skill);
      const dstDir = path.join(target, skill);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const f of fs.readdirSync(srcDir)) {
        let content = fs.readFileSync(path.join(srcDir, f), "utf8");
        if (f.toLowerCase().endsWith(".md")) content = content.split("<AGENT_MEMORY>").join(engine);
        fs.writeFileSync(path.join(dstDir, f), content, "utf8");
      }
      names.push(skill);
    }
    return { installed: true, dir: target, names };
  } catch (e) {
    return { installed: false, reason: e.message };
  }
}

main().catch((e) => { console.error("SETUP ERROR:", e); process.exit(1); });

