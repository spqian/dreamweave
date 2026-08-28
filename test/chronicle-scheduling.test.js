"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chron-scheduling-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { reportChronicles } = require("../src/dream");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);

const addDay = (day, seq, withChronicle = true) => {
  const factSig = `fact:${day}`;
  db.prepare(`
    INSERT INTO nodes(signature,kind,class,fact,text,first_seen,source_day,dirty_seq)
    VALUES (?,'fact','episodic',?,?,?, ?,?)
  `).run(factSig, `Work recorded on ${day}.`, `Work recorded on ${day}.`, `${day}T12:00:00Z`, day, seq);
  if (!withChronicle) return;
  const chronicleSig = `chronicle:day:${day}:v1`;
  db.prepare(`
    INSERT INTO nodes(signature,kind,class,notes,fact,text,first_seen,dirty_seq)
    VALUES (?,'chronicle','semantic','chronicle',?,?,?,?)
  `).run(chronicleSig, `Summary for ${day}.`, `Summary for ${day}.`, `${day}T23:59:59Z`, seq);
  db.prepare(`
    INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,
      covered_event_count,coverage_seq,created_at)
    VALUES (?,'day',?,?,1,1,?,?)
  `).run(chronicleSig, day, day, seq, `${day}T23:59:59Z`);
  db.prepare(`
    INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind)
    VALUES (?,0,'day',?,'continuity')
  `).run(chronicleSig, `Summary for ${day}.`);
  db.prepare(`
    INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig)
    VALUES (?,0,?)
  `).run(chronicleSig, factSig);
};

addDay("2026-07-01", 1);
for (let day = 3; day <= 16; day += 1) {
  addDay(`2026-08-${String(day).padStart(2, "0")}`, day);
}
addDay("2026-08-17", 20, false);

const bounded = reportChronicles(db, { asOf: "2026-08-18", maxCandidates: 3 }).candidates;
if (bounded[0]?.periodId !== "day:2026-08-17:2026-08-17") {
  throw new Error(`newest day lost priority: ${bounded.map((c) => c.periodId).join(", ")}`);
}
if (!bounded.some((candidate) => candidate.periodId === "week:2026-08-10:2026-08-16")) {
  throw new Error("newest closed week was starved by daily work");
}
if (!bounded.some((candidate) => candidate.periodId === "month:2026-07-01:2026-07-31")) {
  throw new Error("closed month was starved by newer daily work");
}
if (bounded.some((candidate) => candidate.periodId === "week:2026-08-17:2026-08-23")) {
  throw new Error("an open week was reported");
}

const julyMonthSig = "chronicle:month:2026-07-01:v1";
db.prepare(`
  INSERT INTO nodes(signature,kind,class,notes,fact,text,first_seen,dirty_seq)
  VALUES (?,'chronicle','semantic','chronicle','July summary.','July summary.','2026-07-31T23:59:59Z',1)
`).run(julyMonthSig);
db.prepare(`
  INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,
    covered_event_count,coverage_seq,created_at)
  VALUES (?,'month','2026-07-01','2026-07-31',1,1,1,'2026-08-01T00:00:00Z')
`).run(julyMonthSig);
db.prepare(`
  INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind)
  VALUES (?,0,'month','July summary.','continuity')
`).run(julyMonthSig);
db.prepare(`
  INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig)
  VALUES (?,0,'chronicle:day:2026-07-01:v1')
`).run(julyMonthSig);

addDay("2026-07-02", 1);
const reopened = reportChronicles(db, { asOf: "2026-08-18", maxCandidates: 50 }).candidates;
const july = reopened.find((candidate) => candidate.periodId === "month:2026-07-01:2026-07-31");
if (!july || july.members.length !== 2) {
  throw new Error("a coarse chronicle did not reopen when an older-sequence child was added");
}

db.close();
fs.rmSync(dataDir, { recursive: true, force: true });

const backlogDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chron-backlog-"));
const backlogDb = new Database(path.join(backlogDir, "memory.db"));
sqliteVec.load(backlogDb);
ensureSchema(backlogDb);
for (let day = 1; day <= 12; day += 1) {
  const iso = `2026-06-${String(day).padStart(2, "0")}`;
  backlogDb.prepare(`
    INSERT INTO nodes(signature,kind,class,fact,text,first_seen,source_day,dirty_seq)
    VALUES (?,'fact','episodic',?,?,?, ?,?)
  `).run(`fact:${iso}`, `Work recorded on ${iso}.`, `Work recorded on ${iso}.`, `${iso}T12:00:00Z`, iso, day);
}
const backlog = reportChronicles(backlogDb, { asOf: "2026-06-13", maxCandidates: 3 }).candidates;
if (backlog[0]?.periodId !== "day:2026-06-12:2026-06-12"
  || !backlog.some((candidate) => candidate.periodId === "day:2026-06-01:2026-06-01")) {
  throw new Error(`bounded report did not pair live progress with oldest backlog: ${backlog.map((c) => c.periodId).join(", ")}`);
}
backlogDb.close();
fs.rmSync(backlogDir, { recursive: true, force: true });

console.log("PASS: chronicle scheduling advances daily and coarse timelines without partial rollups");
