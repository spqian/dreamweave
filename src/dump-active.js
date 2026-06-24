"use strict";
// dump-active.js: emit the dream engine's ACTIVE facts (Tier 1 gist + Tier 2
// detail/episodic; excludes Tier 3 archive) as JSON. Used by the "dream on top
// of OpenClaw" bench arm to hand OpenClaw's memory-core a dream-consolidated
// corpus to index — the same retrieval engine, a curated/deduped corpus.
//
//   AGENT_MEMORY_DIR=<dir> node src/dump-active.js
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const cfg = require("../config");

const db = new Database(cfg.DB_PATH, { readonly: true });
try { sqliteVec.load(db); } catch { /* vec not needed for this read */ }
const rows = db
  .prepare(
    "SELECT signature, fact, class, salience, notes, first_seen FROM nodes " +
      "WHERE kind='fact' AND (notes IS NULL OR notes<>'archive') AND fact IS NOT NULL AND TRIM(fact)<>'' " +
      "ORDER BY first_seen ASC"
  )
  .all();
process.stdout.write(JSON.stringify(rows));
db.close();
