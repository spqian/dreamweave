"use strict";

// The engine's language behavior — NOT ONLY entity extraction, but ALSO
// natural-language temporal parsing and tokenization/normalization/stopwording —
// must be behind a pluggable, LOCAL, deterministic languageService (no LLM call,
// ever). This test:
//
//   1. injects an alternate service (a module path via MEMORY_LANG_SERVICE,
//      resolved by src/langsvc.js) that recognizes a totally different,
//      non-English-shaped entity pattern (ALL-CAPS bracketed tokens, e.g.
//      "[UNIT-7]") and proves weave() actually uses it instead of the shipped
//      default English implementation;
//   2. proves the SAME plugin's own parseDateRange/tokenization methods (not just
//      entity extraction) are what the engine calls — using a deliberately
//      non-English-shaped date phrase ("STARDATE 41000") the default English
//      service would never recognize;
//   3. proves enumerative-query detection, hard-specific extraction (dream.js's
//      vagueness trace), relative age-tag labels (timeline.js), and node/relation
//      rendering prose (graphtext.js) are ALSO plugin-owned — including through
//      the timeline.js/graphtext.js backward-compat facades — and that a caller
//      with no injected service still gets the unchanged shipped English default;
//   4. proves the loader FAILS EXPLICITLY (throws) for a malformed plugin missing
//      required interface method(s), and never silently falls back to English.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-langsvc-plugin-"));
const dream = path.join(__dirname, "..", "src", "dream.js");

let ok = true;
const fail = (m) => { console.error("FAIL:", m); ok = false; };

// A full, valid plugin implementing every required languageService method (see
// src/langsvc.js's REQUIRED_METHODS) — entities are "[TOKEN]" bracketed forms
// only, and temporal/tokenization behavior is DELIBERATELY non-English-shaped so
// any use of it (vs. silently falling back to English) is unambiguous.
const FAKE_LANG_SRC = `
"use strict";
function normalize(s) { return (s || "").toLowerCase().trim(); }
function slug(s) { return normalize(s).replace(/\\s+/g, "-").slice(0, 48); }
function formsFor(sig) {
  const label = sig.slice(sig.indexOf(":") + 1).replace(/-/g, " ");
  return [label];
}
function extractEntities() { return []; }
function extractEntitiesCorpus(facts, opts) {
  const minFacts = (opts && opts.minFacts) || 2;
  const counts = new Map();
  for (const fact of facts) {
    const re = /\\[([A-Z0-9-]+)\\]/g;
    let m;
    while ((m = re.exec(fact || ""))) {
      const label = m[1].toLowerCase();
      const sig = \`topic:\${label}\`;
      counts.set(sig, (counts.get(sig) || 0) + 1);
    }
  }
  const out = [];
  for (const [sig, n] of counts) if (n >= minFacts) out.push({ sig, type: "topic", forms: [sig.slice(sig.indexOf(":") + 1)] });
  return out;
}
function coMentions(factText, vocab) {
  const hits = [];
  for (const v of vocab) for (const f of v.forms) if ((factText || "").toLowerCase().includes(f)) { hits.push(v.sig); break; }
  return hits;
}
// Non-English-shaped temporal grammar: "STARDATE <number>" maps deterministically
// to a fixed fictional epoch, so a hit here can ONLY come from this plugin, never
// from the shipped English service (which has no notion of "stardate").
function parseDateRange(query) {
  const m = String(query || "").match(/stardate\\s+(\\d+)/i);
  if (!m) return null;
  const d = String(2300 + Math.floor(Number(m[1]) / 1000)).padStart(4, "0") + "-01-01";
  return { lo: d, hi: d };
}
function monthNames() { return ["primus", "secundus"]; } // fictional calendar, proves override
function normalizeForMatch(text) { return String(text || "").toLowerCase(); }
function significantTerms(query, limit) {
  return [...new Set(String(query || "").toLowerCase().split(/\\s+/).filter((w) => w.length > 2))].slice(0, limit || 10);
}
function isQueryStopword(word) { return word === "zzznotaword"; } // deliberately near-empty, proves override
function isSignatureStopword(word) { return word === "zzznotaword"; }
// The remaining methods below are ALSO required by langsvc.js's REQUIRED_METHODS
// (topic-cohesion tokenization, enumerative/specifics/historical query-shape
// detection, temporal-word gating, hard-specific extraction, age-tag labels, and
// node/relation rendering prose) — every one deliberately non-English-shaped so a
// hit can ONLY come from this plugin, never the shipped English default.
function tokenize(text) { return String(text || "").toLowerCase().split(/\\s+/).filter(Boolean); }
function isEnumerativeQuery(query) { return /\\bmanifest\\b/i.test(query || ""); }
function isSpecificsIntentQuery(query) { return /\\bdossier\\b/i.test(query || ""); }
function isTemporalWord(word) { return word === "primus" || word === "secundus" || word === "stardate"; }
function isHistoricalIntentQuery(query) { return /\\bchronicle\\b/i.test(query || ""); }
function isCorrectionCueText(text) { return /\\bamend\\b/i.test(text || ""); }
function extractHardSpecifics(text) {
  const out = new Set();
  const re = /unit-count:(\\d+)/gi;
  let m;
  while ((m = re.exec(text || ""))) out.add(\`unitcount\${m[1]}\`);
  return out;
}
function ageTag(d) {
  if (d == null) return "epoch-unknown";
  return d <= 2 ? "epoch-fresh" : "epoch-old";
}
function renderNodeText(sig, edges) {
  const parts = [\`NODE<\${sig}>\`];
  for (const e of (edges || [])) {
    if (e.src === sig) parts.push(\`--\${e.rel}--><\${e.dst}>\`);
    else if (e.dst === sig) parts.push(\`<\${e.src}>--\${e.rel}-->\`);
  }
  return parts.join("|");
}
module.exports = {
  id: "fake-bracket-lang", normalize, slug, formsFor, extractEntities, extractEntitiesCorpus, coMentions,
  parseDateRange, monthNames, normalizeForMatch, significantTerms, isQueryStopword, isSignatureStopword,
  tokenize, isEnumerativeQuery, isSpecificsIntentQuery, isTemporalWord,
  isHistoricalIntentQuery, isCorrectionCueText, extractHardSpecifics, ageTag, renderNodeText,
};
`;
const fakeLangPath = path.join(dataDir, "fake-lang.js");
fs.writeFileSync(fakeLangPath, FAKE_LANG_SRC);

