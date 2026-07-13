"use strict";

// Shared helpers for turning a node signature + its edges into embeddable text.
//
// humanizeSig() is purely structural (protocol-level type:slug splitting, identical
// to sig-utils' labelOf/typeOf) and stays here as-is. The RELATION WORDING ("related
// to" default, "_" -> " "), the reverse-direction pronoun ("this"), and the sentence-
// joining convention used to build a fact-less hub's embedding text are English prose
// judgment, so they now live behind the pluggable language service (see langsvc.js).
// This module is a thin, backward-compatible FACADE: humanizeRel()/buildNodeText()
// resolve the caller's language service (default English, or an explicit/env-selected
// plugin) and delegate, so dream.js's injectText() keeps working unchanged.
const langsvc = require("./langsvc");

function humanizeSig(sig) {
  const idx = sig.indexOf(":");
  const type = idx >= 0 ? sig.slice(0, idx) : "";
  const label = (idx >= 0 ? sig.slice(idx + 1) : sig).replace(/-/g, " ");
  return type ? `${label} (${type})` : label;
}

function humanizeRel(rel, opts) {
  return langsvc.resolve(opts && opts.languageService).humanizeRelation(rel);
}

// edges: array of {src, rel, dst}. Builds neighbor-naming text so vector
// similarity captures graph context, not just the label.
function buildNodeText(sig, edges, opts) {
  return langsvc.resolve(opts && opts.languageService).renderNodeText(sig, edges);
}

module.exports = { humanizeSig, humanizeRel, buildNodeText };
