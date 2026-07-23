"use strict";

/**
 * Derived-memory contract:
 * 1. A derived memory is not authoritative for exact dates, numbers, sequence, or attribution.
 * 2. Every derived memory must carry at least one evidence reference; doctor flags violations.
 * 3. Strong retrieval must reserve bounded authoritative evidence through this shared routine.
 * 4. Every projection labels the derived memory as an index over evidence.
 * 5. Lifecycle and deletion logic must preserve evidence referenced by derived memories.
 * 6. Semantic and temporal derived memories may not starve each other's reserved evidence.
 */

const { ageDays, ageTag } = require("./timeline");

function fromVecBlob(buf) {
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

function dot(a, b) {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) total += a[i] * b[i];
  return total;
}

function envPositiveInt(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function loadSupersededBy(db, signatures) {
  const sigs = [...new Set(signatures)].filter(Boolean);
  const out = new Map();
  if (!sigs.length) return out;
  const json = JSON.stringify(sigs);
  const rows = db.prepare(`
    SELECT src, dst, first_seen FROM (
      SELECT src, dst, first_seen FROM edges WHERE rel='supersedes'
      UNION
      SELECT src_sig src, dst_sig dst, first_seen
      FROM evidence_transitions WHERE rel='supersedes'
    )
    WHERE src IN (SELECT value FROM json_each(?))
       OR dst IN (SELECT value FROM json_each(?))
  `).all(json, json);
  for (const edge of rows) {
    const previous = out.get(edge.dst);
    const timestamp = Date.parse(edge.first_seen || "") || 0;
    if (!previous || timestamp >= previous.t) out.set(edge.dst, { survivor: edge.src, t: timestamp });
  }
  return out;
}

function loadSemanticEvidence(db, sig) {
  const landmarks = db.prepare(`
    SELECT n.id,n.signature,n.fact,n.kind,n.class,n.strength,n.first_seen,n.source_day,n.notes,
           n.temporal_form,n.memory_family,l.role,l.ordinal
    FROM gist_landmarks l
    JOIN nodes n ON n.signature=l.evidence_sig
    WHERE l.gist_sig=? AND n.kind='fact'
    ORDER BY CASE l.role WHEN 'change' THEN 0 WHEN 'current' THEN 1 ELSE 2 END,l.ordinal
  `).all(sig);
  if (landmarks.length) {
    const roleScore = { change: 3, current: 2, before: 1 };
    return landmarks.map((row) => ({
      sig: row.signature,
      role: row.role,
      node: row,
      axisScore: (roleScore[row.role] || 0) - (Number(row.ordinal) || 0) * 0.001,
      depth: 0,
    }));
  }
  return db.prepare(`
    SELECT n.id,n.signature,n.fact,n.kind,n.class,n.strength,n.first_seen,n.source_day,n.notes,
           n.temporal_form,n.memory_family
    FROM detail_of d
    JOIN nodes n ON n.signature=d.detail_sig
    WHERE d.gist_sig=? AND n.kind='fact'
    ORDER BY coalesce(n.source_day,substr(n.first_seen,1,10)) DESC,n.signature
  `).all(sig).map((row, index) => ({
    sig: row.signature,
    role: "detail",
    node: row,
    axisScore: -index * 0.001,
    depth: 0,
  }));
}

function temporalEntries(db, sig) {
  const rows = db.prepare(`
    SELECT e.ordinal,e.slot_label,e.summary,e.change_kind,e.state_label,e.aspect,ce.evidence_sig
    FROM chronicle_entries e
    LEFT JOIN chronicle_evidence ce
      ON ce.chronicle_sig=e.chronicle_sig AND ce.entry_ordinal=e.ordinal
    WHERE e.chronicle_sig=?
    ORDER BY e.ordinal,ce.evidence_sig
  `).all(sig);
  const entries = [];
  for (const row of rows) {
    let entry = entries[entries.length - 1];
    if (!entry || entry.ordinal !== row.ordinal) {
      entry = { ...row, evidenceSigs: [] };
      delete entry.evidence_sig;
      entries.push(entry);
    }
    if (row.evidence_sig) entry.evidenceSigs.push(row.evidence_sig);
  }
  return entries;
}

function loadTemporalEvidence(db, sig, ctx) {
  const entries = temporalEntries(db, sig);
  if (!entries.length) return [];
  const { terms = [], dateRange, L, k = 12 } = ctx;
  const scored = entries.map((entry, index) => {
    const text = L.normalizeForMatch([
      entry.slot_label, entry.summary, entry.state_label, entry.aspect,
    ].filter(Boolean).join(" "));
    const lexical = terms.reduce((score, term) => {
      const normalized = L.normalizeForMatch(term);
      if (!normalized || !text.includes(normalized)) return score;
      return score + (term.includes("-") || term.includes(" ") ? 6 : (term.length >= 7 ? 1.5 : 1));
    }, 0);
    const slot = String(entry.slot_label || "");
    const inWindow = !!(dateRange && slot >= dateRange.lo && slot <= dateRange.hi);
    const endpoint = index === 0 || index === entries.length - 1;
    return {
      entry,
      index,
      score: (inWindow ? 10 : 0) + lexical,
      role: inWindow ? "in_window" : (endpoint ? "endpoint" : "entry"),
    };
  });
  const positive = scored.filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6);
  const endpoints = [scored[0], scored[scored.length - 1]].filter(Boolean);
  const chosen = [];
  for (const row of [...positive, ...endpoints]) {
    if (!chosen.some((candidate) => candidate.index === row.index)) chosen.push(row);
    if (chosen.length >= 6) break;
  }
  if (!chosen.length) {
    for (const row of [...scored.slice(0, 2), ...scored.slice(-2)]) {
      if (!chosen.some((candidate) => candidate.index === row.index)) chosen.push(row);
    }
  }

  const seeds = [];
  for (const row of chosen) {
    for (const evidenceSig of row.entry.evidenceSigs) {
      seeds.push({
        sig: evidenceSig,
        role: row.role,
        score: row.score,
        ordinal: row.entry.ordinal,
      });
    }
  }
  if (!seeds.length) seeds.push({ sig, role: "entry", score: 0, ordinal: 0 });

  const seedSql = seeds.map(() => "SELECT ? sig,0 depth,? role,? entry_score,? entry_ordinal").join(" UNION ALL ");
  const rows = db.prepare(`
    WITH RECURSIVE ev(sig,depth,role,entry_score,entry_ordinal) AS (
      ${seedSql}
      UNION ALL
      SELECT ce.evidence_sig,ev.depth+1,ev.role,ev.entry_score,ev.entry_ordinal
      FROM ev
      JOIN chronicle_evidence ce ON ce.chronicle_sig=ev.sig
      WHERE ev.depth<5
    )
    SELECT n.id,n.signature,n.fact,n.kind,n.class,n.strength,n.first_seen,n.source_day,n.notes,
           n.temporal_form,n.memory_family,ev.depth,ev.role,ev.entry_score,ev.entry_ordinal
    FROM ev
    JOIN nodes n ON n.signature=ev.sig
    WHERE n.kind='fact'
    LIMIT ?
  `).all(...seeds.flatMap((seed) => [seed.sig, seed.role, seed.score, seed.ordinal]), Math.max(200, k * 30));

  const roleScore = { in_window: 3, endpoint: 2, entry: 1 };
  const bySig = new Map();
  for (const row of rows) {
    const sourceDay = row.source_day || String(row.first_seen || "").slice(0, 10);
    const inWindow = !!(dateRange && sourceDay >= dateRange.lo && sourceDay <= dateRange.hi);
    const role = inWindow ? "in_window" : row.role;
    const axisScore = (roleScore[role] || 0)
      + Math.min(1, Math.max(0, Number(row.entry_score) || 0) * 0.05)
      - Math.max(0, Number(row.depth) || 0) * 0.02;
    const candidate = {
      sig: row.signature,
      role,
      node: row,
      axisScore,
      depth: Number(row.depth) || 0,
    };
    const previous = bySig.get(candidate.sig);
    if (!previous
      || candidate.axisScore > previous.axisScore
      || (candidate.axisScore === previous.axisScore && candidate.depth < previous.depth)) {
      bySig.set(candidate.sig, candidate);
    }
  }
  return [...bySig.values()].sort((a, b) =>
    b.axisScore - a.axisScore
    || a.depth - b.depth
    || String(b.node.source_day || b.node.first_seen || "").localeCompare(String(a.node.source_day || a.node.first_seen || ""))
    || a.sig.localeCompare(b.sig));
}

