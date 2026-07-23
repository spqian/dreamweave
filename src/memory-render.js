"use strict";

const FORM_LABEL = {
  atemporal: "STABLE",
  trajectory: "EVOLVING",
  recurring: "RECURRING",
  "period-bound": "PERIOD-BOUND",
};
const DERIVED_INDEX_NOTICE =
  "Index over evidence — not an authoritative source. Expand returned details and verify exact dates, numbers, attribution, and sequence.";

function gistMetadata(db, sig) {
  const row = db.prepare(`
    SELECT n.temporal_form,n.memory_family,
           min(dn.source_day) evidence_start,
           max(dn.source_day) evidence_end,
           count(dn.signature) detail_count
    FROM nodes n
    LEFT JOIN detail_of d ON d.gist_sig=n.signature
    LEFT JOIN nodes dn ON dn.signature=d.detail_sig
    WHERE n.signature=?
    GROUP BY n.signature
  `).get(sig) || {};
  const landmarks = db.prepare(`
    SELECT gl.role,gl.ordinal,gl.evidence_sig,n.source_day,n.fact
    FROM gist_landmarks gl
    JOIN nodes n ON n.signature=gl.evidence_sig
    WHERE gl.gist_sig=?
    ORDER BY CASE gl.role WHEN 'before' THEN 0 WHEN 'change' THEN 1 ELSE 2 END,gl.ordinal
  `).all(sig);
  const companion = db.prepare(`
    SELECT c.node_sig,c.resolution,c.period_start,c.period_end,count(*) overlap_count
    FROM detail_of d
    JOIN chronicle_evidence ce ON ce.evidence_sig=d.detail_sig
    JOIN chronicles c ON c.node_sig=ce.chronicle_sig
    JOIN nodes n ON n.signature=c.node_sig AND coalesce(n.notes,'')<>'archive'
    WHERE d.gist_sig=?
    GROUP BY c.node_sig
    ORDER BY overlap_count DESC,
      CASE c.resolution WHEN 'week' THEN 0 WHEN 'day' THEN 1 WHEN 'month' THEN 2 WHEN 'quarter' THEN 3 ELSE 4 END,
      c.period_end DESC
    LIMIT 1
  `).get(sig) || null;
  return {
    temporalForm: row.temporal_form || "atemporal",
    memoryFamily: row.memory_family || sig,
    evidenceStart: row.evidence_start || null,
    evidenceEnd: row.evidence_end || null,
    detailCount: Number(row.detail_count) || 0,
    landmarks,
    companion,
  };
}

