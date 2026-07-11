"use strict";

// Existing stores can contain duplicate edges from the era before edge identity
// was constrained. Schema migration must deduplicate once and then make
// INSERT OR IGNORE enforce the intended invariant.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-schema-integrity-"));
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);

db.exec("DROP INDEX idx_edges_unique");
const ins = db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:a','related_to','fact:b',?)");
ins.run(0.4);
ins.run(0.8);
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 2) throw new Error("duplicate fixture was not created");

ensureSchema(db);
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 1) throw new Error("migration did not deduplicate edges");

db.prepare("INSERT OR IGNORE INTO edges(src,rel,dst,weight) VALUES ('fact:a','related_to','fact:b',0.9)").run();
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 1) throw new Error("edge unique index does not enforce INSERT OR IGNORE");

console.log("PASS \u2713 schema deduplicates and constrains graph edge identity");
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
