"use strict";

// The dream JUDGMENT layer: the LLM stages a small/cheap model performs during a
// nightly dream. Each function is a pure transform — it takes engine state, asks the
// model for a JUDGMENT (types, aliases, merges, importance), and returns a structured
// decision. dream.js APPLIES the decisions to the db. The model never invents facts;
// it only reasons over content the engine already holds. Every function degrades
// gracefully: if the LLM is unavailable or returns garbage, it returns an empty
// decision and the engine keeps its mechanical behavior.

// ---- 1. ENTITY EXTRACTION + TYPING -----------------------------------------
// Replaces the regex's "First Last -> person" guess with a real reader that finds
// the SUBJECTS of each fact and types them (person/org/place/project/system/topic).
// Catches single-name principals ("Jamie") and multi-word names the regex misses,
// and types orgs/places correctly instead of mislabeling them person.
async function extractEntitiesLLM(facts, llm, opts = {}) {
  if (!llm || !llm.available || !facts.length) return [];
  const batch = Math.max(1, opts.batch || 40);
  const out = new Map(); // sig -> {sig,type,forms:Set}
  const TYPES = ["person", "org", "team", "place", "project", "system", "topic"];
  const sys = "You extract the named ENTITIES that recur as subjects of personal-memory facts. "
    + "For each fact, list only concrete named entities (people, orgs, teams, places, projects, systems, recurring topics). "
    + "Use the entity's canonical full name when the text makes it unambiguous (resolve a bare first name to the full name if another fact gives it). "
    + "Do NOT extract dates, numbers, generic nouns, or one-off descriptive phrases. "
    + `Types: ${TYPES.join(", ")}. Respond with JSON only: an array of {"name": string, "type": string}.`;
  for (let i = 0; i < facts.length; i += batch) {
    const chunk = facts.slice(i, i + batch);
    const user = "Facts:\n" + chunk.map((f, k) => `${k + 1}. ${f}`).join("\n")
      + '\n\nReturn the deduplicated entity list as JSON: [{"name":"...","type":"..."}]';
    let arr;
    try { arr = await llm.json(sys, user, { maxTokens: 2000 }); } catch { arr = null; }
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (!e || typeof e.name !== "string") continue;
      const name = e.name.trim();
      if (name.length < 2 || name.length > 60) continue;
      let type = String(e.type || "topic").toLowerCase().trim();
      if (!TYPES.includes(type)) type = "topic";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/\s+/g, "-").slice(0, 48);
      if (!slug) continue;
      const sig = `${type}:${slug}`;
      if (!out.has(sig)) out.set(sig, { sig, type, forms: new Set() });
      const norm = name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      out.get(sig).forms.add(norm);
      // also index individual long tokens (first/last name) as surface forms
      for (const tok of norm.split(" ")) if (tok.length >= 3) out.get(sig).forms.add(tok);
    }
  }
  return [...out.values()].map((e) => ({ sig: e.sig, type: e.type, forms: [...e.forms].filter((f) => f.length >= 3) }));
}

// ---- 2. CANONICALIZATION (alias merge) -------------------------------------
// Given the current entity-hub labels, group the ones that refer to the SAME entity
// (e.g. "Jamie" + "Jamie Chen", "SF" + "San Francisco", "the Condor project" +
// "Project Condor"). Returns groups so dream.js can fold aliases into one hub.
async function canonicalizeLLM(hubs, llm, opts = {}) {
  if (!llm || !llm.available || hubs.length < 2) return [];
  // hubs: [{sig, label}]
  const sys = "You are deduplicating a list of memory ENTITY labels. Group together the labels that refer to the SAME real-world entity "
    + "(a person known by first name and full name; an abbreviation and its expansion; minor spelling/case variants). "
    + "Be conservative: only group when you are confident they are the same entity. Distinct people who merely share a first or last name are NOT the same. "
    + 'Respond with JSON only: an array of groups, each {"canonical": "<the sig to keep>", "aliases": ["<other sigs to merge in>", ...]}. '
    + "Only include groups that actually merge (aliases non-empty). Use the exact sig strings provided.";
  const user = "Entity hubs (sig => label):\n"
    + hubs.map((h) => `${h.sig} => ${h.label}`).join("\n")
    + '\n\nReturn merge groups as JSON: [{"canonical":"...","aliases":["..."]}]';
  let arr;
  try { arr = await llm.json(sys, user, { maxTokens: 1500 }); } catch { arr = null; }
  if (!Array.isArray(arr)) return [];
  const valid = new Set(hubs.map((h) => h.sig));
  const groups = [];
  for (const g of arr) {
    if (!g || typeof g.canonical !== "string" || !Array.isArray(g.aliases)) continue;
    if (!valid.has(g.canonical)) continue;
    const aliases = g.aliases.filter((a) => typeof a === "string" && valid.has(a) && a !== g.canonical);
    if (aliases.length) groups.push({ canonical: g.canonical, aliases: [...new Set(aliases)] });
  }
  return groups;
}

