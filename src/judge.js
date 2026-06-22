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
async function mergeClustersLLM(clusters, llm, opts = {}) {
  if (!llm || !llm.available || !clusters.length) return [];
  const sys = "You are consolidating a personal long-term memory under a strict entry budget. "
    + "Each input cluster is a set of memory facts that look related. For each cluster, decide if they should be MERGED into one. "
    + "Merge ONLY facts that are about the same subject and are redundant, incremental, or a correction sequence — then write ONE consolidated fact that preserves every distinct, still-true detail and names all the specifics. "
    + "If a cluster mixes unrelated subjects, do NOT merge it. Prefer keeping the LATEST value when facts conflict, but retain the prior value as historical context if it aids recall. "
    + 'Respond with JSON only: an array aligned to the input, each {"merge": boolean, "fact": "<consolidated fact if merge>", "keep_strongest": <1-based index of the member whose identity/id to preserve>}.';
  const out = [];
  // one call per cluster keeps prompts small and decisions clean for a mini model
  for (const cl of clusters) {
    const members = cl.map((m) => m.fact || "");
    const user = "Cluster members:\n" + members.map((m, k) => `${k + 1}. ${m}`).join("\n")
      + '\n\nReturn JSON: {"merge":true|false,"fact":"...","keep_strongest":N}';
    let dec;
    try { dec = await llm.json(sys, user, { maxTokens: 1200 }); } catch { dec = null; }
    if (!dec || dec.merge !== true || typeof dec.fact !== "string" || dec.fact.trim().length < 8) { out.push(null); continue; }
    let keepIdx = Number(dec.keep_strongest);
    if (!Number.isFinite(keepIdx) || keepIdx < 1 || keepIdx > cl.length) keepIdx = 1;
    out.push({ fact: dec.fact.trim(), survivorSig: cl[keepIdx - 1].sig, memberSigs: cl.map((m) => m.sig) });
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

module.exports = { extractEntitiesLLM, canonicalizeLLM, mergeClustersLLM, salienceLLM };
