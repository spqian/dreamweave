"use strict";

// A narrow correction must supersede the prior assertion, not a broad same-project gist.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-supersede-aspect-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);
const ins = db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,notes,fact,text,dirty_seq) VALUES (?,'fact','episodic',0.4,?,NULL,?,'',?)");
ins.run("fact:condor-broad", "2026-01-01", "Project Condor operating state covers valuation, diligence, financing, the board schedule, and integration planning.", 1);
ins.run("fact:condor-alert", "2026-01-02", "Project Condor SLA alert said the Germany region had 69.7 percent successful refreshes and might indicate a train regression.", 2);
ins.run("fact:condor-correction", "2026-01-03", "Project Condor SLA alert was corrected: the Germany region result was an incomplete hourly bucket, not a train regression.", 3);
db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,notes,fact,text) VALUES ('project:condor','entity','semantic',0.5,'2026-01-01','weave-extract','','project condor|condor')").run();
const mention = db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES (?,'mentions','project:condor',1)");
mention.run("fact:condor-broad");
mention.run("fact:condor-alert");
mention.run("fact:condor-correction");
db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:condor-correction','supersedes','fact:condor-broad',0.9)").run();
db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','3')").run();
db.close();

execFileSync(process.execPath, [
  path.join(__dirname, "..", "src", "dream.js"),
  "weave", "--as-of", "2026-01-03T12:00:00.000Z",
], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });

const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
const falseEdge = db2.prepare("SELECT count(*) c FROM edges WHERE src='fact:condor-correction' AND rel='supersedes' AND dst='fact:condor-broad'").get().c;
const trueEdge = db2.prepare("SELECT count(*) c FROM edges WHERE src='fact:condor-correction' AND rel='supersedes' AND dst='fact:condor-alert'").get().c;
db2.close();
if (falseEdge !== 0) throw new Error("cross-aspect supersede edge survived self-healing");
if (trueEdge !== 1) throw new Error("correction did not supersede its prior same-aspect assertion");

console.log("PASS \u2713 supersede lineage stays on the corrected aspect");
fs.rmSync(dataDir, { recursive: true, force: true });