// ---- 3. MERGE (semantic rollup of a near-duplicate cluster) -----------------
// The headline stage. Given clusters of near-duplicate / closely-related facts, the
// model decides which to roll up and WRITES the single consolidated fact that names
// every neighbor — fewer, richer entries instead of blind eviction. This is what
// lifts long-horizon cross-reference/synthesis recall under the hard entry cap.
// Clusters are BATCHED per call (fewer round-trips over a long nightly cadence).
async function mergeClustersLLM(clusters, llm, opts = {}) {
  if (!llm || !llm.available || !clusters.length) return [];
  const batch = Math.max(1, opts.batch || 6);
  const sys = "You are consolidating a personal long-term memory under a strict entry budget. "
    + "You are given several CLUSTERS of facts that look related. For EACH cluster, decide if its facts should be MERGED into one. "
    + "Merge ONLY facts about the same subject that are redundant, incremental, or a correction sequence — then write ONE consolidated fact that preserves every distinct, still-true detail and names all the specifics. "
    + "If a cluster mixes unrelated subjects, do NOT merge it. Prefer the LATEST value when facts conflict, but retain the prior value as historical context if it aids recall. "
    + 'Respond with JSON only: an array with one object per cluster, {"cluster": <1-based cluster number>, "merge": boolean, "fact": "<consolidated fact if merge>", "keep_strongest": <1-based member index whose identity to preserve>}.';
  const out = new Array(clusters.length).fill(null);
  for (let i = 0; i < clusters.length; i += batch) {
    const chunk = clusters.slice(i, i + batch);
    const user = chunk.map((cl, c) =>
      `Cluster ${c + 1}:\n` + cl.map((m, k) => `  ${k + 1}. ${m.fact || ""}`).join("\n")
    ).join("\n\n") + '\n\nReturn JSON: [{"cluster":N,"merge":true|false,"fact":"...","keep_strongest":M}]';
    let arr;
    try { arr = await llm.json(sys, user, { maxTokens: 2500 }); } catch { arr = null; }
    if (!Array.isArray(arr)) continue;
    for (const dec of arr) {
      const cNum = Number(dec && dec.cluster);
      if (!Number.isInteger(cNum) || cNum < 1 || cNum > chunk.length) continue;
      const cl = chunk[cNum - 1];
      if (!dec || dec.merge !== true || typeof dec.fact !== "string" || dec.fact.trim().length < 8) continue;
      let keepIdx = Number(dec.keep_strongest);
      if (!Number.isFinite(keepIdx) || keepIdx < 1 || keepIdx > cl.length) keepIdx = 1;
      out[i + cNum - 1] = { fact: dec.fact.trim(), survivorSig: cl[keepIdx - 1].sig, memberSigs: cl.map((m) => m.sig) };
    }
  }
  return out;
}

// ---- 4. SALIENCE (importance judgment) -------------------------------------
// Frequency builds durability, not importance. The model SCORES each fact 0-2 and
// only the rare critical (2) facts are tagged salient — so they survive cap-eviction
// and decay slowly, independent of recurrence. Selectivity is the point: if most
// facts were "important", the protection would be meaningless. An optional cap
// (opts.maxFraction, default 0.2) hard-limits the flagged share as a backstop against
// an over-eager model.
async function salienceLLM(facts, llm, opts = {}) {
  if (!llm || !llm.available || !facts.length) return new Set();
  const batch = Math.max(1, opts.batch || 50);
  const maxFraction = opts.maxFraction == null ? 0.2 : opts.maxFraction;
  const scored = []; // {sig, score}
  const sys = "You score how CRITICAL each personal-memory fact is to preserve long-term, on a 0-2 scale. "
    + "2 = critical: a firm decision/commitment, a security or serious incident, an executive/leadership or org-structure fact, a person's core identity/role, or a hard deadline whose loss would clearly damage future recall. "
    + "1 = useful but recoverable context. 0 = routine logistics, transient status, or small talk. "
    + "Be strict: in a normal stream only a small minority are 2. "
    + 'Respond with JSON only: an array of {"i": <1-based index>, "s": <0|1|2>} for facts you score 1 or 2 (omit 0s).';
  for (let i = 0; i < facts.length; i += batch) {
    const chunk = facts.slice(i, i + batch);
    const user = "Facts:\n" + chunk.map((f, k) => `${k + 1}. ${f.fact || ""}`).join("\n")
      + '\n\nReturn JSON: [{"i":N,"s":0|1|2}] (only the 1s and 2s).';
    let arr;
    try { arr = await llm.json(sys, user, { maxTokens: 900 }); } catch { arr = null; }
    if (!Array.isArray(arr)) continue;
    for (const o of arr) {
      const k = Number(o && o.i), s = Number(o && o.s);
      if (Number.isInteger(k) && k >= 1 && k <= chunk.length && s >= 2) scored.push({ sig: chunk[k - 1].sig, score: s });
    }
  }
  // backstop: never tag more than maxFraction of the corpus salient (keep highest scores)
  const cap = Math.max(1, Math.floor(facts.length * maxFraction));
  scored.sort((a, b) => b.score - a.score);
  return new Set(scored.slice(0, cap).map((x) => x.sig));
}

