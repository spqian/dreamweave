"use strict";

// langsvc.English.js — the DEFAULT (and only shipped) language service.
//
// All English-specific judgment about what text looks like a name, a grammatical
// function word, or a plausible surface form for an entity lives HERE, behind the
// pluggable languageService interface (see langsvc.js). The engine (dream.js) never
// hard-codes English behavior directly and never calls an LLM — this module is a
// deterministic, local, PROPOSING layer only. Its output is always provisional; the
// external caller LLM is the authority that approves, retypes, or rejects it via the
// report-entities / apply-entities hub-review contract.
//
// SELF-BOOTSTRAPPING: entity vocabulary is learned from the data (recurrence + email
// bindings), not from seed lists or domain denylists.
//
// MAPPING-DATAFLOW FIX (blast-radius containment): a mechanically-detected "First
// Last" candidate NEVER has its individual tokens ("first", "last") auto-added as
// surface forms. Splitting a multi-token label into single-token forms is exactly
// what turns one bad candidate into a magnet that falsely co-mentions every fact
// that happens to use either common word elsewhere ("the mapping was applied to
// every dataflow...") — a huge, hard-to-reverse blast radius. The full phrase is a
// safe default (it can only match text that actually contains it); single-token
// short forms/aliases are only ever added when the CALLER explicitly approves them
// via a decision's `forms` field, or via a hub-review `retype`/action. This module
// never does that on its own initiative.

const { labelOf, typeOf } = require("./sig-utils");

// ---- normalize/slug: ASCII-lowercase, punctuation-collapsing text shaping. This is
// an ENGLISH/Latin-script assumption (case folding, treating anything outside
// [a-z0-9] as a separator) — NOT a generic, language-independent operation. A
// plugin for another script/language owns its own normalize()/slug() entirely.
function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
const slug = (s) => normalize(s).replace(/\s+/g, "-").slice(0, 48);

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

// Surface forms an entity can appear as in fact text. Person entities default to
// the FULL PHRASE ONLY — see the MAPPING-DATAFLOW FIX note above. Single-token
// first/last forms are never synthesized here; callers add them explicitly (via
// apply-entities `forms`, or a hub-review `retype`/`keep` with explicit forms).
function formsFor(sig) {
  const type = typeOf(sig);
  const label = normalize(labelOf(sig));
  const forms = new Set([label]);
  if (["incident", "msrc", "pr", "release"].includes(type)) {
    // numeric/id tokens
    const ids = label.match(/[0-9][0-9.]+/g) || [];
    ids.forEach((x) => forms.add(x));
  }
  // drop ultra-short/ambiguous forms
  return [...forms].filter((f) => f && f.length >= 3);
}

