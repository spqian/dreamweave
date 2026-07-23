"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-derived-contract-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const langsvc = require("../src/langsvc");
  const { describeDerived, reserveDerivedEvidence } = require("../src/derived-memory");
  const { doctor } = require("../src/dream");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  const query = "What exact Project Atlas change was recorded on July 10, 2026?";
  const queryVector = toVecBlob(await embedOne(query));
  const insertFact = async (sig, fact, day, options = {}) => {
    const at = `${day}T12:00:00.000Z`;
    const row = db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text)
      VALUES (?,'','fact','episodic',?,?,?,?,?,?,?,?)
    `).run(sig, options.strength ?? 0.6, at, day, at, at, options.notes || "detail", fact, fact);
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
      .run(BigInt(row.lastInsertRowid), options.vector || toVecBlob(await embedOne(fact)));
    return row;
  };

  for (let i = 0; i < 8; i += 1) {
    await insertFact(
      `fact:atlas-distractor-${i}`,
      `${query} unrelated historical distractor ${i}`,
      "2026-07-01",
      { strength: 0.95, notes: "harness-ingest", vector: queryVector },
    );
  }
  await insertFact(
    "fact:atlas-active-exact",
    "The exact Project Atlas record on July 10 confirms the change number was 42.",
    "2026-07-10",
    { strength: 0.2, notes: "detail" },
  );
  const semanticEvidence = [];
  for (let i = 0; i < 6; i += 1) {
    const sig = `fact:atlas-semantic-${i}`;
    semanticEvidence.push(sig);
    await insertFact(sig, `Project Atlas semantic evidence item ${i}.`, `2026-07-0${i + 2}`, { notes: "detail" });
  }
  await insertFact(
    "fact:atlas-temporal",
    "Project Atlas temporal endpoint evidence records the staged transition.",
    "2026-07-08",
    { notes: "detail" },
  );

  const gistFact = "Project Atlas changed through a staged transition and exact evidence remains linked.";
  const gist = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,temporal_form,memory_family)
    VALUES ('fact:atlas-gist','','fact','semantic',0.95,'2026-07-10T23:00:00.000Z','gist',?,?,'trajectory','atlas:semantic')
  `).run(gistFact, gistFact);
  db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
    .run(BigInt(gist.lastInsertRowid), queryVector);
  semanticEvidence.forEach((sig, ordinal) => {
    db.prepare("INSERT INTO gist_landmarks(gist_sig,role,ordinal,evidence_sig) VALUES ('fact:atlas-gist','change',?,?)")
      .run(ordinal, sig);
  });
  db.prepare(`
    INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced)
    VALUES ('fact:atlas-distractor-0','related_to','fact:atlas-gist',0.9,'2026-07-10','2026-07-10')
  `).run();

  const chronicleFact = "Project Atlas July 10 temporal overview.";
  const chronicle = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,temporal_form,memory_family)
    VALUES ('chronicle:atlas-day','','chronicle','semantic',0.8,'2026-07-10T23:59:59.000Z','chronicle',?,?,'period-bound','timeline:day:2026-07-10')
  `).run(chronicleFact, chronicleFact);
  db.prepare("INSERT INTO vec_chronicles(rowid,embedding) VALUES (?,?)")
    .run(BigInt(chronicle.lastInsertRowid), queryVector);
  db.prepare(`
    INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,compression_level,
      covered_event_count,omitted_event_count,latest_event_day,coverage_seq,created_at)
    VALUES ('chronicle:atlas-day','day','2026-07-10','2026-07-10',1,0,1,0,'2026-07-10',1,'2026-07-10T23:59:59.000Z')
  `).run();
  db.prepare(`
    INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind,aspect)
    VALUES ('chronicle:atlas-day',0,'endpoint','Project Atlas reached its staged endpoint.','changed','project-status')
  `).run();
  db.prepare(`
    INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig)
    VALUES ('chronicle:atlas-day',0,'fact:atlas-temporal')
  `).run();

  const previousMax = process.env.MEMORY_DERIVED_MAX_PER_PARENT;
  process.env.MEMORY_DERIVED_MAX_PER_PARENT = "2";
  try {
    const descriptor = describeDerived(db, {
      signature: "fact:atlas-gist",
      kind: "fact",
      notes: "gist",
      activation: 1,
    });
    const capped = reserveDerivedEvidence(db, [descriptor], {
      terms: ["project", "atlas"],
      dateRange: null,
      specificsIntent: false,
      nowRef: new Date("2026-07-10T23:59:59.000Z"),
      qFloat: await embedOne(query),
      k: 8,
      L: langsvc.resolve(),
    });
    if (capped.length !== 2 || capped.some((hit) => hit.parent !== "fact:atlas-gist")) {
      throw new Error(`DERIVED_MAX_PER_PARENT did not cap a flooding parent: ${JSON.stringify(capped)}`);
    }
  } finally {
    if (previousMax == null) delete process.env.MEMORY_DERIVED_MAX_PER_PARENT;
    else process.env.MEMORY_DERIVED_MAX_PER_PARENT = previousMax;
  }
  db.close();

  const recalled = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", query,
    "--k", "8",
    "--as-of", "2026-07-10T23:59:59.000Z",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  const derived = recalled.evidenceHits.filter((hit) => hit.via === "derived_evidence");
  if (!derived.some((hit) => hit.axis === "semantic" && hit.parent === "fact:atlas-gist")
    || !derived.some((hit) => hit.axis === "temporal" && hit.parent === "chronicle:atlas-day")) {
    throw new Error(`cross-axis derived evidence starved a parent: ${JSON.stringify(derived)}`);
  }
  const activeIndex = recalled.evidenceHits.findIndex((hit) => hit.id === "fact:atlas-active-exact" && hit.via === "active_time");
  const derivedIndex = recalled.evidenceHits.findIndex((hit) => hit.via === "derived_evidence");
  if (activeIndex < 0 || derivedIndex < 0 || activeIndex > derivedIndex) {
    throw new Error(`derived evidence outranked the exact active-time record: ${JSON.stringify(recalled.evidenceHits)}`);
  }

  const doctorDb = new Database(dbPath);
  sqliteVec.load(doctorDb);
  const orphan = doctorDb.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text)
    VALUES ('fact:orphan-derived','','fact','semantic',0.5,'2026-07-10','gist','Orphan derived index.','Orphan derived index.')
  `).run();
  doctorDb.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
    .run(BigInt(orphan.lastInsertRowid), toVecBlob(await embedOne("Orphan derived index.")));
  const health = doctor(doctorDb);
  if (health.derived_without_evidence < 1 || health.healthy) {
    throw new Error(`doctor did not flag a derived memory with zero evidence: ${JSON.stringify(health)}`);
  }
  doctorDb.close();

  console.log("PASS: shared derived-evidence contract enforces fairness, caps, integrity, and authority");
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