function describeDerived(db, node) {
  if (!node) return null;
  const sig = node.signature || node.id;
  if (!sig) return null;
  const activation = Number.isFinite(Number(node.activation))
    ? Number(node.activation)
    : Number(node.semantic_similarity || 0) + 0.2 * Number(node.strength || 0);
  if (node.kind === "chronicle") {
    return {
      axis: "temporal",
      sig,
      activation,
      loadEvidence: (ctx) => loadTemporalEvidence(db, sig, ctx),
    };
  }
  if (node.notes && /\bgist\b/.test(node.notes)) {
    return {
      axis: "semantic",
      sig,
      activation,
      loadEvidence: () => loadSemanticEvidence(db, sig),
    };
  }
  return null;
}

function selectParents(selectedDerived, parentCap, evidenceCap, minPerParent) {
  const bySig = new Map();
  for (const parent of selectedDerived.filter(Boolean)) {
    const previous = bySig.get(parent.sig);
    if (!previous || parent.activation > previous.activation) bySig.set(parent.sig, parent);
  }
  const ranked = [...bySig.values()].sort((a, b) =>
    b.activation - a.activation || a.axis.localeCompare(b.axis) || a.sig.localeCompare(b.sig));
  const capacityParentCap = Math.max(1, Math.floor(evidenceCap / minPerParent));
  const limit = Math.min(parentCap, capacityParentCap, ranked.length);
  const selected = ranked.slice(0, limit);
  if (limit > 1) {
    for (const axis of ["semantic", "temporal"]) {
      if (!ranked.some((parent) => parent.axis === axis) || selected.some((parent) => parent.axis === axis)) continue;
      const missing = ranked.find((parent) => parent.axis === axis);
      let replaceAt = selected.length - 1;
      for (let i = selected.length - 1; i >= 0; i -= 1) {
        const sameAxisCount = selected.filter((parent) => parent.axis === selected[i].axis).length;
        if (sameAxisCount > 1) { replaceAt = i; break; }
      }
      selected[replaceAt] = missing;
      selected.sort((a, b) => b.activation - a.activation || a.sig.localeCompare(b.sig));
    }
  }
  return selected;
}

