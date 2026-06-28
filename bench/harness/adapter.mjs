// Recall Bench adapter for the agent-memory engine (graph + vector + nightly "dream").
//
// Wraps the standalone agent-memory CLI (src/dream.js, src/recall.js). Retrieval uses
// LOCAL embeddings (sqlite-vec + MiniLM) — no embedding API key needed. The only model
// call is query-time answer synthesis, done via the bench's CliGeneratorModel (copilot
// by default, no API key).
//
// Profile wiring:
//   harness:
//     adapter: ./bench/harness/adapter.mjs
//     factory: createAgentMemoryAdapter
//     config:
//       enginePath: /path/to/dream-memory   # repo root (defaults to the clone)
//       model: copilot          # synthesis model (copilot|claude|codex)
//       runDream: false         # false = retrieval mode (no forgetting); true = exercise dream
//       searchK: 14
//       maxHops: 2

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import YAML from "yaml";
import { CliGeneratorModel, isCliAgentName, createModelFromSpec } from "../../packages/recall-bench/dist/index.js";

function runEngine(enginePath, script, args, dataDir, envExtra) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(enginePath, "src", script), ...args], {
      env: { ...process.env, ...(envExtra || {}), AGENT_MEMORY_DIR: dataDir },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${script} exited ${code}: ${err.slice(0, 600)}`));
    });
  });
}

// Category heuristic. Decisions → salient (durable, aids decision-tracking); everything
// else → semantic. We deliberately avoid the episodic class here: with a nightly dream,
// episodic facts evaporate within ~a week, which is correct for an inject-budget bank but
// wrong for a retrieval benchmark that rewards long-horizon retention.
function categorize(content) {
  const t = content.toLowerCase();
  if (/\bdecision\b|\bdecided\b|\bchose\b|\bapproved\b|\bwill (?:proceed|move|go)\b|\bagreed to\b|\bsign-?off\b/.test(t)) return "decision";
  return "fact";
}

// Preferred ingest: the bench's pre-generated atomic memorySave items (Pass 3).
// Each call's `content` is a clean, session-attributed, calendar-voiced memory —
// exactly the shape our engine wants, far better than splitting prose.
async function factsFromTools(toolsDir, day) {
  const file = path.join(toolsDir, `day-${String(day).padStart(4, "0")}.yaml`);
  if (!existsSync(file)) return null;
  let doc;
  try { doc = YAML.parse(await readFile(file, "utf8")); } catch { return null; }
  const calls = (doc && doc.calls) || [];
  const facts = [];
  let i = 0;
  for (const c of calls) {
    if (c && c.tool === "memorySave" && c.content) {
      const content = String(c.content).trim();
      if (content.length < 4) continue;
      const sess = c.session ? `[${c.session}] ` : "";
      facts.push({ id: `d${day}-${i++}`, fact: sess + content, category: categorize(content) });
    }
  }
  return facts;
}

// Fallback: split a day's markdown into atomic-ish facts (corpora without Pass-3 tools).
function extractFacts(content, day) {
  const facts = [];
  let i = 0;
  for (let raw of String(content || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">")) continue; // headers/quotes
    line = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").replace(/^\*\*[^*]+\*\*:?\s*/, "").trim();
    if (line.length < 8) continue;
    const parts = line.length > 220 ? line.split(/(?<=[.!?])\s+/) : [line];
    for (const p of parts) {
      const t = p.trim();
      if (t.length >= 8) facts.push({ id: `d${day}-${i++}`, fact: t, category: "fact" });
    }
  }
  return facts;
}

// Render retrieved memories for the synthesizer. RELEVANCE ORDER IS PRIMARY: the
// cluster already arrives ranked by hop-proximity then strength, and reordering it by
// time (an earlier experiment) starved pointed factual/synthesis questions of their
// best evidence. So we KEEP the relevance order and merely ANNOTATE each line with its
// coarse relative age (and date) — the temporal key as metadata, not as a reordering.
// Gist (timeless schema) facts are marked as such; everything else carries its age.
function buildContext(out) {
  let cluster;
  try { cluster = JSON.parse(out); } catch { return "(retrieval failed)"; }
  const nodes = (cluster && cluster.cluster && cluster.cluster.nodes) || [];
  const facts = nodes.filter((n) => n.kind === "fact" && n.fact).slice(0, 30);
  if (!facts.length) return "(no memories matched)";
  return facts.map((n) => {
    if (n.tier === "narrative") return `- [timeline] ${n.fact}`;
    if (n.tier === "gist") return `- [standing fact] ${n.fact}`;
    const date = n.first_seen ? n.first_seen.slice(0, 10) : "";
    const tag = n.age ? `${n.age}${date ? ", " + date : ""}` : (date || "undated");
    return `- [${tag}] ${n.fact}`;
  }).join("\n");
}

export function createAgentMemoryAdapter(rawCfg) {
  const cfg = rawCfg || {};
  // Engine path: config wins, else DREAM_MEMORY_ENGINE env, else assume the repo
  // checkout two levels up from bench/harness/ (so it works from a clone with no config).
  const enginePath = cfg.enginePath || process.env.DREAM_MEMORY_ENGINE
    || path.resolve(new URL("../..", import.meta.url).pathname);
  // Synthesis model: a CLI agent name (copilot/claude/codex) OR a provider spec
  // like "azure:gpt-5.4-mini" / "openai:gpt-4o-mini" (env from the profile's env.file).
  const modelSpec = cfg.model || "copilot";
  const model = isCliAgentName(modelSpec)
    ? new CliGeneratorModel({ agent: modelSpec })
    : createModelFromSpec(modelSpec);
  const searchK = cfg.searchK || 14;
  const maxHops = cfg.maxHops || 2;
  const runDream = cfg.runDream !== false; // default TRUE — dream runs once per ingested day
  const toolsDir = cfg.toolsDir || null;   // dir of Pass-3 day-XXXX.yaml memorySave files
  // DREAM JUDGMENT (LLM): the model the engine itself uses for typed entity extraction,
  // alias canonicalization (weave --llm), and the reflect pass (salience + semantic
  // merge). A provider spec like "azure:gpt-5.4-mini". Empty => mechanical-only engine
  // (regex entities, no merge/salience) — the no-LLM fallback path.
  const dreamModel = cfg.dreamModel || "";
  // How often to run the expensive reflect pass: "daily" (faithful nightly cadence) or
  // "finalize" (once at the end — cheaper for long sweeps). Default daily when an LLM
  // is configured. weave --llm runs every night regardless (entity typing is cheap).
  const reflectCadence = cfg.reflectCadence || "daily";
  // FAITHFUL to Scout's native harness: a hard cap of 500 entries (degrades past 250).
  // The nightly dream enforces this deterministically (decay + hard-ceiling eviction), so
  // recall is over the SAME bounded surface Scout actually has — not an infinite store.
  // Override to a large number ONLY for the aspirational "unbounded store" experiment.
  const entryTarget = String(cfg.entryTarget || 250);
  const entryMax = String(cfg.entryMax || 500);
  const supersede = cfg.supersede === true; // opt-in supersede-aware consolidation
  const retainDetail = cfg.retainDetail === true; // non-destructive merge: keep detail facts for recall
  let dataDir = null;
  let envExtra = {};
  let lastAsOf = null; // checkpoint "now" — anchors relative-age tags in recall

  function engine(script, args) {
    return runEngine(enginePath, script, args, dataDir, envExtra);
  }

  return {
    name: cfg.name || "agent-memory (graph+vector+dream)",

    async setup() {
      dataDir = await mkdtemp(path.join(tmpdir(), "am-bench-"));
      envExtra = { MEMORY_ENTRY_TARGET: entryTarget, MEMORY_ENTRY_MAX: entryMax };
      if (supersede) envExtra.MEMORY_SUPERSEDE = "1";
      if (dreamModel) envExtra.DREAM_LLM = dreamModel; // engine LLM judgment uses the same .env keys as the judge
      if (retainDetail) envExtra.MEMORY_MERGE_KEEP = "1"; // keep merged detail facts in the side DB for recall
    },

    async ingestDay(day, content, metadata) {
      const asOf = (metadata && metadata.date) || undefined;
      if (asOf) lastAsOf = asOf;
      // Prefer the bench's atomic memorySave items; fall back to splitting markdown.
      let facts = toolsDir ? await factsFromTools(toolsDir, day) : null;
      if (!facts) facts = extractFacts(content, day);
      if (facts.length) {
        const snap = path.join(dataDir, `snap-${day}.json`);
        await writeFile(snap, JSON.stringify(facts), "utf8");
        const ia = ["ingest-harness", "--file", snap];
        if (asOf) ia.push("--as-of", asOf);
        await engine("dream.js", ia);
      }
      // The once-a-day "nightly dream": decay/reactivate/consolidate, then weave
      // (which incrementally embeds the day's new facts + builds the entity graph).
      // This is the daily cadence the system is designed around — not per-memory work.
      if (runDream) {
        const da = ["dream"]; if (asOf) da.push("--as-of", asOf);
        await engine("dream.js", da);
      }
      const wa = ["weave"]; if (dreamModel) wa.push("--llm"); if (asOf) wa.push("--as-of", asOf);
      await engine("dream.js", wa);
      // Nightly LLM judgment (salience + semantic merge) — the faithful dream cadence.
      if (dreamModel && reflectCadence === "daily") {
        const ra = ["reflect"]; if (asOf) ra.push("--as-of", asOf);
        await engine("dream.js", ra);
      }
    },

    async finalizeIngestion() {
      // Days were woven nightly; a final idempotent weave covers any tail state
      // when the harness finalizes between incremental checkpoints.
      const wa = ["weave"]; if (dreamModel) wa.push("--llm");
      await engine("dream.js", wa);
      if (dreamModel && reflectCadence === "finalize") {
        await engine("dream.js", ["reflect"]);
      }
    },

    async query(question) {
      const qa = ["--query", question, "--max-hops", String(maxHops), "--k", String(searchK)];
      if (lastAsOf) qa.push("--as-of", lastAsOf);
      const out = await engine("recall.js", qa);
      const ctx = buildContext(out);
      const sys = "You answer questions about a person's history using ONLY the retrieved memory snippets below. "
        + "Each snippet is prefixed with how long ago it was noted (e.g. '[this week, 2026-06-20]' or '[a couple "
        + "months ago, ...]'); '[standing fact]' marks a timeless policy with no single date. The snippets are ordered "
        + "by relevance, not time. When a question asks WHEN something happened or which value is the LATEST, compare "
        + "the age tags and prefer the most recent relevant snippet. If the memories do not contain the answer, reply "
        + "that you have no record of it — do not guess. Be concise and specific; cite concrete details.";
        + "Be concise and specific; cite concrete details from the memories.";
      const user = `Retrieved memories:\n${ctx}\n\nQuestion: ${question}\n\nAnswer:`;
      const ans = await model.complete(sys, user, {});
      return String((ans && ans.text) || ans || "").trim();
    },

    async teardown() {
      if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

