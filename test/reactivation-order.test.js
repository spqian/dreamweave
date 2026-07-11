"use strict";

// The public `dream` command must associate newly ingested facts before subject
// reactivation. Otherwise the new fact has no mentions edge, the old sibling is
// never re-cued, and advancing last_dream permanently loses the opportunity.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-reactivation-order-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

run("init");

const Database = require("better-sqlite3");
let db = new Database(path.join(dataDir, "memory.db"));
db.prepare(`INSERT INTO nodes(signature,memory_id,kind,class,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq)
  VALUES ('fact:alice-old','old','fact','episodic',0.3,0,'2026-06-01','2026-06-01','2026-06-01','harness-ingest','Alice Example owns the migration checklist.','',0,0)`).run();
db.prepare(`INSERT INTO nodes(signature,memory_id,kind,class,strength,reactivations,first_seen,last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq)
  VALUES ('person:alice-example','','entity','semantic',0.5,0,'2026-06-01','2026-06-01','2026-06-01','weave-extract','','alice example|alice',0,0)`).run();
db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES ('fact:alice-old','mentions','person:alice-example',0.8,'2026-06-01','2026-06-01')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_weave_seq','0')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_dream','2026-07-01T00:00:00.000Z')").run();
db.close();

const snapshot = path.join(dataDir, "snapshot.json");
fs.writeFileSync(snapshot, JSON.stringify([{
  id: "new",
  fact: "Alice Example approved the migration rollout.",
  category: "decision",
  createdAt: "2025-01-15T00:00:00.000Z",
}]));
run("ingest-harness", "--file", snapshot, "--as-of", "2026-07-10T00:00:00.000Z");
const result = run("dream", "--as-of", "2026-07-10T00:00:00.000Z");

db = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const old = db.prepare("SELECT reactivations, strength FROM nodes WHERE signature='fact:alice-old'").get();
const linked = db.prepare("SELECT count(*) c FROM edges WHERE src LIKE 'fact:alice-example-approved%' AND rel='mentions' AND dst='person:alice-example'").get().c;
db.close();

if (!result.preweave || result.preweave.weaved !== 1) fail("dream did not pre-weave the new fact");
if (linked !== 1) fail("new fact was not associated before reactivation");
if (!old || old.reactivations !== 1 || result.reactivated !== 1) fail("existing subject fact was not reactivated exactly once");

console.log("PASS \u2713 dream associates new facts before subject reactivation");
fs.rmSync(dataDir, { recursive: true, force: true });
