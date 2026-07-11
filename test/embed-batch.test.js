"use strict";

// Batch embedding must be byte-equivalent to one-at-a-time embedding.

const { embedTexts, embedOne, DIMS } = require("../src/embed");

(async () => {
  const texts = [
    "Alice Example owns the migration checklist.",
    "The board approved the operating plan.",
    "Project Condor revised its valuation range.",
  ];
  const batched = await embedTexts(texts);
  const singles = [];
  for (const text of texts) singles.push(await embedOne(text));

  if (batched.length !== texts.length) throw new Error(`expected ${texts.length} vectors, got ${batched.length}`);
  for (let i = 0; i < texts.length; i += 1) {
    if (batched[i].length !== DIMS) throw new Error(`vector ${i} has ${batched[i].length} dimensions`);
    let maxDiff = 0;
    for (let j = 0; j < DIMS; j += 1) maxDiff = Math.max(maxDiff, Math.abs(batched[i][j] - singles[i][j]));
    if (maxDiff > 1e-6) throw new Error(`batch vector ${i} differs from single embedding by ${maxDiff}`);
  }

  console.log("PASS \u2713 embedding batches preserve one-at-a-time vectors");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
