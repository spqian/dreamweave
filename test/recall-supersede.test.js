"use strict";
// Synthetic verification of recall.js supersede + seed-demote fix.
// Builds a tiny memory.db with two conflicting Condor valuation facts (older
// $420-475M superseded by newer $620-760M) + a supersedes edge, then runs
// recall.js and asserts the survivor seeds first and the old node is flagged.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  const facts = [
    { sig: "fact:condor-old", fact: "Project Condor working purchase-price range is $420M-$475M enterprise value (as of 2026-01-03).", first_seen: "2026-01-03", strength: 0.6 },
    { sig: "fact:condor-new", fact: "Project Condor working purchase-price range was revised to $620M to $760M enterprise value.", first_seen: "2026-01-22", strength: 0.78 },
    { sig: "fact:condor-noise", fact: "Project Condor diligence centers on timing-risk and disclosure questions for full-year EBITDA.", first_seen: "2026-01-10", strength: 0.5 },
  ];
  const ins = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, fact, kind) VALUES (?,?,?,?,?,'fact')");
  const insVec = db.prepare("INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)");
  for (const f of facts) {
    const info = ins.run(f.sig, "semantic", f.strength, f.first_seen, f.fact);
    insVec.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(f.fact)));
  }
  // correction: condor-new supersedes condor-old
  db.prepare("INSERT INTO edges (src, rel, dst, weight, first_seen) VALUES (?,?,?,?,?)")
    .run("fact:condor-new", "supersedes", "fact:condor-old", 0.9, "2026-01-22");
  db.close();

  const out = execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "What was the working purchase-price range for Project Condor?",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });
  const res = JSON.parse(out);

  const seed0 = res.seeds[0];
  const oldNode = res.cluster.nodes.find((n) => n.id === "fact:condor-old");
  const newNode = res.cluster.nodes.find((n) => n.id === "fact:condor-new");

  console.log("seeds order:", res.seeds.join(" > "));
  console.log("condor-old superseded flag:", oldNode && oldNode.superseded, "superseded_by:", oldNode && oldNode.superseded_by);
  console.log("condor-new superseded flag:", newNode && newNode.superseded);

  let ok = true;
  if (seed0 !== "fact:condor-new") { console.error("FAIL: survivor (condor-new) should seed first, got", seed0); ok = false; }
  if (!(oldNode && oldNode.superseded === true && oldNode.superseded_by === "fact:condor-new")) { console.error("FAIL: condor-old should be flagged superseded_by condor-new"); ok = false; }
  if (newNode && newNode.superseded) { console.error("FAIL: condor-new should NOT be superseded"); ok = false; }
  console.log(ok ? "\nPASS ✓ recall fix works" : "\nFAILED ✗");
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* tmp left behind, fine */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
