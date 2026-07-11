"use strict";

// P11 applies before seed truncation: a reinforced, still-relevant candidate can
// enter the seed window, while strength cannot rescue an off-topic low-cosine row.

const { rankSeedCandidates } = require("../src/recall");

const rows = [
  { signature: "fact:surface-1", distance: 0.28, strength: 0.02 },
  { signature: "fact:surface-2", distance: 0.29, strength: 0.01 },
  { signature: "fact:surface-3", distance: 0.30, strength: 0.01 },
  { signature: "fact:surface-4", distance: 0.31, strength: 0.01 },
  { signature: "fact:reinforced-answer", distance: 0.36, strength: 0.95 },
  { signature: "fact:off-topic-strong", distance: 0.75, strength: 1.0 },
];

const ranked = rankSeedCandidates(rows);
const top4 = ranked.slice(0, 4).map((r) => r.signature);
if (!top4.includes("fact:reinforced-answer")) {
  throw new Error("activation was applied after the seed window");
}
if (top4.includes("fact:off-topic-strong")) {
  throw new Error("strength rescued a candidate below the semantic cosine floor");
}

console.log("PASS \u2713 activation ranks candidates before seed truncation");
