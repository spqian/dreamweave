"use strict";

// Semantic 3D projection must be deterministic, bounded, and linear-space.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-viz-projection-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { projectEmbeddings3D } = require("../src/dream");
const { toVecBlob, DIMS } = require("../src/embed");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);
const ins = db.prepare("INSERT INTO nodes(signature,kind,class) VALUES (?,'fact','episodic')");
const insVec = db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)");
const count = 1000;
for (let i = 0; i < count; i += 1) {
  const info = ins.run(`fact:projection-${i}`);
  const v = new Float32Array(DIMS);
  let norm = 0;
  for (let j = 0; j < DIMS; j += 1) {
    v[j] = Math.sin((i + 1) * (j + 3) * 0.017);
    norm += v[j] * v[j];
  }
  norm = Math.sqrt(norm);
  for (let j = 0; j < DIMS; j += 1) v[j] /= norm;
  insVec.run(BigInt(info.lastInsertRowid), toVecBlob(v));
}

const a = projectEmbeddings3D(db);
const b = projectEmbeddings3D(db);
if (a.size !== count || b.size !== count) throw new Error(`projected ${a.size}/${count} nodes`);
for (const [sig, p] of a) {
  const q = b.get(sig);
  if (!q || p.some((x, i) => !Number.isFinite(x) || x !== q[i])) throw new Error(`non-deterministic coordinate for ${sig}`);
  if (Math.hypot(...p) > 210.1) throw new Error(`coordinate escaped projection radius for ${sig}`);
}

console.log("PASS \u2713 visualization projection is deterministic and bounded at 1000 nodes");
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
