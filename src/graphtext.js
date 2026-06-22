"use strict";

// Shared helpers for turning a node signature + its edges into embeddable text.

function humanizeSig(sig) {
  const idx = sig.indexOf(":");
  const type = idx >= 0 ? sig.slice(0, idx) : "";
  const label = (idx >= 0 ? sig.slice(idx + 1) : sig).replace(/-/g, " ");
  return type ? `${label} (${type})` : label;
}

const humanizeRel = (rel) => (rel || "related to").replace(/_/g, " ");

// edges: array of {src, rel, dst}. Builds neighbor-naming text so vector
// similarity captures graph context, not just the label.
function buildNodeText(sig, edges) {
  const parts = [humanizeSig(sig)];
  for (const e of edges) {
    if (e.src === sig) parts.push(`${humanizeRel(e.rel)} ${humanizeSig(e.dst)}`);
    else if (e.dst === sig) parts.push(`${humanizeSig(e.src)} ${humanizeRel(e.rel)} this`);
  }
  return parts.join(". ");
}

module.exports = { humanizeSig, humanizeRel, buildNodeText };