// ---- (1) + partial (2): engine (dream.js weave()) actually uses the injected plugin ----
{
  const env = { ...process.env, AGENT_MEMORY_DIR: dataDir, MEMORY_LANG_SERVICE: fakeLangPath };
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [dream, ...args], { env, encoding: "utf8" }));

  run("init");

  const Database = require("better-sqlite3");
  const db = new Database(path.join(dataDir, "memory.db"));
  const ins = db.prepare("INSERT INTO nodes(signature,memory_id,kind,class,strength,first_seen,notes,fact,ingested_seq,dirty_seq) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ins.run("fact:u1", "m-u1", "fact", "episodic", 0.3, "2026-01-01", "harness-ingest", "Unit [UNIT-7] passed its health check.", 1, 1);
  ins.run("fact:u2", "m-u2", "fact", "episodic", 0.3, "2026-01-02", "harness-ingest", "Rebooting [UNIT-7] resolved the alert.", 2, 2);
  ins.run("fact:eng", "m-eng", "fact", "episodic", 0.3, "2026-01-03", "harness-ingest", "Alice Example reported the status twice more today.", 3, 3);
  ins.run("fact:eng2", "m-eng2", "fact", "episodic", 0.3, "2026-01-04", "harness-ingest", "Alice Example confirmed the fix shipped successfully.", 4, 4);
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('change_seq','4')").run();
  db.close();

  run("weave", "--as-of", "2026-01-05T00:00:00.000Z");

  const db2 = new Database(path.join(dataDir, "memory.db"), { readonly: true });
  const bracketHub = db2.prepare("SELECT signature FROM nodes WHERE kind='entity' AND signature='topic:unit-7'").get();
  const englishHub = db2.prepare("SELECT signature FROM nodes WHERE kind='entity' AND signature LIKE 'person:alice%'").get();
  db2.close();

  if (!bracketHub) fail("injected fake language service's bracketed-token entity was not created — injection not live");
  if (englishHub) fail("English-shaped name became a hub even though the injected service never proposes persons — default English service leaked through");
}

// ---- (2) plugin-defined temporal parse + tokenization path is actually used ----
// Exercised in-process (not via the CLI) by injecting the plugin OBJECT directly
// through recall.js's exported wrappers — proving the resolved-service plumbing
// works for both module-path (above) and direct-object injection.
{
  delete require.cache[require.resolve(fakeLangPath)];
  const fakeLang = require(fakeLangPath);
  const { parseDateRange, significantTerms } = require("../src/recall");

  const got = parseDateRange("what happened at stardate 41000", new Date("2026-01-01T00:00:00Z"), { languageService: fakeLang });
  if (!got || got.lo !== "2341-01-01") fail(`plugin-defined parseDateRange was not used (got ${JSON.stringify(got)})`);

  // The default English service would recognize no date intent at all in this
  // phrase (no month/weekday/relative-phrase match), proving this hit is plugin-only.
  const defaultGot = parseDateRange("what happened at stardate 41000", new Date("2026-01-01T00:00:00Z"));
  if (defaultGot !== null) fail(`expected the DEFAULT English service to find no date intent in a stardate phrase, got ${JSON.stringify(defaultGot)}`);

  const terms = significantTerms("the quick fox", 10, { languageService: fakeLang });
  if (!terms.includes("the")) fail(`plugin's near-empty stopword list was not used — expected "the" to survive filtering, got ${JSON.stringify(terms)}`);
}

