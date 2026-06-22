"use strict";

// Entity layer for the dream weave. SELF-BOOTSTRAPPING: it learns the entity
// vocabulary from the data (recurrence + email bindings) with NO seed lists or
// domain denylists, so it works in any domain. extractEntitiesCorpus() is the
// primary path (frequency-gated); the per-fact extractEntities() is the building
// block. The vector layer (in dream.js) guarantees connectivity for anything missed.

const ENTITY_PREFIXES = [
  "person", "team", "org", "system", "topic", "incident", "release",
  "ref", "artifact", "decision", "thread", "project",
];

// A candidate "First Last" is promoted to a person hub only if it RECURS across
// multiple facts (see extractEntitiesCorpus) — real entities recur, one-off
// capitalized phrases don't. So there is NO domain denylist. The only filter here
// is a tiny GRAMMATICAL stoplist (function words that can't be a name), which is
// language-structural, not domain-specific.
const GRAMMATICAL = new Set([
  "the", "a", "an", "and", "or", "but", "with", "from", "for", "to", "of", "in",
  "on", "at", "by", "as", "is", "was", "were", "are", "be", "this", "that", "these",
  "those", "it", "its", "we", "our", "they", "their", "i", "my", "he", "she", "his", "her",
]);

const isLikelyName = (a, b) => {
  const x = a.toLowerCase(); const y = b.toLowerCase();
  if (GRAMMATICAL.has(x) || GRAMMATICAL.has(y)) return false;
  return a.length >= 2 && b.length >= 2;
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function labelOf(sig) {
  const i = sig.indexOf(":");
  return (i >= 0 ? sig.slice(i + 1) : sig).replace(/-/g, " ");
}

function typeOf(sig) {
  const i = sig.indexOf(":");
  return i >= 0 ? sig.slice(0, i) : "";
}

// Surface forms an entity can appear as in fact text.
function formsFor(sig) {
  const type = typeOf(sig);
  const label = normalize(labelOf(sig));
  const forms = new Set([label]);
  if (type === "person") {
    const parts = label.split(" ").filter(Boolean);
    if (parts.length >= 2) {
      forms.add(parts[0]);                          // first name
      forms.add(parts[parts.length - 1]);           // last name
    }
  }
  if (["incident", "msrc", "pr", "release"].includes(type)) {
    // numeric/id tokens
    const ids = label.match(/[0-9][0-9.]+/g) || [];
    ids.forEach((x) => forms.add(x));
  }
  // drop ultra-short/ambiguous forms
  return [...forms].filter((f) => f && f.length >= 3);
}

// Build the vocabulary from existing entity-kind nodes.
// entityRows: [{signature}]
function buildVocab(entityRows) {
  const vocab = [];
  for (const r of entityRows) {
    vocab.push({ sig: r.signature, type: typeOf(r.signature), forms: formsFor(r.signature) });
  }
  return vocab;
}

const slug = (s) => normalize(s).replace(/\s+/g, "-").slice(0, 48);

// Extract NEW entities from a fact's text that deserve their own hub.
// Returns [{sig, type, forms}]. Conservative for precision.
function extractEntities(fact) {
  const out = [];
  const text = fact || "";
  const addPerson = (a, b, extraForms = []) => {
    if (!isLikelyName(a, b)) return;
    const full = `${a} ${b}`;
    out.push({ sig: `person:${slug(full)}`, type: "person",
      forms: [...new Set([normalize(full), a.toLowerCase(), b.toLowerCase(), ...extraForms])].filter((f) => f.length >= 3) });
  };

  // Email-bound persons: "Name Name (xxx@microsoft.com)" -> strong person signal.
  let m;
  const emailRe = /([A-Z][a-z]+)\s+([A-Z][a-z]+)\s*\(([a-z0-9._-]+)@/g;
  while ((m = emailRe.exec(text))) addPerson(m[1], m[2], [m[3].toLowerCase()]);

  // Persons in subject-verb position: "Name Name <verb>".
  const verbs = "is|was|works|reports|submitted|contributes|sends|coordinates|confirmed|reported|drives|driving|leads|shared|requested|removed|posting|participating|acting|drove|coordinating|joining|joins|supporting|focus|focuses";
  const personVerbRe = new RegExp(`\\b([A-Z][a-z]+)\\s+([A-Z][a-z]+)\\s+(?:${verbs})\\b`, "g");
  while ((m = personVerbRe.exec(text))) addPerson(m[1], m[2]);

  // Collaborator / list patterns: capture name sequences after trigger words and split them.
  // e.g. "working with Alice Smith and Bob Jones", "involving Carol White and Dave Brown", "by A, B, and C".
  const trigger = "with|involving|by|between|from|join|welcome|owners?|reviewers?|cc|alongside|including|and";
  const nameSeqRe = new RegExp(`\\b(?:${trigger})\\s+((?:[A-Z][a-z]+\\s+[A-Z][a-z]+)(?:\\s*(?:,|and|,\\s*and)\\s*[A-Z][a-z]+\\s+[A-Z][a-z]+)*)`, "g");
  while ((m = nameSeqRe.exec(text))) {
    const seq = m[1];
    const names = seq.match(/[A-Z][a-z]+\s+[A-Z][a-z]+/g) || [];
    for (const nm of names) { const [a, b] = nm.split(/\s+/); addPerson(a, b); }
  }

  // Generic name list anywhere: 2+ consecutive "First Last" separated by comma/and
  // (catches parenthetical lists like "team (Alice Smith, Bob Jones, Carol White)").
  // isLikelyName() filters out product/org phrases (their tokens are in NON_NAME_WORDS).
  const listRe = /([A-Z][a-z]+\s+[A-Z][a-z]+)((?:\s*,\s*and\s+|\s*,\s*|\s+and\s+)[A-Z][a-z]+\s+[A-Z][a-z]+)+/g;
  while ((m = listRe.exec(text))) {
    const names = m[0].match(/[A-Z][a-z]+\s+[A-Z][a-z]+/g) || [];
    for (const nm of names) { const [a, b] = nm.split(/\s+/); addPerson(a, b); }
  }

  // Generic "Name Name and Name Name" co-occurrence (both are people).
  const pairRe = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\s+and\s+([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g;
  while ((m = pairRe.exec(text))) { addPerson(m[1], m[2]); addPerson(m[3], m[4]); }

  // IDs: only universal/structural patterns (no domain-specific ones). Hash-style ids
  // and issue refs like "#1234" recur and are safe; domain incident schemes are not baked in.
  const addId = (re, type) => {
    let mm; const r = new RegExp(re, "g");
    while ((mm = r.exec(text))) out.push({ sig: `${type}:${mm[1]}`.toLowerCase(), type, forms: [mm[1].toLowerCase()] });
  };
  addId("(?:issue|ticket|bug|pr)\\s*#?(\\d{2,})", "ref");
  addId("#(\\d{2,})", "ref");

  // dedup by sig
  const seen = new Map();
  for (const e of out) {
    if (!seen.has(e.sig)) seen.set(e.sig, e);
    else seen.get(e.sig).forms = [...new Set([...seen.get(e.sig).forms, ...e.forms])];
  }
  return [...seen.values()];
}

// SELF-BOOTSTRAPPING corpus extraction (no seed lists). Runs over ALL facts and
// promotes a candidate person to an entity hub only if it RECURS — appears in at
// least `minFacts` distinct facts — OR carries a strong single-occurrence signal
// (an email binding). This learns the entity vocabulary from the data itself, so it
// works in any domain with zero configuration. One-off capitalized phrases (a product
// name mentioned once, "Board Meeting", etc.) never become hubs; recurring subjects do.
//   facts: array of fact-text strings
//   opts.minFacts: recurrence threshold (default 2)
function extractEntitiesCorpus(facts, opts = {}) {
  const minFacts = Math.max(1, Number(opts.minFacts || process.env.MEMORY_ENTITY_MIN_FACTS || 2));
  const cand = new Map();    // sig -> { sig, type, forms:Set, facts:Set<idx> }
  const strong = new Set();  // sigs with an email binding (promote at count 1)

  // CASE-EVIDENCE (self-bootstrapping, no word lists): a token that the corpus also
  // writes in lowercase is an ordinary word ("current", "board", "project"), not a
  // name part — so capitalized-only-at-sentence-start false positives ("Current
  // Condor", "For Condor") are rejected without any hand-curated denylist. We learn
  // this purely from the corpus's own casing.
  const lower = new Map(), upper = new Map();
  for (const fact of facts) {
    const text = fact || "";
    for (const w of text.match(/[A-Za-z][a-z]{2,}/g) || []) {
      const k = w.toLowerCase();
      if (w[0] === w[0].toUpperCase()) upper.set(k, (upper.get(k) || 0) + 1);
      else lower.set(k, (lower.get(k) || 0) + 1);
    }
  }
  // A token is a "common word" (disqualified as a name part) if it appears lowercase
  // at least as often as it appears capitalized.
  const isCommonWord = (w) => {
    const k = w.toLowerCase();
    const lo = lower.get(k) || 0, up = upper.get(k) || 0;
    return lo >= Math.max(1, up);
  };
  const isNamePart = (a, b) =>
    isLikelyName(a, b) && !isCommonWord(a) && !isCommonWord(b);

  const note = (e, idx, isStrong) => {
    if (!cand.has(e.sig)) cand.set(e.sig, { sig: e.sig, type: e.type, forms: new Set(), facts: new Set() });
    const c = cand.get(e.sig);
    e.forms.forEach((f) => c.forms.add(f));
    c.facts.add(idx);
    if (isStrong) strong.add(e.sig);
  };
  facts.forEach((fact, idx) => {
    const text = fact || "";
    // strong signal: email-bound person
    const emailSigs = new Set();
    let m; const emailRe = /([A-Z][a-z]+)\s+([A-Z][a-z]+)\s*[(<]([a-z0-9._-]+)@/g;
    while ((m = emailRe.exec(text))) {
      if (!isLikelyName(m[1], m[2])) continue;
      const sig = `person:${slug(`${m[1]} ${m[2]}`)}`;
      emailSigs.add(sig);
      note({ sig, type: "person", forms: [normalize(`${m[1]} ${m[2]}`), m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase()] }, idx, true);
    }
    // high-precision syntactic-frame extractions (email/verb/list positions)
    for (const e of extractEntities(text)) {
      note(e, idx, strong.has(e.sig) || emailSigs.has(e.sig));
    }
    // WIDE NET: every capitalized bigram is a weak person candidate. Precision comes
    // from the case-evidence filter above + the recurrence gate below, not from lists.
    const bigramRe = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g;
    while ((m = bigramRe.exec(text))) {
      if (!isNamePart(m[1], m[2])) continue;
      const sig = `person:${slug(`${m[1]} ${m[2]}`)}`;
      note({ sig, type: "person", forms: [normalize(`${m[1]} ${m[2]}`), m[1].toLowerCase(), m[2].toLowerCase()] }, idx, false);
    }
  });
  const out = [];
  for (const c of cand.values()) {
    if (strong.has(c.sig) || c.facts.size >= minFacts || c.type === "ref") {
      out.push({ sig: c.sig, type: c.type, forms: [...c.forms].filter((f) => f.length >= 3) });
    }
  }
  return out;
}

// Co-mention: which vocab entities appear in a fact's text (word-boundary, case-insensitive).
function coMentions(factText, vocab) {
  const text = ` ${normalize(factText)} `;
  const hits = [];
  for (const v of vocab) {
    for (const f of v.forms) {
      if (text.includes(` ${f} `)) { hits.push(v.sig); break; }
    }
  }
  return [...new Set(hits)];
}

module.exports = { ENTITY_PREFIXES, buildVocab, extractEntities, extractEntitiesCorpus, coMentions, formsFor, typeOf, labelOf, normalize, slug };

