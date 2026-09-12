"use strict";

// A chronicle summary is the retrieval surface of the temporal axis: it is embedded and
// later matched against natural-language questions ("what happened around <date>", "when
// did X first come up"). Three things previously guaranteed that surface carried no signal,
// independent of how well the summary was authored:
//
//   1. Rollup input was truncated to the child chronicle's FIRST LINE, so week/month/quarter
//      judges never saw a single named specific -- only the day's headline. Vagueness
//      compounded by construction and no prompt could have recovered it.
//   2. The projected envelope appended `Evidence coverage: N linked items` / `Compression
//      level: N` -- exact counts already in the db, recomputable with one query, displacing
//      the named specifics that make a period findable.
//   3. Nothing measured the result, so collapse was silent. Live day chronicles had drifted
//      to a mean pairwise cosine of 0.989 (ordinary facts sit near 0.37) -- every period at
//      the same point in embedding space, so a query matching one matched all of them.
//
// This test pins all three, plus the SKILL.md contract that tells the judge what to write.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-chron-surface-"));
process.env.AGENT_MEMORY_DIR = dataDir;

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");
const { reportChronicles, doctor } = require("../src/dream");
const { renderChronicleEnvelope } = require("../src/memory-render");
const cfg = require("../config");

const fail = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);

const now = "2026-06-01T00:00:00.000Z";
const insNode = db.prepare(`INSERT INTO nodes(signature,kind,class,notes,fact,text,first_seen,source_day,last_decayed,last_reactivated)
  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const insChron = db.prepare(`INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,compression_level,covered_event_count,coverage_seq,created_at)
  VALUES (?,?,?,?,?,?,?,?,?)`);
const insEntry = db.prepare("INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind) VALUES (?,?,?,?,?)");
const insEvidence = db.prepare("INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig) VALUES (?,?,?)");

// The named specific deliberately lives BELOW the headline, where first-line truncation
// used to drop it. It is the kind of proper noun a future question would be phrased in.
const SPECIFIC = "OneIdentity";
const days = ["2026-05-04", "2026-05-05", "2026-05-06"];
for (const day of days) {
  insNode.run(`fact:evidence-${day}`, "fact", "episodic", null,
    `${SPECIFIC} access request raised on ${day}`, `${SPECIFIC} access request raised on ${day}`,
    `${day}T12:00:00Z`, day, now, now);
  const sig = `chronicle:day:${day}:v1`;
  insNode.run(sig, "chronicle", "semantic", "chronicle",
    `Day ${day}: 1 tracked item.\n- morning: ${SPECIFIC} approval routed to the Gateway release`,
    `Day ${day}`, `${day}T23:59:59Z`, null, now, now);
  insChron.run(sig, "day", day, day, 1, 0, 1, 1, now);
  insEntry.run(sig, 0, "morning", `${SPECIFIC} approval routed to the Gateway release`, "introduced");
  insEvidence.run(sig, 0, `fact:evidence-${day}`);
}

// --- 1. rollup members must carry the whole child summary ---------------------
const report = reportChronicles(db, { asOf: "2026-06-01" });
const week = report.candidates.find((c) => c.resolution === "week");
if (!week) fail("no week candidate was produced; the rollup path is untested");
if (!week.members.length) fail("week candidate has no child chronicles as members");
if (!week.members.every((m) => m.kind === "chronicle")) fail("week members should be child chronicles");
const carrying = week.members.filter((m) => String(m.fact || "").includes(SPECIFIC));
if (carrying.length !== week.members.length) {
  fail(`rollup input dropped the named specific: only ${carrying.length}/${week.members.length} `
    + `week members mention "${SPECIFIC}". A coarser period cannot name what it was never shown.`);
}
if (!week.members.some((m) => /\r?\n/.test(String(m.fact || "")))) {
  fail("week members were flattened to a single line; the child's detail never reached the judge");
}

// --- 2. the projected envelope must not restate what the db already counts ----
const node = db.prepare("SELECT * FROM nodes WHERE signature=?").get(`chronicle:day:${days[0]}:v1`);
const envelope = renderChronicleEnvelope(db, node);
for (const noise of ["Evidence coverage", "Compression level"]) {
  if (envelope.includes(noise)) {
    fail(`projected chronicle still carries the "${noise}" footer -- an exact count already `
      + "held in chronicles/chronicle_evidence, spending harness budget to say nothing");
  }
}
if (!envelope.includes(SPECIFIC)) fail("projected chronicle lost the named specific from its entries");

// --- 3. collapse must be measurable -------------------------------------------
const DIM = cfg.EMBED_DIM;
const blob = (seed, spread) => {
  const buf = Buffer.alloc(DIM * 4);
  // Shared bulk + a small per-period delta: `spread` controls how far apart the periods sit.
  for (let i = 0; i < DIM; i += 1) buf.writeFloatLE(Math.sin(i * 0.11) + spread * Math.sin((i + seed * 97) * 1.7), i * 4);
  return buf;
};
const setVectors = (spread) => {
  db.prepare("DELETE FROM vec_chronicles").run();
  days.forEach((day, i) => {
    const id = db.prepare("SELECT id FROM nodes WHERE signature=?").get(`chronicle:day:${day}:v1`).id;
    db.prepare("INSERT INTO vec_chronicles(rowid,embedding) VALUES (?,?)").run(BigInt(id), blob(i, spread));
  });
};

setVectors(0.002); // interchangeable bookkeeping: every period lands on the same point
const collapsed = doctor(db).chronicle_vector_dispersion;
if (!collapsed) fail("doctor reports no chronicle_vector_dispersion; collapse stays invisible");
if (typeof collapsed.mean_pairwise_cosine !== "number") fail("dispersion diagnostic has no mean_pairwise_cosine");
if (collapsed.sampled !== days.length) fail(`dispersion sampled ${collapsed.sampled} chronicles, expected ${days.length}`);
if (!collapsed.degenerate) {
  fail(`near-identical chronicle vectors (cos=${collapsed.mean_pairwise_cosine}) were not flagged degenerate`);
}
if (collapsed.collapsed_pair_ratio !== 1) fail("every pair of identical-shaped vectors should count as collapsed");

setVectors(1.4); // periods that actually name different things
const dispersed = doctor(db).chronicle_vector_dispersion;
if (dispersed.degenerate) {
  fail(`well-separated chronicle vectors (cos=${dispersed.mean_pairwise_cosine}) were wrongly flagged degenerate`);
}
if (!(dispersed.mean_pairwise_cosine < collapsed.mean_pairwise_cosine)) {
  fail("dispersion metric does not decrease as periods become distinguishable");
}
db.close();

// --- 4. the canonical judge contract must ask for a retrieval surface ----------
const contract = fs.readFileSync(path.join(__dirname, "..", "docs", "JUDGMENT-SURFACES.md"), "utf8");
const chronicleSection = contract.slice(contract.indexOf("- **chronicles**"), contract.indexOf("Apply commands validate"));
if (!chronicleSection) fail("could not locate the chronicles section of JUDGMENT-SURFACES.md");
const required = [
  [/retrieval surface/i, "summary is not described as the retrieval surface it is embedded into"],
  [/when did .{0,20}first/i, "contract does not mention the \"when did X first\" query it must answer"],
  [/never write counts as content/i, "contract does not forbid counts-as-content"],
  [/NOT a restatement of `changeKind`/, "contract does not forbid slot labels that merely echo changeKind"],
  [/in full/i, "contract does not tell the judge coarser members arrive in full"],
];
for (const [re, msg] of required) if (!re.test(chronicleSection)) fail(msg);
if (/they index\s+existing dated evidence/.test(chronicleSection)) {
  fail("chronicles are still framed as an index; indexing is what produced the collapse");
}

console.log(`PASS \u2713 chronicle retrieval surface preserved `
  + `(rollup carries specifics, no accounting footer, dispersion ${collapsed.mean_pairwise_cosine} -> ${dispersed.mean_pairwise_cosine})`);
fs.rmSync(dataDir, { recursive: true, force: true });
