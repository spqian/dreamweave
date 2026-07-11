"use strict";

// A one-hop semantic hit must expand its whole indexed sequence component.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-sequence-recall-"));
process.env.AGENT_MEMORY_DIR = dataDir;
const cleanup = () => fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  const facts = [
    ["fact:reset-start", "The Caldwell forecast reset began with a downside review.", "2026-02-25"],
    ["fact:reset-review", "The Caldwell forecast reset continued through sponsor review.", "2026-02-26"],
    ["fact:reset-confirmed", "The Caldwell forecast reset was confirmed and became the operating baseline.", "2026-02-27"],
    ["fact:reset-communicated", "The Caldwell forecast reset was communicated to the operating team.", "2026-02-28"],
    ["fact:reset-closed", "The Caldwell forecast reset closed after the operating team acknowledged it.", "2026-03-01"],
  ];
  const ins = db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,fact) VALUES (?,'fact','episodic',0.4,?,?)");
  const insVec = db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)");
  for (const [sig, fact, firstSeen] of facts) {
    const info = ins.run(sig, firstSeen, fact);
    insVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(fact)));
  }
  const edge = db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES (?,'sequence',?,0.8)");
  edge.run("fact:reset-start", "fact:reset-review");
  edge.run("fact:reset-review", "fact:reset-confirmed");
  edge.run("fact:reset-confirmed", "fact:reset-communicated");
  edge.run("fact:reset-communicated", "fact:reset-closed");
  db.close();

  const result = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "When did the Caldwell forecast reset begin?",
    "--seed-limit", "1",
    "--max-hops", "1",
    "--as-of", "2026-02-27",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));

  const closed = result.cluster.nodes.find((n) => n.id === "fact:reset-closed");
  if (!closed) throw new Error("far sequence member was not recalled");
  if (closed.chain_id == null) throw new Error("expanded sequence member has no chain identity");
  if (closed.via !== "sequence") throw new Error(`far member arrived via ${closed.via || "bounded walk"}, not sequence expansion`);

  console.log("PASS \u2713 recall expands indexed sequence components without a global edge scan");
  cleanup();
})().catch((e) => {
  console.error(e);
  try { cleanup(); } catch {}
  process.exit(1);
});