function loadCosines(db, candidates, qFloat) {
  const ids = [...new Set(candidates.map((candidate) => Number(candidate.node.id)).filter(Number.isFinite))];
  const cosineById = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const vectors = [
      ...db.prepare(`SELECT rowid,embedding FROM vec_nodes WHERE rowid IN (${placeholders})`).all(...chunk),
      ...db.prepare(`SELECT rowid,embedding FROM vec_archive WHERE rowid IN (${placeholders})`).all(...chunk),
    ];
    for (const vector of vectors) {
      if (vector.embedding) cosineById.set(Number(vector.rowid), dot(qFloat, fromVecBlob(vector.embedding)));
    }
  }
  return cosineById;
}

function reserveDerivedEvidence(db, selectedDerived, ctx) {
  const k = Math.max(1, Number(ctx.k) || 12);
  const parentCap = envPositiveInt("MEMORY_DERIVED_PARENT_CAP", 6);
  const minPerParent = envPositiveInt("MEMORY_DERIVED_MIN_PER_PARENT", 1);
  const maxPerParent = Math.max(minPerParent, envPositiveInt("MEMORY_DERIVED_MAX_PER_PARENT", 4));
  const evidenceCap = envPositiveInt("MEMORY_DERIVED_EVIDENCE_CAP", Math.max(24, k * 2));
  const parents = selectParents(selectedDerived, parentCap, evidenceCap, minPerParent);
  if (!parents.length) return [];

  const candidatesByParent = new Map();
  const allCandidates = [];
  for (let parentRank = 0; parentRank < parents.length; parentRank += 1) {
    const parent = parents[parentRank];
    let loaded = [];
    try {
      loaded = parent.loadEvidence(ctx) || [];
    } catch (error) {
      if (process.env.MEMORY_DEBUG) console.error("derived evidence:", error);
    }
    const seen = new Set();
    const candidates = loaded
      .filter((candidate) => candidate && candidate.node && !seen.has(candidate.sig) && seen.add(candidate.sig))
      .map((candidate) => ({
        ...candidate,
        axis: parent.axis,
        parent: parent.sig,
        parentActivation: parent.activation,
        parentRank,
      }))
      .sort((a, b) =>
        b.axisScore - a.axisScore
        || a.depth - b.depth
        || String(b.node.source_day || b.node.first_seen || "").localeCompare(String(a.node.source_day || a.node.first_seen || ""))
        || a.sig.localeCompare(b.sig));
    candidatesByParent.set(parent.sig, candidates);
    allCandidates.push(...candidates);
  }

  const cosineById = loadCosines(db, allCandidates, ctx.qFloat);
  const supersededBy = loadSupersededBy(db, allCandidates.map((candidate) => candidate.sig));
  for (const candidate of allCandidates) {
    const cosine = cosineById.get(Number(candidate.node.id)) || 0;
    const sourceDay = candidate.node.source_day || String(candidate.node.first_seen || "").slice(0, 10) || null;
    const specificsBonus = ctx.specificsIntent
      && (ctx.L.extractHardSpecifics(candidate.node.fact || "").size || /\b\d{4}-\d{2}-\d{2}\b/.test(candidate.node.fact || ""))
      ? 0.08 : 0;
    candidate.semanticSimilarity = cosine;
    candidate.activation = candidate.parentActivation
      + 0.15 * cosine
      + 0.08 * candidate.axisScore
      + specificsBonus
      + (ctx.dateRange && sourceDay >= ctx.dateRange.lo && sourceDay <= ctx.dateRange.hi ? 0.08 : 0)
      - 0.02 * candidate.depth
      - 0.005 * candidate.parentRank;
  }

  const selected = [];
  const counts = new Map();
  const selectedKeys = new Set();
  const add = (candidate) => {
    if (!candidate || selected.length >= evidenceCap) return false;
    const count = counts.get(candidate.parent) || 0;
    if (count >= maxPerParent) return false;
    const key = `${candidate.parent}\u0000${candidate.sig}`;
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    counts.set(candidate.parent, count + 1);
    selected.push(candidate);
    return true;
  };

  for (let round = 0; round < minPerParent && selected.length < evidenceCap; round += 1) {
    for (const parent of parents) {
      add((candidatesByParent.get(parent.sig) || [])[round]);
      if (selected.length >= evidenceCap) break;
    }
  }
  for (const candidate of selected) candidate.guaranteed = true;
  const guaranteedKeys = new Set(selected.map((candidate) => `${candidate.parent}\u0000${candidate.sig}`));
  const remaining = allCandidates
    .filter((candidate) => !guaranteedKeys.has(`${candidate.parent}\u0000${candidate.sig}`))
    .sort((a, b) =>
      b.activation - a.activation
      || a.parentRank - b.parentRank
      || b.axisScore - a.axisScore
      || a.depth - b.depth
      || a.sig.localeCompare(b.sig));
  for (const candidate of remaining) {
    if (selected.length >= evidenceCap) break;
    add(candidate);
  }

  return selected.map((candidate) => {
    const row = candidate.node;
    const supersession = supersededBy.get(candidate.sig);
    const firstSeen = row.first_seen || null;
    const sourceDay = row.source_day || String(firstSeen || "").slice(0, 10) || null;
    const age = ageDays(firstSeen, ctx.nowRef);
    const hit = {
      id: candidate.sig,
      kind: "fact",
      class: row.class,
      tier: row.notes === "archive" ? "archive" : (row.notes === "detail" ? "detail" : "episodic"),
      fact: (row.fact || "").trim(),
      raw_fact: row.fact,
      first_seen: firstSeen,
      source_day: sourceDay,
      age_days: age,
      age: ageTag(age),
      superseded: !!supersession,
      superseded_by: supersession ? supersession.survivor : null,
      temporal_form: row.temporal_form || "atemporal",
      memory_family: row.memory_family || row.signature,
      via: "derived_evidence",
      axis: candidate.axis,
      parent: candidate.parent,
      role: candidate.role,
      hops: candidate.depth,
      strength: Number((row.strength || 0).toFixed(4)),
      semantic_similarity: Number(candidate.semanticSimilarity.toFixed(4)),
      activation: Number(candidate.activation.toFixed(4)),
    };
    Object.defineProperty(hit, "_derivedGuaranteed", {
      value: !!candidate.guaranteed,
      enumerable: false,
    });
    return hit;
  });
}

module.exports = {
  describeDerived,
  loadSupersededBy,
  reserveDerivedEvidence,
};
