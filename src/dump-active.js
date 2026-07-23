"use strict";
// dump-active.js: emit dreamweave facts as JSON. Two modes:
//   default            : ACTIVE facts (Tier 1 gist + Tier 2 detail/episodic; excludes archive)
//   --include-archive  : ALL facts incl. Tier 3 archive (so memory_get can resolve any path
//                        dream recall returns).
//
//   AGENT_MEMORY_DIR=<dir> node src/dump-active.js [--include-archive]
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const cfg = require("../config");
const { renderNodeEnvelope } = require("./memory-render");

const includeArchive = process.argv.includes("--include-archive");
const where = includeArchive
  ? "kind IN ('fact','chronicle') AND fact IS NOT NULL AND TRIM(fact)<>''"
  : "kind IN ('fact','chronicle') AND (notes IS NULL OR notes<>'archive') AND fact IS NOT NULL AND TRIM(fact)<>''";

const db = new Database(cfg.DB_PATH, { readonly: true });
try { sqliteVec.load(db); } catch { /* vec not needed for this read */ }
const rows = db
  .prepare(
    "SELECT signature, fact, kind, class, salience, notes, source_day, first_seen, vagueness, temporal_form, memory_family FROM nodes WHERE " +
      where + " ORDER BY first_seen ASC"
  )
  .all()
  .map((row) => ({ ...row, raw_fact: row.fact, fact: renderNodeEnvelope(db, row) }));
process.stdout.write(JSON.stringify(rows));
db.close();
