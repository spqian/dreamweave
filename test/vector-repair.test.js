"use strict";

// Graph repair must also restore vector/node identity invariants.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-vector-repair-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { repairGraph } = require("../src/dream");
const { toVecBlob, DIMS } = require("../src/embed");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);
const info = db.prepare("INSERT INTO nodes(signature,kind,class,notes) VALUES ('fact:active','fact','episodic',NULL)").run();
const blob = toVecBlob(new Float32Array(DIMS));
db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(info.lastInsertRowid), blob);
db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (999,?)").run(blob);
db.prepare("INSERT INTO vec_archive(rowid,embedding) VALUES (?,?)").run(BigInt(info.lastInsertRowid), blob);
db.prepare("INSERT INTO vec_archive(rowid,embedding) VALUES (998,?)").run(blob);

repairGraph(db);

if (db.prepare("SELECT count(*) c FROM vec_nodes WHERE rowid=999").get().c !== 0) throw new Error("orphan active vector survived repair");
if (db.prepare("SELECT count(*) c FROM vec_archive WHERE rowid=998").get().c !== 0) throw new Error("orphan archive vector survived repair");
if (db.prepare("SELECT count(*) c FROM vec_archive WHERE rowid=?").get(BigInt(info.lastInsertRowid)).c !== 0) {
  throw new Error("active node remained duplicated in vec_archive");
}
if (db.prepare("SELECT count(*) c FROM vec_nodes WHERE rowid=?").get(BigInt(info.lastInsertRowid)).c !== 1) {
  throw new Error("repair removed the active node vector");
}

console.log("PASS \u2713 graph repair restores vector identity");
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
