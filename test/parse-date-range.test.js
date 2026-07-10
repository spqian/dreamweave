"use strict";
// Unit test for recall.js parseDateRange — bridges NL date queries to an ISO
// [lo,hi] window so the time-indexed cold bookshelf can be looked up by date.
const assert = require("assert");
const { parseDateRange } = require("../src/recall");

const asOf = new Date("2026-06-30");
let n = 0;
function eq(query, expected) {
  const got = parseDateRange(query, asOf);
  assert.deepStrictEqual(got, expected, `parseDateRange(${JSON.stringify(query)}) => ${JSON.stringify(got)} != ${JSON.stringify(expected)}`);
  console.log(`  ok: ${JSON.stringify(query)} -> ${JSON.stringify(expected)}`);
  n += 1;
}

// absolute ISO
eq("what happened on 2026-06-25", { lo: "2026-06-25", hi: "2026-06-25" });
eq("events in 2026-06", { lo: "2026-06-01", hi: "2026-06-30" });
// month name + day + year
eq("PPVNET incidents on June 25 2026", { lo: "2026-06-25", hi: "2026-06-25" });
eq("June 25, 2026 summary", { lo: "2026-06-25", hi: "2026-06-25" });
// month name + day, year inferred from as-of
eq("what changed on June 25", { lo: "2026-06-25", hi: "2026-06-25" });
// whole month (year must NOT be eaten as a day)
eq("June 2026 incidents", { lo: "2026-06-01", hi: "2026-06-30" });
eq("anything in February", { lo: "2026-02-01", hi: "2026-02-28" });
// qualifiers
eq("what happened in late June", { lo: "2026-06-21", hi: "2026-06-30" });
eq("early March notes", { lo: "2026-03-01", hi: "2026-03-10" });
eq("mid April", { lo: "2026-04-11", hi: "2026-04-20" });
// day range
eq("incidents June 24-29", { lo: "2026-06-24", hi: "2026-06-29" });
eq("between June 3 to 7", { lo: "2026-06-03", hi: "2026-06-07" });
// day clamp to month end
eq("Feb 30 2026", { lo: "2026-02-28", hi: "2026-02-28" });
// no date intent
eq("PPVNET container DNS mitigation status", null);
eq("what did the team decide about pricing", null);

// relative phrases resolved against as-of (2026-06-30)
eq("what happened to Germany West Central last week", { lo: "2026-06-23", hi: "2026-06-30" });
eq("anything yesterday", { lo: "2026-06-29", hi: "2026-06-29" });
eq("what shipped today", { lo: "2026-06-30", hi: "2026-06-30" });
eq("incidents the day before yesterday", { lo: "2026-06-28", hi: "2026-06-28" });
eq("changes in the past 3 days", { lo: "2026-06-27", hi: "2026-06-30" });
eq("what happened in the last 2 weeks", { lo: "2026-06-16", hi: "2026-06-30" });
eq("summary of the past few days", { lo: "2026-06-23", hi: "2026-06-30" });
eq("what changed this past week", { lo: "2026-06-23", hi: "2026-06-30" });
eq("deals closed last month", { lo: "2026-05-30", hi: "2026-06-30" });
eq("what happened recently", { lo: "2026-06-20", hi: "2026-06-30" });
// explicit dates still take precedence over relative phrasing
eq("what happened on 2026-06-25 last week", { lo: "2026-06-25", hi: "2026-06-25" });

console.log(`\nPASS \u2713 parseDateRange (${n} cases)`);
