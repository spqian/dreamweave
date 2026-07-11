"use strict";

// Empty report/apply decisions must not trigger expensive weave maintenance.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-apply-noop-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { applyEntities, applyAliases, applyMerges } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  const info = db.prepare("INSERT INTO nodes(signature,kind,class,first_seen,fact,dirty_seq) VALUES ('fact:no-vector','fact','episodic','2026-01-01','No-op apply should not weave this fact.',1)").run();
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();

  const entities = await applyEntities(db, [], { asOf: "2026-01-02T00:00:00.000Z" });
  const aliases = await applyAliases(db, [], { asOf: "2026-01-02T00:00:00.000Z" });
  const merges = await applyMerges(db, [], { asOf: "2026-01-02T00:00:00.000Z" });
  if (entities.weave !== null || aliases.weave !== null || merges.weave !== null) {
    throw new Error("empty apply unexpectedly ran weave");
  }
  if (db.prepare("SELECT count(*) c FROM vec_nodes WHERE rowid=?").get(BigInt(info.lastInsertRowid)).c !== 0) {
    throw new Error("no-op apply reembedded an untouched fact");
  }

  console.log("PASS \u2713 empty apply surfaces skip weave maintenance");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
