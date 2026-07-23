"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-gist-evidence-"));
process.env.AGENT_MEMORY_DIR = dataDir;

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");
  const { applyMerges, exportHarness } = require("../src/dream");

  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  ensureSchema(db);

  const facts = [
    {
      sig: "fact:conference-guidance",
      fact: "Riley's January 14 parent-teacher conference school portal: Jamie's standing guidance is to escalate concerns early.",
      day: "2026-01-01",
    },
    {
      sig: "fact:conference-posted",
      fact: "Riley's January 14 parent-teacher conference school portal: the posting occurred on January 7, 2026.",
      day: "2026-01-07",
    },
    {
      sig: "fact:conference-confirmed",
      fact: "Riley's January 14 parent-teacher conference school portal: Jamie confirmed the January 7 posting.",
      day: "2026-01-08",
    },
    {
      sig: "fact:conference-reminder",
      fact: "Riley's January 14 parent-teacher conference school portal: the family received a reminder after the January 7 posting.",
      day: "2026-01-09",
    },
  ];
  const ins = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text,ingested_seq,dirty_seq)
    VALUES (?,'','fact','episodic',0.6,?,?,?,?,'harness-ingest',?,'',1,1)
  `);
  for (const f of facts) {
    const at = `${f.day}T00:00:00.000Z`;
    const info = ins.run(f.sig, at, f.day, at, at, f.fact);
    db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
      .run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(f.fact)));
  }
  db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text) VALUES ('school:riley-conference','','entity','semantic',0.5,'2026-01-01','caller-approved','','')").run();
  const mention = db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,'mentions','school:riley-conference',0.8,'2026-01-01','2026-01-01')");
  for (const f of facts) mention.run(f.sig);
  db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,0.8,'2026-01-07','2026-01-07')")
    .run(facts[0].sig, "sequence", facts[1].sig);
  db.prepare("INSERT INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES (?,?,?,0.8,'2026-01-08','2026-01-08')")
    .run(facts[1].sig, "sequence", facts[2].sig);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','1')").run();

  const gist = "Riley's school conference workflow combines Jamie's January 1 early-escalation guidance, the January 7 school-portal posting, and the January 14 conference.";
  const mergeResult = await applyMerges(db, [{
    fact: gist,
    survivorSig: facts[0].sig,
    memberSigs: facts.map((f) => f.sig),
    temporalForm: "trajectory",
    landmarks: {
      before: [facts[0].sig],
      change: [facts[1].sig],
      current: [facts[2].sig],
    },
  }], { asOf: "2026-01-10T00:00:00.000Z", sim: 0.1 });

  const gistRow = db.prepare("SELECT signature,first_seen,source_day,notes,fact,temporal_form FROM nodes WHERE notes='gist'").get();
  if (!gistRow || gistRow.notes !== "gist" || gistRow.source_day !== null) {
    const rows = db.prepare("SELECT signature,notes,fact FROM nodes WHERE kind='fact'").all();
    throw new Error(`merged gist retained citeable source provenance: ${JSON.stringify({ gistRow, mergeResult, rows })}`);
  }
  const projected = exportHarness(db, "2026-01-10T00:00:00.000Z")
    .find((r) => r.signature === gistRow.signature);
  if (!projected || projected.first_seen !== null || projected.source_day !== null) {
    throw new Error("projected gist exposed an episode source date");
  }
  if (gistRow.temporal_form !== "trajectory" || !/SEMANTIC MEMORY · EVOLVING/.test(projected.fact || "")) {
    throw new Error("projected gist did not disclose its temporal trajectory");
  }
  const durableTransitions = db.prepare("SELECT src_sig,rel,dst_sig FROM evidence_transitions WHERE rel='sequence' ORDER BY first_seen").all();
  if (durableTransitions.length < 2 || durableTransitions.some((e) => e.src_sig === gistRow.signature || e.dst_sig === gistRow.signature)) {
    throw new Error(`merge did not preserve sequence on retained evidence: ${JSON.stringify(durableTransitions)}`);
  }
  const landmarks = db.prepare("SELECT role,evidence_sig FROM gist_landmarks WHERE gist_sig=? ORDER BY role,ordinal").all(gistRow.signature);
  if (landmarks.length !== 3 || landmarks.some((l) => l.evidence_sig === gistRow.signature)) {
    throw new Error("gist landmarks were not persisted against retained evidence");
  }
  const competitorFact = "An unrelated Riley cafeteria summary happened to repeat January 14 conference portal wording.";
  const competitorEvidence = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,source_day,last_reactivated,last_decayed,notes,fact,text)
    VALUES ('fact:competing-gist-evidence','','fact','episodic',0.8,'2026-01-06T00:00:00.000Z','2026-01-06',
            '2026-01-06T00:00:00.000Z','2026-01-06T00:00:00.000Z','detail',?,?)
  `).run(competitorFact, competitorFact);
  db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
    .run(BigInt(competitorEvidence.lastInsertRowid), toVecBlob(await embedOne(competitorFact)));
  const competitorGist = "Riley January 14 conference portal cafeteria index.";
  const competitor = db.prepare(`
    INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,text,temporal_form,memory_family)
    VALUES ('fact:competing-gist','','fact','semantic',1.0,'2026-01-09T00:00:00.000Z','gist',?,?,'atemporal','fixture:competing')
  `).run(competitorGist, competitorGist);
  db.prepare("INSERT INTO vec_nodes(rowid,embedding) VALUES (?,?)")
    .run(BigInt(competitor.lastInsertRowid), toVecBlob(await embedOne(competitorGist)));
  db.prepare("INSERT INTO gist_landmarks(gist_sig,role,ordinal,evidence_sig) VALUES ('fact:competing-gist','change',0,'fact:competing-gist-evidence')").run();
  db.prepare("INSERT INTO detail_of(detail_sig,gist_sig,first_seen) VALUES ('fact:competing-gist-evidence','fact:competing-gist','2026-01-06')").run();
  db.close();

  const recalled = JSON.parse(execFileSync(process.execPath, [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", "When was Riley's January 14 conference posted to the school portal?",
    "--k", "8",
    "--as-of", "2026-01-10T00:00:00.000Z",
  ], { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" }));
  const nodes = recalled.cluster.nodes;
  const recalledGist = nodes.find((n) => n.id === gistRow.signature);
  if (!recalledGist || recalledGist.first_seen !== null || recalledGist.source_day !== null) {
    throw new Error("recall exposed the gist onset as source evidence");
  }
  const event = nodes.find((n) => n.tier !== "gist" && /posting occurred on January 7/.test(n.fact || ""));
  if (!event || event.source_day !== "2026-01-07") {
    throw new Error(`recall did not expand the dated event detail behind the gist: ${JSON.stringify(nodes.map((n) => ({ id: n.id, tier: n.tier, source_day: n.source_day, fact: n.fact })))}`);
  }
  const landmarkEvidence = recalled.evidenceHits.find((n) =>
    n.id === facts[1].sig
    && n.via === "derived_evidence"
    && n.axis === "semantic"
    && n.role === "change");
  if (!landmarkEvidence || landmarkEvidence.source_day !== "2026-01-07") {
    throw new Error("semantic gist did not reserve its exact change landmark in the evidence lane");
  }

  console.log("PASS: gists are timeless indexes and exact dates come from detail evidence");
  fs.rmSync(dataDir, { recursive: true, force: true });
})().catch((error) => {
  console.error(error);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
