"use strict";

// Entity layer for the dream weave: builds an entity vocabulary (with aliases),
// extracts entities from fact text, and computes co-mention links fact -> entity.
// High precision by design: matches existing entity hubs + email-bound persons + IDs.
// The vector layer (in dream.js) guarantees connectivity for anything this misses.

const ENTITY_PREFIXES = [
  "person", "team", "org", "system", "topic", "incident", "release",
  "pr", "msrc", "heuristic", "artifact", "decision", "thread",
];

// Capitalized bigrams that are NOT people — common product/org/phrase forms that
// the "First Last" heuristic would otherwise misread as names. Keep this generic;
// add domain-specific terms via the MEMORY_NON_PERSON env (comma-separated) if needed.
const NON_PERSON = new Set([
  "machine learning", "data science", "open source", "pull request", "code review",
  "unit test", "design doc", "status update", "action item", "root cause",
  "north america", "south america", "united states", "new york", "san francisco",
  "human resources", "customer success", "product management", "engineering team",
  "board meeting", "quarterly review", "annual report", "fiscal year",
  ...String(process.env.MEMORY_NON_PERSON || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

// Single tokens that are never a person's name (so e.g. "Pipeline Actions",
// "Orchestration Team" are rejected). Generic, role/structure words.
const NON_NAME_WORDS = new Set([
  "team", "teams", "project", "projects", "action", "actions", "pipeline", "orchestration",
  "product", "review", "summer", "winter", "spring", "fall", "company", "group", "division",
  "release", "service", "services", "security", "operations", "shared", "platform", "system",
  "engineering", "manager", "managers", "director", "lead", "report", "reports", "meeting",
  "north", "south", "east", "west", "central", "the", "and", "with", "from", "for",
  ...String(process.env.MEMORY_NON_NAME_WORDS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

const isLikelyName = (a, b) => {
  const x = a.toLowerCase(); const y = b.toLowerCase();
  if (NON_NAME_WORDS.has(x) || NON_NAME_WORDS.has(y)) return false;
  if (NON_PERSON.has(`${x} ${y}`)) return false;
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

  // IDs.
  const addId = (re, type) => {
    let mm; const r = new RegExp(re, "g");
    while ((mm = r.exec(text))) out.push({ sig: `${type}:${mm[1]}`.toLowerCase(), type, forms: [mm[1].toLowerCase()] });
  };
  addId("incident\\s+(\\d{6,})", "incident");
  addId("\\bIcM#?(\\d{6,})", "incident");
  addId("\\bMSRC\\s*(\\d{4,})", "msrc");
  addId("\\bPR\\s*(\\d{6,})", "pr");
  addId("\\b(\\d{9})\\b", "incident"); // bare 9-digit = incident id in this domain

  // dedup by sig
  const seen = new Map();
  for (const e of out) {
    if (!seen.has(e.sig)) seen.set(e.sig, e);
    else seen.get(e.sig).forms = [...new Set([...seen.get(e.sig).forms, ...e.forms])];
  }
  return [...seen.values()];
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

module.exports = { ENTITY_PREFIXES, buildVocab, extractEntities, coMentions, formsFor, typeOf, labelOf, normalize, slug };

