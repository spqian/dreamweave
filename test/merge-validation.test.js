"use strict";

// Apply-merges accepts only fresh engine-reported clusters and must leave every
// committed active fact searchable.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-merge-validation-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { applyMerges, doctor } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  const ins = db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,fact) VALUES (?,'fact','semantic',0.6,'2026-06-01',?)");
  const vec = db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)");
  const add = async (sig, fact) => {
    const r = ins.run(sig, fact);
    vec.run(BigInt(r.lastInsertRowid), toVecBlob(await embedOne(fact)));
  };
  await add("fact:alpha-1", "Alice Example owns the migration rollout checklist.");
  await add("fact:alpha-2", "Alice Example owns and maintains the migration rollout checklist.");
  await add("fact:unrelated", "The cafeteria serves lunch at noon.");
  db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,fact) VALUES ('person:alice-example','','entity','semantic',0.5,'2026-06-01','')").run();
  db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:alpha-1','mentions','person:alice-example',0.8)").run();
  db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:alpha-2','mentions','person:alice-example',0.8)").run();

  const rejected = await applyMerges(db, [{
    fact: "Alice owns the migration checklist and the cafeteria serves lunch at noon.",
    survivorSig: "fact:alpha-1",
    memberSigs: ["fact:alpha-1", "fact:unrelated"],
  }], { sim: 0.3 });
  if (rejected.decisions !== 0 || rejected.clusters_merged !== 0) throw new Error("unreported arbitrary merge was accepted");
  db.prepare("DELETE FROM meta WHERE key='last_reflect_seq'").run();

  const accepted = await applyMerges(db, [{
    fact: "Alice Example owns and maintains the migration rollout checklist.",
    survivorSig: "fact:alpha-1",
    memberSigs: ["fact:alpha-1", "fact:alpha-2"],
  }], { sim: 0.3 });
  if (accepted.decisions !== 1 || accepted.clusters_merged !== 1) throw new Error("reported merge was rejected");

  const health = doctor(db);
  if (health.active_missing_vectors !== 0 || health.active_in_archive_vectors !== 0) {
    throw new Error("merge committed an invalid vector state");
  }

  console.log("PASS \u2713 merges are report-bound and commit searchable vectors");
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