// Extract NEW entities from a fact's text that deserve their own hub.
// Returns [{sig, type, forms}]. Conservative for precision.
function extractEntities(fact) {
  const out = [];
  const text = fact || "";
  const addPerson = (a, b, extraForms = []) => {
    if (!isLikelyName(a, b)) return;
    const full = `${a} ${b}`;
    // Full phrase is the only mechanically-synthesized form; extraForms carries
    // STRUCTURALLY strong, distinct identifiers (e.g. an email local-part bound
    // directly to this name in the text) — never a split of the name itself.
    out.push({ sig: `person:${slug(full)}`, type: "person",
      forms: [...new Set([normalize(full), ...extraForms])].filter((f) => f.length >= 3) });
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
  // isLikelyName() filters out product/org phrases (their tokens are in GRAMMATICAL).
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
// promotes a candidate person only when it has at least one STRUCTURAL person signal
// (email binding, person-like subject/verb frame, or collaborator/list frame).
// Recurring Title-Cased bigrams may reinforce that candidate across otherwise-neutral
// mentions, but capitalization + recurrence alone never asserts "person": operational
// states such as "Prod Canary" and "Awaiting Promotion" are often repeated in title
// case and are not names. The caller LLM remains authoritative for ambiguous cases.
//   facts: array of fact-text strings
//   opts.minFacts: recurrence threshold (default 2)
function extractEntitiesCorpus(facts, opts = {}) {
  const minFacts = Math.max(1, Number(opts.minFacts || process.env.MEMORY_ENTITY_MIN_FACTS || 2));
  const cand = new Map();    // sig -> { sig, type, forms:Set, facts:Set<idx> }
  const weak = new Map();    // wide-net occurrences; reinforce only structurally proposed people
  const strong = new Set();  // sigs with an email binding (promote at count 1)

  // CASE-EVIDENCE (self-bootstrapping, no word lists): a token that the corpus also
  // writes in lowercase is an ordinary word ("current", "board", "project"), not a
  // name part — so capitalized-only-at-sentence-start false positives ("Current
  // Condor", "For Condor") are rejected without any hand-curated denylist. We learn
  // this purely from the corpus's own casing. This gates WHICH weak bigram
  // candidates are considered at all; it never decides surface FORMS (see the
  // MAPPING-DATAFLOW FIX note at the top of this file for that fix).
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
  const noteWeak = (e, idx) => {
    if (!weak.has(e.sig)) weak.set(e.sig, { forms: new Set(), facts: new Set() });
    const w = weak.get(e.sig);
    e.forms.forEach((f) => w.forms.add(f));
    w.facts.add(idx);
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
      note({ sig, type: "person", forms: [normalize(`${m[1]} ${m[2]}`), m[3].toLowerCase()] }, idx, true);
    }
    // high-precision syntactic-frame extractions (email/verb/list positions)
    for (const e of extractEntities(text)) {
      note(e, idx, strong.has(e.sig) || emailSigs.has(e.sig));
    }
    // WIDE NET: capitalized bigrams are recurrence EVIDENCE, not independent proof of
    // personhood. They may extend a person already proposed by a structural frame
    // somewhere in the corpus, but cannot mint a person hub on their own.
    const bigramRe = /\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g;
    while ((m = bigramRe.exec(text))) {
      if (!isNamePart(m[1], m[2])) continue;
      const sig = `person:${slug(`${m[1]} ${m[2]}`)}`;
      noteWeak({ sig, forms: [normalize(`${m[1]} ${m[2]}`)] }, idx);
    }
  });
  for (const [sig, w] of weak) {
    const c = cand.get(sig);
    if (!c || c.type !== "person") continue;
    w.forms.forEach((f) => c.forms.add(f));
    w.facts.forEach((idx) => c.facts.add(idx));
  }
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

// ---------------------------------------------------------------------------------
// TEMPORAL PARSING + TOKENIZATION/STOPWORDING (moved here from recall.js/dream.js).
// English natural-language date parsing (month names, weekday names, "last week"-
// style relative phrases, and the US m/d[/y] numeric-date convention) and the
// stopword/significant-term extraction used to seed lexical recall and to derive
// signature slugs/content tokens are ALL language-specific judgments — they live
// here, behind the language service, exactly like entity extraction. recall.js and
// dream.js call the RESOLVED service's methods; they never hard-code English.
// ---------------------------------------------------------------------------------

// Parse a temporal window from a natural-language query so the cold bookshelf can be
// looked up by TIME (not just semantic/keyword). first_seen is stored ISO ("2026-06-25T..")
// which a query like "June 25" never LIKE-matches — this bridges NL dates to an ISO range.
// Returns { lo, hi } inclusive ISO-date bounds (YYYY-MM-DD) or null when no date intent.
const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
function pad2(n) { return String(n).padStart(2, "0"); }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function parseDateRange(query, nowRef) {
  const q = String(query || "").toLowerCase();
  const defYear = (nowRef instanceof Date && !Number.isNaN(nowRef.getTime())) ? nowRef.getFullYear() : new Date().getFullYear();
  // 1) ISO full date  2026-06-25
  let m = q.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const d = `${m[1]}-${m[2]}-${m[3]}`; return { lo: d, hi: d }; }
  // 2) ISO month  2026-06
  m = q.match(/(\d{4})-(\d{2})(?!\d)/);
  if (m) { const y = +m[1], mo = +m[2]; return { lo: `${m[1]}-${m[2]}-01`, hi: `${m[1]}-${m[2]}-${pad2(lastDay(y, mo))}` }; }
  // 3) numeric date (US host convention): 2/27 or 2/27/2026.
  m = q.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])(?:\/(\d{4}))?\b/);
  if (m) {
    const mo = +m[1], yr = m[3] ? +m[3] : defYear, d = Math.min(+m[2], lastDay(yr, mo));
    const iso = `${yr}-${pad2(mo)}-${pad2(d)}`;
    return { lo: iso, hi: iso };
  }
  // 4) cross-month named range: May 27 to June 2 [2026].
  const monthNames = Object.keys(MONTHS).join("|");
  m = q.match(new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\s*(?:-|–|to|through)\\s*(${monthNames})\\s+(\\d{1,2})(?:,?\\s*(\\d{4}))?\\b`, "i"));
  if (m) {
    const mo1 = MONTHS[m[1]], mo2 = MONTHS[m[4]];
    let y1 = m[3] ? +m[3] : defYear;
    let y2 = m[6] ? +m[6] : y1;
    if (!m[6] && mo2 < mo1) y2 += 1;
    const d1 = Math.min(+m[2], lastDay(y1, mo1));
    const d2 = Math.min(+m[5], lastDay(y2, mo2));
    return { lo: `${y1}-${pad2(mo1)}-${pad2(d1)}`, hi: `${y2}-${pad2(mo2)}-${pad2(d2)}` };
  }
  // 5) month name (+ optional qualifier / day / year)
  const monthRe = new RegExp(`(late|early|mid|middle|end of|beginning of)?\\s*(${Object.keys(MONTHS).join("|")})\\b(?:\\s+(\\d{1,2})(?!\\d))?(?:\\s*[-–to]{1,3}\\s*(\\d{1,2})(?!\\d))?(?:,?\\s*(\\d{4}))?`, "i");
  m = q.match(monthRe);
  if (m) {
    if (m[2].toLowerCase() === "may" && !m[1] && !m[3] && !m[5]) {
      const temporalMay = /\b(?:in|during|from|since|through|throughout)\s+may\b|\bmay\s+(?:events?|incidents?|changes?|updates?|notes?|summary|timeline|records?)\b/i.test(q);
      if (!temporalMay) m = null;
    }
  }
  if (m) {
    const qual = m[1] || "", mo = MONTHS[m[2]], d1 = m[3] ? +m[3] : null, d2 = m[4] ? +m[4] : null, yr = m[5] ? +m[5] : defYear;
    const ld = lastDay(yr, mo);
    if (d1 && d2) return { lo: `${yr}-${pad2(mo)}-${pad2(Math.min(d1, d2))}`, hi: `${yr}-${pad2(mo)}-${pad2(Math.min(ld, Math.max(d1, d2)))}` };
    if (d1) { const d = `${yr}-${pad2(mo)}-${pad2(Math.min(d1, ld))}`; return { lo: d, hi: d }; }
    // whole month, optionally narrowed by qualifier
    let lo = 1, hi = ld;
    if (/late|end of/.test(qual)) { lo = 21; hi = ld; }
    else if (/early|beginning of/.test(qual)) { lo = 1; hi = 10; }
    else if (/mid|middle/.test(qual)) { lo = 11; hi = 20; }
    return { lo: `${yr}-${pad2(mo)}-${pad2(lo)}`, hi: `${yr}-${pad2(mo)}-${pad2(hi)}` };
  }
  // 6) RELATIVE phrases resolved against nowRef (the --as-of anchor, else system now). Explicit
  // dates/months above take precedence; this fills natural temporal language so queries like
  // "what happened last week", "yesterday", "in the past 3 days" reliably trigger the date-window
  // (archive_time) scan instead of falling back to blind topical recall. Windows are rolling
  // [nowRef-N, nowRef] inclusive; the DB compares on the date prefix so events on `hi` are included.
  const base = (nowRef instanceof Date && !Number.isNaN(nowRef.getTime())) ? new Date(nowRef) : new Date();
  const iso = (dt) => `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  const back = (n) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() - n); return d; };
  const win = (n) => ({ lo: iso(back(n)), hi: iso(base) });
  const clampN = (s, max) => Math.max(1, Math.min(max, parseInt(s, 10) || 1));
  // Named weekday ranges resolve to the most recent completed occurrence. For example,
  // with a Sunday --as-of, "Monday through Friday" means the immediately preceding
  // Monday-Friday window. Requiring a range connector (or a temporal preposition for a
  // single weekday) avoids treating standing phrases such as "Friday catch-up" as dates.
  const weekdays = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const weekdayNames = Object.keys(weekdays).join("|");
  const previousWeekday = (day) => {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - day + 7) % 7));
    return d;
  };
  m = q.match(new RegExp(`\\b(${weekdayNames})\\s*(?:-|–|to|through|thru)\\s*(${weekdayNames})\\b`, "i"));
  if (m) {
    const startDay = weekdays[m[1]], endDay = weekdays[m[2]];
    const end = previousWeekday(endDay);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - ((endDay - startDay + 7) % 7));
    return { lo: iso(start), hi: iso(end) };
  }
  m = q.match(new RegExp(`\\b(?:on|last|past|previous)\\s+(${weekdayNames})\\b`, "i"));
  if (m) { const d = iso(previousWeekday(weekdays[m[1]])); return { lo: d, hi: d }; }
  if (/\bday before yesterday\b/.test(q)) { const d = iso(back(2)); return { lo: d, hi: d }; }
  if (/\byesterday\b/.test(q)) { const d = iso(back(1)); return { lo: d, hi: d }; }
  if (/\btoday\b/.test(q)) { const d = iso(base); return { lo: d, hi: d }; }
  // "last/past N day(s)|week(s)|month(s)"
  m = q.match(/\b(?:last|past|previous|prior)\s+(\d{1,3})\s+(day|week|month)s?\b/);
  if (m) { const unit = m[2], mult = unit === "day" ? 1 : unit === "week" ? 7 : 31; return win(clampN(m[1], unit === "day" ? 90 : unit === "week" ? 26 : 24) * mult); }
  // "last/past few|several|couple days|weeks"
  if (/\b(?:last|past|recent|these past)\s+(?:few|several|couple(?:\s+of)?)\s+days\b/.test(q)) return win(7);
  if (/\b(?:last|past|recent|these past)\s+(?:few|several|couple(?:\s+of)?)\s+weeks\b/.test(q)) return win(21);
  // singular period windows
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+week\b/.test(q)) return win(7);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+month\b/.test(q)) return win(31);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+quarter\b/.test(q)) return win(92);
  if (/\b(?:last|past|previous|prior|this(?:\s+past)?)\s+year\b/.test(q)) return win(365);
  if (/\b(?:recently|lately|of late|in recent days)\b/.test(q)) return win(10);
  return null;
}

