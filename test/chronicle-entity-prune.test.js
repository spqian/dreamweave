"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chronicle-entity-prune-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");

let db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,notes) VALUES ('person:historical','','entity','semantic','caller-approved')").run();
db.prepare(`
  INSERT INTO nodes(signature,memory_id,kind,class,first_seen,notes,fact,text)
  VALUES ('chronicle:day:2026-01-07:v1','','chronicle','semantic','2026-01-07','archive','Historical day','Historical day')
`).run();
db.prepare(`
  INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,created_at)
  VALUES ('chronicle:day:2026-01-07:v1','day','2026-01-07','2026-01-07',1,'2026-01-07')
`).run();
db.prepare(`
  INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind)
  VALUES ('chronicle:day:2026-01-07:v1',0,'2026-01-07','Historical entity context','continuity')
`).run();
db.prepare(`
  INSERT INTO chronicle_entry_entities(chronicle_sig,entry_ordinal,entity_sig)
  VALUES ('chronicle:day:2026-01-07:v1',0,'person:historical')
`).run();
db.close();

execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "dream",
  "--as-of", "2026-02-01",
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });

db = new Database(path.join(dataDir, "memory.db"));
if (!db.prepare("SELECT 1 FROM nodes WHERE signature='person:historical' AND kind='entity'").get()) {
  throw new Error("hub pruning deleted an entity retained by archived chronicle facets");
}
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log("PASS: chronicle facets protect historical entity hubs from pruning");