function transitionSketch(landmarks) {
  const labels = [];
  for (const lm of landmarks) {
    const text = String(lm.fact || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const state = text.length > 96 ? `${text.slice(0, 93)}...` : text;
    labels.push(`${lm.source_day || lm.role}: ${state}`);
  }
  return labels;
}

function renderSemanticEnvelope(db, node) {
  const meta = gistMetadata(db, node.signature);
  const form = meta.temporalForm;
  const lines = [
    `[SEMANTIC MEMORY · ${FORM_LABEL[form] || "STABLE"}]`,
    DERIVED_INDEX_NOTICE,
    `Memory family: ${meta.memoryFamily}`,
    "",
    String(node.fact || "").trim(),
  ];
  if (form !== "atemporal") {
    lines.push("", "Temporal shape:");
    if (form === "trajectory") lines.push("This subject changed through distinct states; do not treat them as simultaneous.");
    else if (form === "recurring") lines.push("This is a repeated pattern; individual occurrences remain separately dated.");
    else lines.push("This understanding is tied to a bounded period rather than being timeless.");
    const sketch = transitionSketch(meta.landmarks);
    if (sketch.length) lines.push(...sketch.map((s) => `- ${s}`));
    if (meta.companion) {
      lines.push("",
        `Available timeline: ${meta.companion.resolution} ${meta.companion.period_start}--${meta.companion.period_end}`,
        `Timeline memory: ${meta.companion.node_sig}`);
    } else if (meta.evidenceStart) {
      lines.push("", `Dated evidence: ${meta.evidenceStart}${meta.evidenceEnd && meta.evidenceEnd !== meta.evidenceStart ? `--${meta.evidenceEnd}` : ""}`);
    }
  }
  return lines.join("\n");
}

function chronicleMetadata(db, sig) {
  const chronicle = db.prepare("SELECT * FROM chronicles WHERE node_sig=?").get(sig);
  if (!chronicle) return null;
  const entries = db.prepare(`
    SELECT ordinal,slot_label,summary,change_kind,state_label,aspect
    FROM chronicle_entries WHERE chronicle_sig=? ORDER BY ordinal
  `).all(sig).map((entry) => ({
    ...entry,
    entitySigs: db.prepare(`
      SELECT entity_sig FROM chronicle_entry_entities
      WHERE chronicle_sig=? AND entry_ordinal=? ORDER BY entity_sig
    `).all(sig, entry.ordinal).map((r) => r.entity_sig),
    evidenceSigs: db.prepare(`
      SELECT evidence_sig FROM chronicle_evidence
      WHERE chronicle_sig=? AND entry_ordinal=? ORDER BY evidence_sig
    `).all(sig, entry.ordinal).map((r) => r.evidence_sig),
  }));
  return { ...chronicle, entries };
}

function renderChronicleEnvelope(db, node, opts = {}) {
  const meta = chronicleMetadata(db, node.signature);
  if (!meta) return String(node.fact || "").trim();
  const compact = (value, limit) => {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return limit && text.length > limit ? `${text.slice(0, Math.max(1, limit - 3)).trimEnd()}...` : text;
  };
  const maxEntries = Number.isFinite(opts.maxEntries) ? Math.max(1, Number(opts.maxEntries)) : null;
  let entries = meta.entries;
  let omitted = 0;
  if (maxEntries && entries.length > maxEntries) {
    const earlyCount = Math.min(2, Math.floor(maxEntries / 3));
    const lateCount = maxEntries - earlyCount;
    entries = [...entries.slice(0, earlyCount), ...entries.slice(-lateCount)];
    omitted = meta.entries.length - entries.length;
  }
  const lines = [
    `[TEMPORAL MEMORY · ${String(meta.resolution).toUpperCase()} · ${meta.period_start}--${meta.period_end}]`,
    DERIVED_INDEX_NOTICE,
    `Memory family: ${node.memory_family || `timeline:${meta.resolution}:${meta.period_start}`}`,
    "",
    compact(String(node.fact || "").split(/\r?\n/, 1)[0], opts.maxSummaryChars),
  ];
  for (const entry of entries) {
    const state = entry.state_label ? ` [${entry.state_label}]` : "";
    const aspect = entry.aspect ? ` (${entry.aspect})` : "";
    lines.push(`- ${entry.slot_label}${state}${aspect}: ${compact(entry.summary, opts.maxEntryChars)}`);
  }
  if (omitted) lines.push(`- ... ${omitted} intermediate ${omitted === 1 ? "entry" : "entries"} omitted from this projection`);
  lines.push("",
    `Evidence coverage: ${meta.covered_event_count} linked ${meta.covered_event_count === 1 ? "item" : "items"}`,
    `Compression level: ${meta.compression_level}`);
  return lines.join("\n");
}

function renderNodeEnvelope(db, node, opts = {}) {
  if (node.kind === "chronicle") return renderChronicleEnvelope(db, node, opts);
  if (node.notes && /\bgist\b/.test(node.notes)) return renderSemanticEnvelope(db, node);
  return String(node.fact || "").trim();
}

module.exports = {
  chronicleMetadata,
  gistMetadata,
  renderChronicleEnvelope,
  renderNodeEnvelope,
  renderSemanticEnvelope,
};
