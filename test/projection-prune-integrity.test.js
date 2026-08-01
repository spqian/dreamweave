"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = path.join(__dirname, ".projection-prune-integrity");
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { embedOne, toVecBlob } = require("../src/embed");
const { doctor } = require("../src/dream");

(async () => {
  let db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);

  const insertNode = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,first_seen,source_day,notes,fact,text)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const insertVec = db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)");
  for (const node of [
    ["fact:projected-gist", "stale-harness-id", "fact", "semantic", "2026-07-25", null, "gist", "Derived summary", "Derived summary"],
    ["fact:retained-detail", "detail-id", "fact", "episodic", "2026-07-25", "2026-07-25", "detail", "Exact evidence", "Exact evidence"],
    ["fact:sequence-peer", "", "fact", "episodic", "2026-07-25", "2026-07-25", "harness-ingest", "Later evidence", "Later evidence"],
  ]) {
    const info = insertNode.run(...node);
    insertVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(node[7])));
  }
  insertNode.run("system:test", "", "entity", "semantic", "2026-07-25", null, "entity-hub", "Test", "Test");
  db.prepare("INSERT INTO detail_of(detail_sig,gist_sig,first_seen) VALUES ('fact:retained-detail','fact:projected-gist','2026-07-25')").run();
  db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:projected-gist','related_to','fact:retained-detail',0.8)").run();
  db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:sequence-peer','mentions','system:test',0.8)").run();
  db.prepare("INSERT INTO evidence_transitions(src_sig,rel,dst_sig,first_seen) VALUES ('fact:retained-detail','sequence','fact:sequence-peer','2026-07-25')").run();
  db.close();

  const harness = path.join(dataDir, "empty-harness.json");
  fs.writeFileSync(harness, "[]", "utf8");
  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "dream.js"),
    "ingest-harness", "--file", harness, "--prune", "true", "--as-of", "2026-07-27",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  if (result.demoted !== 1 || result.pruned !== 0) {
    throw new Error(`projection omission was not demoted safely: ${JSON.stringify(result)}`);
  }

  db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  const parent = db.prepare("SELECT memory_id,notes FROM nodes WHERE signature='fact:projected-gist'").get();
  const lineage = db.prepare("SELECT 1 FROM detail_of WHERE detail_sig='fact:retained-detail' AND gist_sig='fact:projected-gist'").get();
  const transition = db.prepare("SELECT 1 FROM evidence_transitions WHERE src_sig='fact:retained-detail' AND dst_sig='fact:sequence-peer'").get();
  const health = doctor(db);
  if (!parent || parent.memory_id !== "" || parent.notes !== "archive" || !lineage || !transition) {
    throw new Error("projection omission destroyed authoritative evidence or lineage");
  }
  if (!health.healthy || health.fact_islands !== 0 || health.invalid_evidence_transitions !== 0) {
    throw new Error(`demoted projection was unhealthy: ${JSON.stringify(health)}`);
  }
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("PASS: projection prune demotes without destroying lineage or transitions");
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