// Month-name vocabulary, exposed so a caller (recall.js's active-date-window tier) can
// filter temporal words out of "topic" terms without hard-coding English month names.
function monthNames() { return Object.keys(MONTHS); }

// recall.js's query-significance stopword list: function words PLUS domain-neutral
// standing-intent/daily-status words ("work", "updates", "keep", "note") that would
// otherwise open the archive floodgates by themselves.
const QUERY_STOPWORDS = new Set(
  "the a an is are was were of for to in on and or that with as at by from this its not be no into what which who whom whose when where why how did do does has have had will would should could about over under more most than then them they their our your you i me my we us work works working update updates updated status note notes keep keeps keeping kept reminder reminders daily weekly monthly today yesterday tomorrow".split(" ")
);
function isQueryStopword(word) { return QUERY_STOPWORDS.has(word); }

// dream.js's slug/content-token stopword list: a SMALLER, purely grammatical
// function-word list used to derive fact-signature slugs and same-subject content
// tokens (supersede/sequence matching) — distinct from the larger query-significance
// list above (a stricter filter there would change which words seed lexical recall).
const SIGNATURE_STOPWORDS = new Set(
  "the a an is are was were of for to in on and or that with as at by from this its not be no into".split(" ")
);
function isSignatureStopword(word) { return SIGNATURE_STOPWORDS.has(word); }

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/^\s*\[[^\]]+\]\s*/, " ")
    .replace(/\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Significant query terms shared by the lexical-seed channel and the Tier-3 keyword tiers.
function significantTerms(query, limit) {
  return [...new Set((String(query || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []).filter((t) => !QUERY_STOPWORDS.has(t)))].slice(0, limit || 10);
}

// Raw word tokenization: this language's own notion of a "word" boundary/character set
// (ASCII-lowercase + runs of [a-z0-9]) — used by recall.js's topic-cohesion gate, which
// used to hard-code this regex directly in the engine. Distinct from significantTerms()
// (which also strips stopwords and keeps hyphenated runs joined): this is the bare
// tokenizer other engine logic filters/gates on top of via isQueryStopword() etc.
function tokenize(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
}

// "list every X"-shaped queries (recall.js) get a wider detail/parent budget and skip
// the scope-key dedup, because the ANSWER IS the enumeration itself.
const ENUMERATIVE_RE = /\b(all|each|every|list|enumerate|which|who\s+were|how\s+many|name\s+the)\b/i;
function isEnumerativeQuery(query) { return ENUMERATIVE_RE.test(query || ""); }

// Broader "the caller wants drill-down specifics, not a paraphrase" signal (recall.js's
// dateless anchor-day episode-reconstruction tier). recall.js ORs this with
// isEnumerativeQuery(), so this only needs to carry the EXTRA phrasing.
const SPECIFICS_INTENT_RE = /\b(exact|exactly|precise|verbatim|specific|list|which|what(?:\s+[^\s?]+){0,6}\s+date|when|how\s+many|enumerate|that\s+(session|meeting|day|call|week|conversation)|in\s+that\s+(session|meeting|call))\b/i;
function isSpecificsIntentQuery(query) { return SPECIFICS_INTENT_RE.test(query || ""); }

// Month names PLUS generic event/incident/update vocabulary that recall.js's active
// date-window tier subtracts from a query's significant terms to isolate "topic" (as
// opposed to "when") terms.
const EXTRA_TEMPORAL_WORDS = new Set(["happened", "event", "events", "incident", "incidents", "change", "changed", "changes", "update", "updates", "summary", "timeline", "record", "records"]);
function isTemporalWord(word) { return MONTHS[word] != null || EXTRA_TEMPORAL_WORDS.has(word); }

// "as of X" / "previously" / "used to"-shaped queries (recall.js) ask about a PAST
// value rather than the current standing one, which relaxes the supersede-demotion
// penalty so a stale-but-matching record can still surface.
const HISTORICAL_INTENT_RE = /\b(as of|during|origin(?:al|ally)?|before it|previous(?:ly)?|used to|initially|initial|at the time|back then)\b/i;
function isHistoricalIntentQuery(query) { return HISTORICAL_INTENT_RE.test(query || ""); }

// Fact text that reads as a correction/update/override of a prior statement
// (dream.js's nightly supersede-linking pass). English correction-cue vocabulary;
// a plugin owns its own grammar for "this replaces that".
const CORRECTION_CUE_RE = /\b(correct(?:ion|ed|s)?|chang(?:e|ed|ing)?|updat(?:e|ed)?|revis(?:e|ed)?|no longer|instead of|rather than|supersed(?:e|ed|es)?|overrid(?:e|den|es)?|replac(?:e|ed|es)?|moved? (?:to|up|earlier|from)|push(?:ed)? (?:to|up|earlier)|now \w+ not)\b/i;
function isCorrectionCueText(text) { return CORRECTION_CUE_RE.test(text || ""); }

// HARD-SPECIFIC extraction for the vagueness trace (moved here from dream.js). A "hard
// specific" is an answer-bearing literal a generalized gist cannot reconstruct: money,
// percentage, multiple, and counted quantities — the count-noun vocabulary ("people",
// "employees", "seats", ...) and money-scale words ("million"/"billion"/"thousand") are
// English. DATES/TIMES are deliberately EXCLUDED — per-day "as of 2026-03-26" restatement
// timestamps are CORRECTLY dropped by generalization and would swamp the signal. Returns
// a Set of normalized token strings so the same value stated two ways collides.
const HARD_SPEC = {
  money: /\$\s?\d[\d.,]*(?:\s?[-–]\s?\d[\d.,]*)?\s?(?:million|billion|thousand|[mbk])?\b/gi,
  pct: /\b\d+(?:\.\d+)?\s?%/g,
  mult: /\b\d+(?:\.\d+)?\s?x\b/gi,
  count: /\b\d{1,4}\s+(?:people|employees|seats|headcount|customers|users|accounts|deals|reps|hires|roles|units|shares|basis points|bps)\b/gi,
};
function extractHardSpecifics(text) {
  const out = new Set();
  if (!text) return out;
  for (const re of Object.values(HARD_SPEC)) {
    const m = text.match(re);
    if (!m) continue;
    for (let t of m) {
      t = t.toLowerCase().replace(/\s+/g, "")
        .replace(/million/g, "m").replace(/billion/g, "b").replace(/thousand/g, "k")
        .replace(/–/g, "-");
      if (t) out.add(t);
    }
  }
  return out;
}

// Coarse, RELATIVE age LABELS (moved here from timeline.js) — the brain's compressive,
// logarithmic sense of elapsed time, in English prose. See timeline.js's ageTag()
// facade for the rationale: list position carries the fine order, this carries only
// gist-level recency, and a plugin owns its own translation of these bands.
function ageTag(d) {
  if (d == null) return "undated";
  if (d <= 2) return "just now";
  if (d <= 7) return "this week";
  if (d <= 21) return "past couple weeks";
  if (d <= 45) return "last month or so";
  if (d <= 90) return "a couple months ago";
  if (d <= 150) return "earlier this period";
  return "long ago";
}

// Humanized node/relation prose for a fact-less hub's embedding text (moved here from
// graphtext.js). Relation wording ("related to" default, "_" -> " "), the reverse-
// direction pronoun ("this"), and the sentence-joining convention (". ") are English
// prose choices; the node label/type split itself is generic (sig-utils labelOf/typeOf).
function humanizeRelation(rel) { return (rel || "related to").replace(/_/g, " "); }
function renderNodeText(sig, edges) {
  const humanizeNode = (s) => { const t = typeOf(s); const l = labelOf(s); return t ? `${l} (${t})` : l; };
  const parts = [humanizeNode(sig)];
  for (const e of (edges || [])) {
    if (e.src === sig) parts.push(`${humanizeRelation(e.rel)} ${humanizeNode(e.dst)}`);
    else if (e.dst === sig) parts.push(`${humanizeNode(e.src)} ${humanizeRelation(e.rel)} this`);
  }
  return parts.join(". ");
}

module.exports = {
  id: "english",
  GRAMMATICAL, isLikelyName,
  normalize, slug, labelOf, typeOf,
  formsFor, extractEntities, extractEntitiesCorpus, coMentions,
  parseDateRange, monthNames, normalizeForMatch, significantTerms,
  isQueryStopword, isSignatureStopword,
  tokenize, isEnumerativeQuery, isSpecificsIntentQuery, isTemporalWord,
  isHistoricalIntentQuery, isCorrectionCueText,
  extractHardSpecifics, ageTag, humanizeRelation, renderNodeText,
};
