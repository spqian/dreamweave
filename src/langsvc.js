"use strict";

// langsvc.js — pluggable language-service loader/facade.
//
// The engine (dream.js, recall.js) NEVER hard-codes English (or any language)
// behavior directly. ALL language-specific judgment lives behind this interface —
// not just entity extraction: what looks like a name or a grammatical function
// word, a plausible surface form, natural-language TEMPORAL parsing (month/weekday
// names, relative phrases, numeric-date convention), and
// tokenization/normalization/stopwording for matching and slugging. It is:
//   - LOCAL-only: no network, no LLM call, ever.
//   - DETERMINISTIC: same input -> same output, every run.
//   - PROPOSING, not authoritative (for entities): its output is always
//     provisional; the external caller LLM is the judge (via the report-entities /
//     apply-entities contract).
//
// A language service module MUST export every one of these (all functions, plus a
// non-empty string `id`) — this is the full contract, not just entity extraction:
//   id                                    — short identifier string
//   normalize(text)                       -> string
//   slug(text)                            -> string
//   formsFor(sig)                         -> string[]
//   extractEntities(fact)                 -> [{sig,type,forms}]
//   extractEntitiesCorpus(facts, opts)    -> [{sig,type,forms}]
//   coMentions(factText, vocab)           -> string[] (matching sigs)
//   parseDateRange(query, nowRef)         -> {lo,hi}|null (inclusive ISO date bounds)
//   monthNames()                          -> string[] (temporal vocabulary helper)
//   normalizeForMatch(text)               -> string
//   significantTerms(query, limit)        -> string[]
//   isQueryStopword(word)                 -> boolean
//   isSignatureStopword(word)             -> boolean
//   tokenize(text)                        -> string[] (raw word tokens; a language's
//                                             own notion of a "word" — e.g. ASCII
//                                             lowercasing/splitting is an English/
//                                             Latin-script assumption, not a generic one)
//   isEnumerativeQuery(query)             -> boolean ("list every X"-shaped query)
//   isSpecificsIntentQuery(query)         -> boolean ("exact/precise/that session"-
//                                             shaped query seeking drill-down detail)
//   isTemporalWord(word)                  -> boolean (month names + generic
//                                             event/incident/update vocabulary used
//                                             to separate "topic" terms from "when"
//                                             terms in a query)
//   isHistoricalIntentQuery(query)        -> boolean ("as of"/"previously"/"used to"-
//                                             shaped query asking about a PAST value)
//   isCorrectionCueText(text)             -> boolean (fact text reads as a correction/
//                                             update/override of a prior statement)
//   extractHardSpecifics(text)            -> Set<string> (answer-bearing literals a
//                                             generalized gist can't reconstruct:
//                                             money/percent/multiple/counted-quantity
//                                             phrasing, normalized so restatements collide)
//   ageTag(days)                          -> string (coarse relative-age label, e.g.
//                                             "just now"/"long ago" — the brain's fuzzy
//                                             sense of elapsed time, in this language's prose)
//   renderNodeText(sig, edges)            -> string (humanized node+neighbor prose used
//                                             as the embedding text for a fact-less hub;
//                                             `edges`: [{src,rel,dst}])
//
// Resolution order for `resolve(spec)`:
//   1. spec is already an object implementing the interface -> used directly
//      (this is how tests inject a fake/alternate language service).
//   2. spec is a module path/specifier string -> required (relative paths resolve
//      against this file's directory so callers can pass "./my-lang.js").
//   3. spec is omitted -> MEMORY_LANG_SERVICE env var (module path/specifier), then
//   4. the shipped default: ./langsvc.English.js
//
// VALIDATION: every resolved service (object injection, module path, or default) is
// checked against the full interface above. A malformed plugin (missing method(s),
// wrong `id`, or not exporting an object at all) throws IMMEDIATELY and EXPLICITLY —
// resolve() never silently falls back to the English default on a bad plugin. Failing
// loudly here is deliberate: a partially-implemented plugin silently borrowing
// English's temporal/tokenization behavior for the methods it forgot to define would
// be a much harder bug to notice than a startup error.
//
// No behavior feature flag is introduced: swapping the language service is a
// deliberate, explicit module-path/object choice (per-call opts or the env var),
// never an on/off toggle for behavior.

const path = require("path");

const DEFAULT_MODULE = "./langsvc.English.js";

// The full required interface — see the contract comment above.
const REQUIRED_METHODS = [
  "normalize", "slug", "formsFor", "extractEntities", "extractEntitiesCorpus", "coMentions",
  "parseDateRange", "monthNames", "normalizeForMatch", "significantTerms",
  "isQueryStopword", "isSignatureStopword",
  "tokenize", "isEnumerativeQuery", "isSpecificsIntentQuery", "isTemporalWord",
  "isHistoricalIntentQuery", "isCorrectionCueText",
  "extractHardSpecifics", "ageTag", "renderNodeText",
];

function describeSpec(spec) {
  if (typeof spec === "string") return spec;
  if (spec && typeof spec === "object") return "<injected object>";
  return "<default>";
}

function validateService(svc, spec) {
  const what = describeSpec(spec);
  if (!svc || typeof svc !== "object") {
    throw new Error(`languageService invalid (${what}): module did not export an object`);
  }
  if (typeof svc.id !== "string" || !svc.id.trim()) {
    throw new Error(`languageService invalid (${what}): missing/empty required string "id"`);
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof svc[m] !== "function");
  if (missing.length) {
    throw new Error(`languageService invalid (${what}): missing required method(s): ${missing.join(", ")}`);
  }
  return svc;
}

function resolveModulePath(spec) {
  if (spec.startsWith(".") || spec.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(spec)) {
    return path.isAbsolute(spec) ? spec : path.join(__dirname, spec);
  }
  return spec; // bare package specifier
}

function resolve(spec) {
  if (spec && typeof spec === "object") return validateService(spec, spec); // direct injection (tests)
  const modPath = (typeof spec === "string" && spec.trim()) ? spec.trim()
    : (process.env.MEMORY_LANG_SERVICE && process.env.MEMORY_LANG_SERVICE.trim()) || DEFAULT_MODULE;
  return validateService(require(resolveModulePath(modPath)), modPath);
}

function defaultService() {
  return validateService(require(DEFAULT_MODULE), DEFAULT_MODULE);
}

module.exports = { resolve, defaultService, DEFAULT_MODULE, REQUIRED_METHODS };

