"use strict";

// Existing stores can contain duplicate edges from the era before edge identity
// was constrained. Schema migration must deduplicate once and then make
// INSERT OR IGNORE enforce the intended invariant.

const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-schema-integrity-"));
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const { ensureSchema } = require("../src/schema");

const db = new Database(path.join(dataDir, "memory.db"));
sqliteVec.load(db);
ensureSchema(db);

db.exec("DROP INDEX idx_edges_unique");
const ins = db.prepare("INSERT INTO edges(src,rel,dst,weight) VALUES ('fact:a','related_to','fact:b',?)");
ins.run(0.4);
ins.run(0.8);
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 2) throw new Error("duplicate fixture was not created");

ensureSchema(db);
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 1) throw new Error("migration did not deduplicate edges");

db.prepare("INSERT OR IGNORE INTO edges(src,rel,dst,weight) VALUES ('fact:a','related_to','fact:b',0.9)").run();
if (db.prepare("SELECT count(*) c FROM edges").get().c !== 1) throw new Error("edge unique index does not enforce INSERT OR IGNORE");

// A legacy duplicate memory_id must not make migration destructive, but once
// migrated the schema must reject every new duplicate assignment.
db.exec("DROP TRIGGER trg_nodes_memory_id_insert_unique; DROP TRIGGER trg_nodes_memory_id_update_unique");
const insNode = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class) VALUES (?,?, 'fact','episodic')");
insNode.run("fact:legacy-a", "legacy-duplicate");
insNode.run("fact:legacy-b", "legacy-duplicate");
ensureSchema(db);
if (db.prepare("SELECT count(*) c FROM nodes WHERE memory_id='legacy-duplicate'").get().c !== 2) {
  throw new Error("migration rewrote legacy duplicate memory IDs");
}
try {
  insNode.run("fact:new-duplicate", "legacy-duplicate");
  throw new Error("duplicate memory_id insert was accepted");
} catch (e) {
  if (!String(e.message).includes("duplicate non-empty memory_id")) throw e;
}
insNode.run("fact:unique", "unique-id");
try {
  db.prepare("UPDATE nodes SET memory_id='legacy-duplicate' WHERE signature='fact:unique'").run();
  throw new Error("duplicate memory_id update was accepted");
} catch (e) {
  if (!String(e.message).includes("duplicate non-empty memory_id")) throw e;
}

// Provenance/recurrence migration is idempotent: verbatim facts gain a source
// day, gists remain timeless, and legacy pairwise evidence is discarded.
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,first_seen,notes,fact) VALUES ('fact:legacy-detail','','fact','episodic','2026-01-07T10:00:00Z','detail','detail')").run();
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,first_seen,notes,fact) VALUES ('fact:legacy-gist','','fact','semantic','2026-01-01T00:00:00Z','gist','gist')").run();
db.exec(`
  DELETE FROM meta WHERE key IN ('source_day_migrated_v1','reactivation_aggregates_v1');
  CREATE TABLE reactivation_events(
    new_sig TEXT, old_sig TEXT, hub_sig TEXT, run_id TEXT,
    observed_seq INTEGER, observed_at TEXT, qualifies INTEGER
  );
`);
ensureSchema(db);
ensureSchema(db);
const migratedDetail = db.prepare("SELECT source_day FROM nodes WHERE signature='fact:legacy-detail'").get();
const migratedGist = db.prepare("SELECT source_day FROM nodes WHERE signature='fact:legacy-gist'").get();
if (migratedDetail.source_day !== "2026-01-07" || migratedGist.source_day !== null) {
  throw new Error("source-day migration violated gist/detail provenance");
}
if (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='reactivation_events'").get().c !== 0) {
  throw new Error("legacy pairwise reactivation table survived migration");
}

// Temporal schema is idempotent and copies active chronology into a durable
// relation that survives semantic-edge cleanup.
db.prepare("INSERT OR IGNORE INTO edges(src,rel,dst,weight,first_seen,last_reinforced) VALUES ('fact:legacy-detail','sequence','fact:legacy-gist',0.8,'2026-01-07','2026-01-08')").run();
ensureSchema(db);
ensureSchema(db);
const transition = db.prepare("SELECT rel,first_seen,last_reinforced FROM evidence_transitions WHERE src_sig='fact:legacy-detail' AND dst_sig='fact:legacy-gist'").get();
if (!transition || transition.rel !== "sequence" || transition.first_seen !== "2026-01-07") {
  throw new Error("temporal transition migration did not preserve sequence evidence");
}
for (const table of [
  "chronicles",
  "chronicle_entries",
  "chronicle_entry_entities",
  "chronicle_evidence",
  "gist_landmarks",
  "evidence_transitions",
  "vec_chronicles",
  "vec_chronicles_archive",
]) {
  if (db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name=?").get(table).c !== 1) {
    throw new Error(`missing temporal table ${table}`);
  }
}

db.prepare("INSERT INTO nodes(signature,memory_id,kind,class) VALUES ('chronicle:guard','','chronicle','semantic')").run();
db.prepare(`
  INSERT INTO chronicles(node_sig,resolution,period_start,period_end,version,created_at)
  VALUES ('chronicle:guard','day','2026-01-07','2026-01-07',1,'2026-01-07')
`).run();
db.prepare(`
  INSERT INTO chronicle_entries(chronicle_sig,ordinal,slot_label,summary,change_kind)
  VALUES ('chronicle:guard',0,'2026-01-07','Guard fixture','continuity')
`).run();
try {
  db.prepare("INSERT INTO chronicle_entry_entities(chronicle_sig,entry_ordinal,entity_sig) VALUES ('chronicle:guard',0,'person:missing')").run();
  throw new Error("dangling chronicle entity facet was accepted");
} catch (e) {
  if (!String(e.message).includes("live entry and entity")) throw e;
}
try {
  db.prepare("INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig) VALUES ('chronicle:guard',0,'fact:missing')").run();
  throw new Error("dangling chronicle evidence was accepted");
} catch (e) {
  if (!String(e.message).includes("live entry and evidence")) throw e;
}
db.prepare("INSERT INTO nodes(signature,memory_id,kind,class) VALUES ('person:guard','','entity','semantic')").run();
db.prepare("INSERT INTO chronicle_entry_entities(chronicle_sig,entry_ordinal,entity_sig) VALUES ('chronicle:guard',0,'person:guard')").run();
try {
  db.prepare("DELETE FROM nodes WHERE signature='person:guard'").run();
  throw new Error("referenced chronicle entity was deleted");
} catch (e) {
  if (!String(e.message).includes("referenced by chronicle facets")) throw e;
}
db.prepare("INSERT INTO chronicle_evidence(chronicle_sig,entry_ordinal,evidence_sig) VALUES ('chronicle:guard',0,'fact:legacy-detail')").run();
try {
  db.prepare("DELETE FROM nodes WHERE signature='fact:legacy-detail'").run();
  throw new Error("referenced chronicle evidence was deleted");
} catch (e) {
  if (!String(e.message).includes("referenced by chronicles")) throw e;
}

console.log("PASS \u2713 schema constrains graph edges and future memory identity");
db.close();
fs.rmSync(dataDir, { recursive: true, force: true });
