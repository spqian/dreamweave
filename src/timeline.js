"use strict";

// Coarse, RELATIVE age tags — the brain's compressive, logarithmic sense of elapsed
// time. The brain does not store a clock; it reconstructs "when" from a drifting
// context signal as monotonic ORDER plus a fuzzy sense of distance. Here, list
// position carries the fine order; this tag carries the gist-level recency. We
// deliberately avoid emitting a precise stored timestamp as the load-bearing signal:
// recent is sharp, long-ago is fuzzy, exactly as in human memory.

function ageDays(firstSeen, now) {
  const t = Date.parse(firstSeen || "");
  if (!t) return null;
  const n = now instanceof Date ? now.getTime() : Date.parse(now) || Date.now();
  return Math.max(0, Math.floor((n - t) / 86400000));
}

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

// Convenience: tag from a first_seen + reference "now".
function relAge(firstSeen, now) {
  return ageTag(ageDays(firstSeen, now));
}

module.exports = { ageDays, ageTag, relAge };