// ---- 5. SYNTHESIS (generalize a dormant recurrence family into a concept) ----
// Given dormant candidate POOLS of distinct-but-recurring facts (e.g. many "PPVNET Sev4 DNS
// incident <id>" events), partition each pool into sub-themes and, for each genuine recurrence
// FAMILY, WRITE ONE higher-level CONCEPT that captures the pattern/count/span/outcome. dream.js
// then demotes the instances to the cold bookshelf UNDER the concept (retained, not deleted).
// The model must REFUSE to generalize a coincidental mix (unrelated subjects that only co-occur
// in time): those members are simply left out of every group (kept active). It never invents
// members — every memberSig must come from the pool. Validated offline (RQ2) with gpt-5.4-mini,
// which correctly subdivided a mixed PPVNET pool and held a DNS+SLA-mixed item separate.
async function synthesizeClustersLLM(pools, llm, opts = {}) {
  if (!llm || !llm.available || !pools.length) return [];
  const sys = "You are the SYNTHESIS stage of a human-like memory system's nightly dream. "
    + "You are given POOLS of dormant, low-importance facts a mechanical pass found mutually similar. "
    + "Many pools are RECURRENCE FAMILIES: distinct events that are really instances of ONE recurring phenomenon "
    + "(e.g. many separate 'Sev4 DNS incident <id>' events on the same system). For each genuine family, write ONE "
    + "general CONCEPT fact capturing the PATTERN, the COUNT/scale, the TIME SPAN, and the typical OUTCOME, naming the "
    + "recurring subject — but NOT the individual ids/timestamps (those stay archived as detail). "
    + "Partition a pool into MULTIPLE groups when it mixes sub-themes (e.g. DNS incidents vs SLA drops). "
    + "Keep a member OUT of every group when it is distinctive or mixes several themes. "
    + "REFUSE to generalize coincidental members (unrelated subjects that only share timing) — leave them out. "
    + "A concept requires at least TWO instances. Never invent facts or member ids; every memberSig MUST be a provided sig. "
    + 'Respond with JSON only: an array with one object per pool: '
    + '{"poolId":"...","groups":[{"concept":"<general fact>","memberSigs":["...",...],"span":"<e.g. June 24-29 2026>","scale":"<e.g. ~10 incidents>"}]}.';
  const out = [];
  for (const p of pools) {
    const user = `Pool ${p.poolId} (${p.members.length} dormant members):\n`
      + p.members.map((m) => `  ${m.sig}  [${m.firstSeen ? String(m.firstSeen).slice(0, 10) : "?"}]  ${m.fact}`).join("\n")
      + (p.hotSiblings && p.hotSiblings.length
          ? "\n\nReinforced siblings (context only — DO NOT demote these; a concept MAY reference them):\n"
            + p.hotSiblings.map((h) => `  ${h.sig}  ${h.fact}`).join("\n")
          : "")
      + `\n\nReturn JSON for this pool: {"poolId":"${p.poolId}","groups":[{"concept":"...","memberSigs":["..."],"span":"...","scale":"..."}]}`;
    let obj;
    try { obj = await llm.json(sys, user, { maxTokens: 1500 }); } catch { obj = null; }
    if (Array.isArray(obj)) obj = obj.find((x) => x && x.poolId === p.poolId) || obj[0];
    if (!obj || typeof obj !== "object") continue;
    const valid = new Set(p.members.map((m) => m.sig));
    const claimed = new Set();
    const groups = [];
    for (const g of (Array.isArray(obj.groups) ? obj.groups : [])) {
      if (!g || typeof g.concept !== "string" || g.concept.trim().length < 12 || !Array.isArray(g.memberSigs)) continue;
      // valid pool sig, dedup, and not already claimed by an earlier group (no double-demotion)
      const memberSigs = [...new Set(g.memberSigs.filter((s) => valid.has(s) && !claimed.has(s)))];
      if (memberSigs.length < 2) continue;
      memberSigs.forEach((s) => claimed.add(s));
      groups.push({ concept: g.concept.trim(), memberSigs, span: typeof g.span === "string" ? g.span.trim() : "", scale: typeof g.scale === "string" ? g.scale.trim() : "" });
    }
    if (groups.length) out.push({ poolId: p.poolId, groups });
  }
  return out;
}

module.exports = { extractEntitiesLLM, canonicalizeLLM, mergeClustersLLM, salienceLLM, synthesizeClustersLLM };
