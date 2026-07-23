"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chronicles-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { applyAliases, applyChronicles, doctor, exportHarness, reportChronicles } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text) VALUES ('person:theresa-caldwell','','entity','semantic',0.5,'2026-06-25','caller-approved','','')").run();
  const facts = [
    ["fact:caldwell-blocked", "The Theresa Caldwell reschedule note remained blocked pending Jamie's approval.", "2026-06-25T09:00:00.000Z"],
    ["fact:caldwell-sent", "The approved destination-neutral Theresa Caldwell reschedule note was sent.", "2026-06-25T15:00:00.000Z"],
  ];
  for (const [sig, fact, at] of facts) {
    const info = db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq)
      VALUES (?,'','fact','episodic',0.6,?,?,?,?,'harness-ingest',?,? ,1,1)
    `).run(sig, at, at.slice(0, 10), at, at, fact, fact);
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(fact)));
    db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,'mentions','person:theresa-caldwell',0.8,?,?)")
      .run(sig, at, at);
  }
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();

  const report = reportChronicles(db, { asOf: "2026-06-25" });
  const day = report.candidates.find((c) => c.periodId === "day:2026-06-25:2026-06-25");
  if (!day || day.members.length !== 2) throw new Error("closed day did not become a chronicle candidate");
  const incompleteApply = await applyChronicles(db, { report_id: report.report_id, decisions: [] }, { asOf: "2026-06-25" });
  if (incompleteApply.complete || !incompleteApply.rejected.some((row) => row.reason === "period_missing" && row.periodId === day.periodId)) {
    throw new Error("engine accepted a partial chronicle decision set");
  }
  const applied = await applyChronicles(db, {
    report_id: report.report_id,
    decisions: [{
      periodId: day.periodId,
      summary: "The Caldwell reschedule moved from approval hold to sent.",
      entries: [
        {
          slot: "morning",
          summary: "The external send remained blocked pending Jamie's approval.",
          changeKind: "changed",
          stateLabel: "pending",
          aspect: "customer-reschedule",
          entitySigs: ["person:theresa-caldwell"],
          evidenceSigs: ["fact:caldwell-blocked"],
        },
        {
          slot: "afternoon",
          summary: "The approved destination-neutral reschedule note was sent.",
          changeKind: "completed",
          stateLabel: "sent",
          aspect: "customer-reschedule",
          entitySigs: ["person:theresa-caldwell"],
          evidenceSigs: ["fact:caldwell-sent"],
        },
      ],
    }],
  }, { asOf: "2026-06-25" });
  if (!applied.complete || applied.chronicles_created !== 1) throw new Error(`chronicle apply failed: ${JSON.stringify(applied)}`);
  const chronicle = db.prepare("SELECT n.signature,n.kind,n.notes,c.resolution,c.covered_event_count FROM nodes n JOIN chronicles c ON c.node_sig=n.signature").get();
  if (!chronicle || chronicle.kind !== "chronicle" || chronicle.resolution !== "day" || chronicle.covered_event_count !== 2) {
    throw new Error("chronicle node or metadata was not persisted");
  }
  const coverage = db.prepare("SELECT evidence_sig FROM chronicle_evidence WHERE chronicle_sig=? ORDER BY evidence_sig").all(chronicle.signature);
  if (coverage.length !== 2) throw new Error("chronicle coverage manifest is incomplete");
  db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text) VALUES ('person:theresa','','entity','semantic',0.5,'2026-06-25','caller-approved','','theresa')").run();
  db.prepare("UPDATE chronicle_entry_entities SET entity_sig='person:theresa' WHERE chronicle_sig=? AND entry_ordinal=0 AND entity_sig='person:theresa-caldwell'")
    .run(chronicle.signature);
  db.prepare("UPDATE edges SET dst='person:theresa' WHERE src=? AND rel='mentions' AND dst='person:theresa-caldwell'")
    .run(chronicle.signature);
  const aliasResult = await applyAliases(db, [{ canonical: "person:theresa-caldwell", aliases: ["person:theresa"] }], { asOf: "2026-06-25" });
  if (aliasResult.aliases_merged !== 1) throw new Error("chronicle alias fixture did not merge");
  if (db.prepare("SELECT 1 FROM chronicle_entry_entities WHERE entity_sig='person:theresa'").get()) {
    throw new Error("chronicle entry retained a deleted alias entity");
  }
  if (!db.prepare("SELECT 1 FROM chronicle_entry_entities WHERE chronicle_sig=? AND entity_sig='person:theresa-caldwell'").get(chronicle.signature)) {
    throw new Error("chronicle entry did not repoint its entity facet to the canonical hub");
  }
  if (!doctor(db).healthy) throw new Error("alias folding left temporal graph corruption");
  const projected = exportHarness(db, "2026-06-25").find((r) => r.signature === chronicle.signature);
  if (!projected || projected.tier !== "chronicle" || !/TEMPORAL MEMORY · DAY/.test(projected.fact || "")) {
    throw new Error("chronicle was not projected as temporal memory");
  }
  const undatedQuery = "How did the Caldwell reschedule move from blocked to sent?";
  const crowdVector = toVecBlob(await embedOne(undatedQuery));
  for (let i = 0; i < 80; i += 1) {
    const row = db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text)
      VALUES (?,'','fact','episodic',0.5,'2026-06-25','2026-06-25','2026-06-25','2026-06-25','harness-ingest',?,?)
    `).run(`fact:crowd-${i}`, `${undatedQuery} distractor ${i}`, `${undatedQuery} distractor ${i}`);
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(row.lastInsertRowid), crowdVector);
  }
  const insertDayChronicle = async (day, summary, evidenceFact) => {
    const factSig = `fact:timeline-${day}`;
    const factRow = db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text)
      VALUES (?,'','fact','episodic',0.5,?,?,?,?,'harness-ingest',?,?)
    `).run(factSig, `${day}T12:00:00.000Z`, day, `${day}T12:00:00.000Z`, `${day}T12:00:00.000Z`, evidenceFact, evidenceFact);
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(factRow.lastInsertRowid), toVecBlob(await embedOne(evidenceFact)));
    const chronicleSig = `chronicle:day:${day}:fixture`;
    const chronicleRow = db.prepare(`
      INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,temporal_form,memory_family)
      VALUES (?,'','chronicle','semantic',0.5,?,'',?,?,'period-bound',?)
    `).run(chronicleSig, `${day}T23:59:59.000Z`, `Overview for ${day}.`, `Overview for ${day}.`, `timeline:day:${day}`);
    db.prepare("INSERT INTO vec_chronicles(rowid,embedding) VALUES (?,?)")
      .run(BigInt(chronicleRow.lastInsertRowid), toVecBlob(await embedOne(`Overview for ${day}.`)));
    db.prepare(`
      INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,covered_event_count,latest_event_day,created_at)
      VALUES (?,'day',?,?,1,1,?,?)
    `).run(chronicleSig, day, day, day, `${day}T23:59:59.000Z`);
    db.prepare(`
      INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind,aspect)
      VALUES (?,0,?,?,'continuity','operating-posture')
    `).run(chronicleSig, day, summary);
    db.prepare("INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig) VALUES (?,0,?)").run(chronicleSig, factSig);
    return chronicleSig;
  };
  const rangeChronicles = [chronicle.signature];
  rangeChronicles.push(await insertDayChronicle("2026-06-26", "The workweek operating posture continued.", "The June 26 workweek operating posture continued."));
  rangeChronicles.push(await insertDayChronicle("2026-06-27", "The workweek operating posture stayed active.", "The June 27 workweek operating posture stayed active."));
  rangeChronicles.push(await insertDayChronicle("2026-06-28", "The workweek operating posture reached its endpoint.", "The June 28 workweek operating posture reached its endpoint."));
  const lexicalChronicle = await insertDayChronicle(
    "2026-02-15",
    "The Caldwell escalation entered written remediation with a draft staged for Jamie review.",
    "The Caldwell remediation plan draft was staged for Jamie review on 2026-02-15.",
  );
  db.close();

  const recalled = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "What changed with the Theresa Caldwell reschedule on June 25, 2026?",
    "--k", "8",
    "--as-of", "2026-06-25",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  if (!recalled.temporalRoutes.some((r) => r.id === chronicle.signature)) {
    throw new Error("recall did not expose the matching chronicle in the temporal lane");
  }
  const evidence = recalled.evidenceHits.filter((r) =>
    r.via === "derived_evidence" && r.axis === "temporal");
  const evidenceIds = new Set(evidence.map((r) => r.id));
  if (!evidenceIds.has("fact:caldwell-blocked") || !evidenceIds.has("fact:caldwell-sent")) {
    throw new Error(`paired temporal recall did not retain exact endpoint evidence: ${JSON.stringify(recalled.evidenceHits)}`);
  }
  const undated = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", undatedQuery,
    "--k", "8",
    "--as-of", "2026-06-25",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  if (!undated.temporalRoutes.some((r) => r.id === chronicle.signature && r.via === "chronicle_vector")) {
    throw new Error("semantic vector crowding hid the dedicated chronicle index");
  }
  const ranged = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "How did the operating posture change from June 25 through June 28, 2026?",
    "--k", "8",
    "--as-of", "2026-06-28",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  const routedRange = new Set(ranged.temporalRoutes.map((r) => r.id));
  if (!rangeChronicles.every((sig) => routedRange.has(sig))) {
    throw new Error(`explicit short range omitted a daily transition endpoint: ${JSON.stringify([...routedRange])}`);
  }
  const rangedEvidence = ranged.evidenceHits.filter((r) =>
    r.via === "derived_evidence" && r.axis === "temporal");
  if (!rangedEvidence.some((r) => r.id === "fact:caldwell-blocked")
    || !rangedEvidence.some((r) => r.id === "fact:timeline-2026-06-28")) {
    throw new Error(`short-range temporal recall did not reserve both endpoints: ${JSON.stringify(rangedEvidence)}`);
  }
  const lexical = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "When did the Caldwell escalation enter written remediation with a draft staged for Jamie review?",
    "--k", "8",
    "--as-of", "2026-06-28",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  if (!lexical.temporalRoutes.some((r) => r.id === lexicalChronicle)) {
    throw new Error("entry-level lexical routing missed the matching transition chronicle");
  }

  console.log("PASS: chronicles project and recall as a paired temporal axis");
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
