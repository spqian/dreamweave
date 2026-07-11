"use strict";

// A bare short name shared by multiple people must not create two mention edges.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-entity-ambiguity-"));
const dream = path.join(__dirname, "..", "src", "dream.js");
const env = { ...process.env, AGENT_MEMORY_DIR: dataDir };
const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));

run("init");
const Database = require("better-sqlite3");
const db = new Database(path.join(dataDir, "memory.db"));
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,ingested_seq,dirty_seq) VALUES ('person:alice-smith','','entity','semantic',0.5,'2026-01-01','weave-extract','','alice smith|alice|smith',0,0)").run();
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,ingested_seq,dirty_seq) VALUES ('person:alice-jones','','entity','semantic',0.5,'2026-01-01','weave-extract','','alice jones|alice|jones',0,0)").run();
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,ingested_seq,dirty_seq) VALUES ('fact:bare-alice','m1','fact','episodic',0.3,'2026-01-02','harness-ingest','Alice approved the rollout.','',1,1)").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('last_weave_seq','0')").run();
db.close();

run("weave", "--as-of", "2026-01-02");
const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const ambiguous = db2.prepare("SELECT count(*) c FROM edges WHERE src='fact:bare-alice' AND rel='mentions' AND dst IN ('person:alice-smith','person:alice-jones')").get().c;
db2.close();
if (ambiguous !== 0) throw new Error(`bare Alice linked to ${ambiguous} ambiguous person hubs`);

console.log("PASS \u2713 ambiguous short person names do not create false graph bridges");
fs.rmSync(dataDir, { recursive: true, force: true });