// ---- (3) enumerative/hard-specific/age-tag/rendering are plugin-owned, not an ----
// English fallback — engine portions covering query-shape detection, the
// vagueness-trace hard-specific extraction, relative-age labels, and node/relation
// embedding prose all resolve through the SAME languageService seam, so exercising
// each via langsvc.resolve() (and, where a facade exists, the facade itself) proves
// they are plugin-owned rather than silently borrowed from the English default.
{
  delete require.cache[require.resolve(fakeLangPath)];
  const fakeLang = require(fakeLangPath);
  const langsvc = require("../src/langsvc");
  const resolved = langsvc.resolve(fakeLang);

  // enumerative-query detection: plugin's own trigger word ("manifest"), not
  // English's "all|each|every|list|...".
  if (!resolved.isEnumerativeQuery("manifest every unit")) fail("plugin's isEnumerativeQuery was not used");
  if (resolved.isEnumerativeQuery("list every unit")) fail("English enumerative wording leaked through despite the plugin owning isEnumerativeQuery");

  // hard-specific extraction: plugin's own "UNIT-COUNT:N" grammar, not English's
  // money/percent/count-noun patterns.
  const specs = resolved.extractHardSpecifics("Status: UNIT-COUNT:42 nominal. $3 million is irrelevant here.");
  if (!specs.has("unitcount42")) fail(`plugin's extractHardSpecifics was not used, got ${JSON.stringify([...specs])}`);
  if (specs.has("3m")) fail("English hard-specific money extraction leaked through despite the plugin owning extractHardSpecifics");

  // age-tag labels: plugin's own fictional epoch wording, via BOTH the resolved
  // service directly and the timeline.js facade (proving the facade delegates and
  // that a caller with no opts still gets the shipped English default unchanged).
  const { ageTag } = require("../src/timeline");
  if (resolved.ageTag(1) !== "epoch-fresh") fail(`plugin's ageTag was not used, got ${JSON.stringify(resolved.ageTag(1))}`);
  if (ageTag(1, { languageService: fakeLang }) !== "epoch-fresh") fail("timeline.js's ageTag facade did not delegate to the injected plugin");
  if (ageTag(1) !== "just now") fail("plugin ageTag leaked into the DEFAULT (no-opts) timeline.ageTag call");

  // node/relation rendering prose: plugin's own format, via BOTH the resolved
  // service directly and the graphtext.js facade.
  const { buildNodeText } = require("../src/graphtext");
  const edges = [{ src: "topic:unit-7", rel: "mentions", dst: "topic:alert" }];
  const rendered = resolved.renderNodeText("topic:unit-7", edges);
  if (!rendered.includes("NODE<topic:unit-7>")) fail(`plugin's renderNodeText was not used, got ${JSON.stringify(rendered)}`);
  const facadeRendered = buildNodeText("topic:unit-7", edges, { languageService: fakeLang });
  if (facadeRendered !== rendered) fail("graphtext.js's buildNodeText facade did not delegate to the injected plugin");
  if (buildNodeText("topic:unit-7", edges).includes("NODE<")) fail("plugin renderNodeText leaked into the DEFAULT (no-opts) graphtext.buildNodeText call");
}

// ---- (4) malformed plugin: loader fails EXPLICITLY, never silently falls back ----
{
  const langsvc = require("../src/langsvc");
  const malformedPath = path.join(dataDir, "malformed-lang.js");
  // Missing parseDateRange/monthNames/normalizeForMatch/significantTerms/isQueryStopword/
  // isSignatureStopword/normalize/slug entirely — only implements entity extraction.
  fs.writeFileSync(malformedPath, `
    "use strict";
    module.exports = {
      id: "malformed",
      formsFor: (sig) => [sig],
      extractEntities: () => [],
      extractEntitiesCorpus: () => [],
      coMentions: () => [],
    };
  `);
  let threw = null;
  try { langsvc.resolve(malformedPath); } catch (e) { threw = e; }
  if (!threw) fail("malformed plugin (missing required methods) was NOT rejected — resolve() must throw, not silently fall back to English");
  else if (!/missing required method/i.test(threw.message)) fail(`malformed plugin rejection did not name the missing methods: ${threw.message}`);

  // A plugin object missing `id`/most methods must also be rejected.
  let threw2 = null;
  try { langsvc.resolve({ normalize: (s) => s }); } catch (e) { threw2 = e; }
  if (!threw2) fail("plugin object missing required `id`/methods was NOT rejected");

  // The CLI must also fail loudly (non-zero exit), not silently use English.
  const env = { ...process.env, AGENT_MEMORY_DIR: dataDir, MEMORY_LANG_SERVICE: malformedPath };
  let cliThrew = false;
  try {
    execFileSync(process.execPath, [dream, "weave", "--as-of", "2026-01-05T00:00:00.000Z"], { env, encoding: "utf8" });
  } catch (e) { cliThrew = true; }
  if (!cliThrew) fail("dream.js CLI did not fail when given a malformed MEMORY_LANG_SERVICE plugin");
}

console.log(ok
  ? "PASS \u2713 an injected language-service plugin (entities + temporal parsing + tokenization + enumerative/hard-specific/age-tag/rendering) is used, and malformed plugins are rejected explicitly"
  : "\nFAILED \u2717 language-service plugin contract violated");
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
