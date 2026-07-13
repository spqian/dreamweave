"use strict";

// Generic, language-INDEPENDENT signature/label utilities shared by the engine and
// every pluggable language service implementation (see langsvc.js). These are
// PURE STRUCTURAL "type:slug" signature parsing — they carry NO judgment about what
// counts as a name, a grammatical form, or a vocabulary word, and NO assumption about
// character set, casing, or word-boundary conventions (those ARE language-specific:
// e.g. ASCII-lowercasing punctuation-stripping is an English/Latin-script assumption).
// That judgment lives entirely behind the language service — normalize()/slug() and
// all tokenization/stopword/temporal logic are owned by langsvc.English.js (the
// default) or whatever plugin a caller resolves via langsvc.js.

const ENTITY_PREFIXES = [
  "person", "team", "org", "system", "topic", "incident", "release",
  "ref", "artifact", "decision", "thread", "project",
];

// "type:slug" is a protocol-level convention (not a language behavior): every sig
// this engine mints/reads is exactly `${type}:${slug}`, regardless of which language
// service produced the slug half. Splitting on the first ":" is safe generically.
function labelOf(sig) {
  const i = sig.indexOf(":");
  return (i >= 0 ? sig.slice(i + 1) : sig).replace(/-/g, " ");
}

function typeOf(sig) {
  const i = sig.indexOf(":");
  return i >= 0 ? sig.slice(0, i) : "";
}

// Build the vocabulary from existing entity-kind nodes, using a language service's
// formsFor() to derive default surface forms per signature.
function buildVocab(entityRows, lang) {
  const vocab = [];
  for (const r of entityRows) {
    vocab.push({ sig: r.signature, type: typeOf(r.signature), forms: lang.formsFor(r.signature) });
  }
  return vocab;
}

module.exports = { ENTITY_PREFIXES, labelOf, typeOf, buildVocab };
