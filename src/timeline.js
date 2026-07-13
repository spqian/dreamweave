"use strict";

// Coarse, RELATIVE age tags — the brain's compressive, logarithmic sense of elapsed
// time. The brain does not store a clock; it reconstructs "when" from a drifting
// context signal as monotonic ORDER plus a fuzzy sense of distance. Here, list
// position carries the fine order; this tag carries the gist-level recency. We
// deliberately avoid emitting a precise stored timestamp as the load-bearing signal:
// recent is sharp, long-ago is fuzzy, exactly as in human memory.
//
// ageDays() is pure elapsed-time arithmetic (protocol-level, language-neutral) and
// stays here. The LABELS themselves ("just now", "long ago", ...) are English prose
// judgment, so they live behind the pluggable language service (see langsvc.js) —
// this module is a thin, backward-compatible FACADE: ageTag()/relAge() resolve the
// caller's language service (default English, or an explicit/env-selected plugin)
// and delegate, so every existing call site (recall.js, dream.js) keeps working
// unchanged while the actual wording is no longer hard-coded in the engine.
const langsvc = require("./langsvc");

function ageDays(firstSeen, now) {
  const t = Date.parse(firstSeen || "");
  if (!t) return null;
  const n = now instanceof Date ? now.getTime() : Date.parse(now) || Date.now();
  return Math.max(0, Math.floor((n - t) / 86400000));
}

function ageTag(d, opts) {
  return langsvc.resolve(opts && opts.languageService).ageTag(d);
}

// Convenience: tag from a first_seen + reference "now".
function relAge(firstSeen, now, opts) {
  return ageTag(ageDays(firstSeen, now), opts);
}

// Pull the EARLIEST explicit calendar date out of a fact's text — the most
// reliable event-date signal when createdAt/ingest timestamps are unusable
// (e.g. a host that resets createdAt on rebuild). Matches ISO dates with an
// optional time component ("2026-06-26", "2026-06-26T18:15:02Z", "2026-06-26 18:15").
// Conservative on purpose: only 20xx YYYY-MM-DD forms (never version numbers,
// money ranges, or bare years), month 01-12, day 01-31, and must parse. Returns
// the earliest match as an ISO string, or null when the text carries no date.
const DATE_RE = /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?\b/g;
function earliestTextDate(text) {
  if (!text) return null;
  let best = null;
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text)) !== null) {
    const t = Date.parse(m[0]);
    if (Number.isNaN(t)) continue;
    if (best === null || t < best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

module.exports = { ageDays, ageTag, relAge, earliestTextDate };
