"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-doctor-derived-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { doctor } = require("../src/dream");
const { embedOne, toVecBlob } = require("../src/embed");

(async () => {
  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);

  const insertNode = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,notes,fact) VALUES (?,?,?,?,?,?)");
  const insertVec = db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)");
  for (const node of [
    ["fact:gist", "", "fact", "semantic", "gist", "summary"],
    ["fact:detail", "", "fact", "episodic", "detail", "verbatim evidence"],
  ]) {
    const info = insertNode.run(...node);
    insertVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(node[5])));
  }
  db.prepare("INSERT INTO detail_of(detail_sig,gist_sig,first_seen) VALUES ('fact:detail','fact:gist','2026-07-25')").run();

  let result = doctor(db);
  if (!result.healthy || result.fact_islands !== 0) {
    throw new Error(`detail_of lineage was incorrectly reported as an island: ${JSON.stringify(result)}`);
  }

  const orphan = insertNode.run("fact:orphan", "", "fact", "episodic", "harness-ingest", "unlinked");
  insertVec.run(BigInt(orphan.lastInsertRowid), toVecBlob(await embedOne("unlinked")));
  result = doctor(db);
  if (result.healthy || result.fact_islands !== 1 || result.islands[0] !== "fact:orphan") {
    throw new Error(`true orphan was not reported: ${JSON.stringify(result)}`);
  }

  console.log("PASS ✓ doctor accepts derived detail lineage and rejects true islands");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
