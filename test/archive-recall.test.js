"use strict";
// Integration test: the cold "bookshelf" (archive) must be recallable BOTH ways.
//   (A) WITH a time window  — a date-bearing query (no topical terms) reaches archived
//       facts purely by first_seen via the archive_time tier (parseDateRange + tier 2d).
//   (B) WITHOUT a time window — a topical, date-free query reaches the same archived facts
//       via the concept drill-down (detail_of) / vector (archive_vec) tiers, and the
//       time tier correctly stays silent.
// Builds a tiny store shaped like a post-synthesis graph: 1 gist concept (in vec_nodes)
// + 4 demoted members (notes='archive', in vec_archive, linked by detail_of), dated across
// 2026-06-25..29, then runs recall.js twice and asserts the reachability of each path.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "archrecall-test-"));
process.env.AGENT_MEMORY_DIR = dataDir;

function runRecall(query, asOf) {
  const args = [
    path.join(__dirname, "..", "src", "recall.js"),
    "--query", query, "--k", "12",
  ];
  if (asOf) args.push("--as-of", asOf);
  const out = execFileSync(process.execPath, args, { env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8" });
  return JSON.parse(out);
}

(async () => {
  const Database = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const { ensureSchema } = require("../src/schema");
  const { embedOne, toVecBlob } = require("../src/embed");

  const dbPath = path.join(dataDir, "memory.db");
  const db = new Database(dbPath);
  sqliteVec.load(db);
  ensureSchema(db);

  const insNode = db.prepare("INSERT INTO nodes (signature, class, strength, first_seen, fact, kind, notes) VALUES (?,?,?,?,?,'fact',?)");
  const insVecN = db.prepare("INSERT INTO vec_nodes (rowid, embedding) VALUES (?, ?)");
  const insVecA = db.prepare("INSERT INTO vec_archive (rowid, embedding) VALUES (?, ?)");
  const insDetail = db.prepare("INSERT INTO detail_of (detail_sig, gist_sig, first_seen) VALUES (?,?,?)");

  // Gist concept — lives in vec_nodes (active), retrievable by topical query.
  const conceptSig = "fact:recurring-ppvnet-container-dns";
  const conceptFact = "Recurring PPVNET container DNS Sev4 incidents across ppvnet regions (generalized pattern).";
  const cInfo = insNode.run(conceptSig, "semantic", 0.8, "2026-06-30", conceptFact, "gist");
  insVecN.run(BigInt(cInfo.lastInsertRowid), toVecBlob(await embedOne(conceptFact)));

  // Demoted members — notes='archive', vectors in vec_archive (NOT vec_nodes), detail_of lineage.
  // m5 sits OUTSIDE the "late June" window (May) to prove the time tier bounds its window.
  const members = [
    { sig: "fact:ppvnet-m1", fact: "PPVNET Sev4 DNS incident 111 active in ppvnet-eastus.", first_seen: "2026-06-25" },
    { sig: "fact:ppvnet-m2", fact: "PPVNET container DNS incident 222 auto-mitigated in ppvnet-northeurope.", first_seen: "2026-06-26" },
    { sig: "fact:ppvnet-m3", fact: "PPVNET Sev4 DNS incident 333 burst in ppvnet-westus.", first_seen: "2026-06-26" },
    { sig: "fact:ppvnet-m4", fact: "PPVNET container DNS incident 444 recurring in ppvnet-eastus2.", first_seen: "2026-06-29" },
    { sig: "fact:ppvnet-m5", fact: "PPVNET Sev4 DNS incident 555 earlier wave in ppvnet-uksouth.", first_seen: "2026-05-10" },
  ];
  for (const m of members) {
    const info = insNode.run(m.sig, "semantic", 0.4, m.first_seen, m.fact, "archive");
    insVecA.run(BigInt(info.lastInsertRowid), toVecBlob(await embedOne(m.fact)));
    insDetail.run(m.sig, conceptSig, m.first_seen);
  }
  db.close();

  let ok = true;
  const fail = (msg) => { console.error("FAIL:", msg); ok = false; };

  // ---- (A) WITH time window: NL-date query ("late June") that does NOT literally match the
  // ISO first_seen (so the keyword tier can't catch it) — only parseDateRange + tier 2d can. ----
  const a = runRecall("what happened in late June", "2026-06-30");
  const aTime = a.cluster.nodes.filter((n) => n.via === "archive_time");
  const aOn26 = aTime.filter((n) => (n.first_seen || "").startsWith("2026-06-26"));
  const inWindow = (d) => d >= "2026-06-21" && d <= "2026-06-30";
  console.log(`(A) NL-date query -> archive_time rows: ${aTime.length} [${aTime.map((n) => n.id + "@" + n.first_seen).join(", ")}]`);
  if (aTime.length === 0) fail("(A) time-window tier returned nothing for an NL-date query");
  if (aOn26.length === 0) fail("(A) no archived fact dated 2026-06-26 was recalled by the time tier");
  if (aTime.some((n) => !inWindow((n.first_seen || "").slice(0, 10)))) fail("(A) time tier returned a fact OUTSIDE the late-June window");
  if (aTime.some((n) => n.id === "fact:ppvnet-m5")) fail("(A) out-of-window May fact (m5) leaked into the time tier");

  // ---- (B) WITHOUT time window: topical query, no date ----
  const b = runRecall("PPVNET container DNS incidents");
  const bArchived = b.cluster.nodes.filter((n) => n.tier === "archive" || n.tier === "archive_detail");
  const bTime = b.cluster.nodes.filter((n) => n.via === "archive_time");
  const bVias = [...new Set(bArchived.map((n) => n.via || "keyword"))];
  console.log(`(B) topical query -> archived rows: ${bArchived.length} via [${bVias.join(",")}], archive_time rows: ${bTime.length}`);
  if (bArchived.length === 0) fail("(B) no archived member reached by detail_of/archive_vec/keyword on a topical query");
  if (bTime.length !== 0) fail("(B) time tier fired on a query with NO date (parseDateRange should be null)");

  console.log(ok ? "\nPASS \u2713 bookshelf recalled both with and without a time window" : "\nFAILED \u2717");
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* leave tmp */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} process.exit(1); });
