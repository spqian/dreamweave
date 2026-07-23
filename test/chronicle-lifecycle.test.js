"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chronicle-life-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { dreamCore, doctor } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);
  db.prepare("INSERT INTO nodes(signature,kind,class,strength,first_seen,notes,fact,text) VALUES ('person:caldwell','entity','semantic',0.5,'2026-06-25','caller-approved','','')").run();
  const factText = "The Theresa Caldwell reschedule note was sent after approval.";
  const fact = db.prepare(`
    INSERT INTO nodes(signature,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text)
    VALUES ('fact:sent','fact','episodic',0.6,'2026-06-25T15:00:00.000Z','2026-06-25',
            '2026-06-25T15:00:00.000Z','2026-06-25T15:00:00.000Z','detail',?,?)
  `).run(factText, factText);
  db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(fact.lastInsertRowid), toVecBlob(await embedOne(factText)));
  db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES ('fact:sent','mentions','person:caldwell',0.8,'2026-06-25','2026-06-25')").run();

  async function addChronicle(sig, resolution, start, end, evidenceSig, text) {
    const row = db.prepare(`
      INSERT INTO nodes(signature,kind,class,salience_score,strength,first_seen,last_reactivated,last_decayed,notes,fact,text,temporal_form,memory_family)
      VALUES (?,'chronicle','semantic',0,0.6,?,?,?,'chronicle',?,?,'period-bound',?)
    `).run(sig, `${end}T23:59:59.999Z`, `${end}T23:59:59.999Z`, `${end}T23:59:59.999Z`,
      text, text, `timeline:${resolution}:${start}`);
    const vector = toVecBlob(await embedOne(text));
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)").run(BigInt(row.lastInsertRowid), vector);
    db.prepare("INSERT INTO vec_chronicles(rowid,embedding) VALUES (?,?)").run(BigInt(row.lastInsertRowid), vector);
    db.prepare(`
      INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,compression_level,
        covered_event_count,omitted_event_count,latest_event_day,coverage_seq,created_at)
      VALUES (?,?,?,?,1,?,1,0,?,1,?)
    `).run(sig, resolution, start, end, ["day", "week", "month", "quarter", "year"].indexOf(resolution), end, `${end}T23:59:59.999Z`);
    db.prepare("INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind) VALUES (?,0,?,?,?)")
      .run(sig, start, text, "completed");
    db.prepare("INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig) VALUES (?,0,?)").run(sig, evidenceSig);
  }

  await addChronicle("chronicle:day", "day", "2026-06-25", "2026-06-25", "fact:sent", "Caldwell approval completed and the note was sent.");
  await addChronicle("chronicle:week", "week", "2026-06-22", "2026-06-28", "chronicle:day", "The week records completion of the Caldwell reschedule.");

  const result = dreamCore(db, { "as-of": "2026-07-15", "run-id": "chronicle-lifecycle" });
  if (result.chronicles_demoted !== 1) throw new Error(`expected one fine chronicle demotion: ${JSON.stringify(result)}`);
  const day = db.prepare("SELECT id,notes FROM nodes WHERE signature='chronicle:day'").get();
  if (day.notes !== "archive") throw new Error("obsolete day chronicle remained active");
  if (db.prepare("SELECT 1 FROM vec_nodes WHERE rowid=?").get(BigInt(day.id))) throw new Error("archived day remained in active vectors");
  if (!db.prepare("SELECT 1 FROM vec_archive WHERE rowid=?").get(BigInt(day.id))) throw new Error("archived day lost its vector");
  if (db.prepare("SELECT 1 FROM vec_chronicles WHERE rowid=?").get(BigInt(day.id))) throw new Error("archived day remained in active chronicle vectors");
  if (!db.prepare("SELECT 1 FROM vec_chronicles_archive WHERE rowid=?").get(BigInt(day.id))) throw new Error("archived day lost its chronicle vector");
  if (db.prepare("SELECT notes FROM nodes WHERE signature='chronicle:week'").get().notes === "archive") throw new Error("covering week was demoted");
  const health = doctor(db);
  if (!health.healthy) throw new Error(`doctor rejected valid chronicle skyline: ${JSON.stringify(health)}`);
  db.close();

  const recalled = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "What happened with Caldwell on June 25, 2026?",
    "--k", "8",
    "--as-of", "2026-07-15",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  const archivedDay = recalled.temporalRoutes.find((r) => r.id === "chronicle:day");
  if (!archivedDay || !String(archivedDay.via).startsWith("chronicle_archive")) {
    throw new Error("explicit-date recall did not recover the archived day chronicle");
  }
  if (!recalled.evidenceHits.some((r) =>
    r.id === "fact:sent" && r.via === "derived_evidence" && r.axis === "temporal")) {
    throw new Error("archived chronicle did not expand to exact evidence");
  }

  console.log("PASS: chronicle skyline demotes fine periods without losing recall");
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
