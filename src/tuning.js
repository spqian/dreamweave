"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// tuning.js — the SINGLE source of truth for dreamweave's behavioral knobs.
//
// This module collapses scattered MEMORY_* env vars into FOUR user-facing knobs,
// ships sensible defaults that deliver the intended three-tier experience, and
// resolves them with a clear precedence:
//
//        env override   >   persisted memory.config.json   >   built-in default
//
// Paths, the embedding model, and embed dim are NOT knobs — they live in config.js
// as plain configuration.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const cfg = require("../config");

const CONFIG_PATH = process.env.MEMORY_CONFIG || path.join(cfg.DATA_DIR, "memory.config.json");
const CONFIG_VERSION = 1;

// ── The four knobs: allowed values + default (first entry is the default) ──────
const KNOBS = {
  retention:   { values: ["preserve", "prune"],                       default: "preserve",
                 help: "What happens to faded / overflow memories. preserve = tiered, demote to the Tier-3 archive and never delete (recommended). prune = legacy single-tier, evaporate/delete faded + over-cap facts." },
  capacity:    { values: ["compact", "standard", "expansive"],        default: "standard",
                 help: "Overall memory size: Tier-1 inject target / hard cap / Tier-2 recall cap. compact 150/300/1500, standard 250/500/2500, expansive 400/800/5000." },
  forgetting:  { values: ["slow", "natural", "fast"],                 default: "natural",
                 help: "How fast ephemeral (episodic) memories fade. slow = half-lives ×2 (hold longer), natural = as designed, fast = half-lives ×0.5 (forget sooner)." },
  connections: { values: ["incremental", "thorough"],                default: "incremental",
                 help: "Nightly weave scope. incremental = only weave new/changed facts (bounded cost, recommended for nightly runs). thorough = re-weave the whole active graph each run (slower, occasionally tighter)." },
};
// NOTE: supersede (correction lineage) is intentionally NOT a knob — it must always be on
// (a memory store that lets contradicting facts coexist untracked is simply broken). It stays
// overridable only via the MEMORY_SUPERSEDE env var as a bench/CI escape hatch.

// ── Capacity profiles → concrete tier sizes ──────────────────────────────────
const CAPACITY = {
  compact:   { target: 150, max: 300, tier2: 1500 },
  standard:  { target: 250, max: 500, tier2: 2500 },
  expansive: { target: 400, max: 800, tier2: 5000 },
};

// ── Forgetting profiles → half-life multiplier (larger = slower forgetting) ───
const FORGETTING = { slow: 2, natural: 1, fast: 0.5 };

function defaultKnobs() {
  const k = {};
  for (const [name, spec] of Object.entries(KNOBS)) k[name] = spec.default;
  return k;
}

function normalizeKnobs(raw = {}) {
  const k = defaultKnobs();
  for (const name of Object.keys(KNOBS)) {
    if (raw[name] == null) continue;
    const value = String(raw[name]).trim().toLowerCase();
    if (!KNOBS[name].values.includes(value)) {
      throw new Error(`invalid persisted value "${raw[name]}" for ${name}. Allowed: ${KNOBS[name].values.join(" | ")}`);
    }
    k[name] = value;
  }
  return k;
}

function loadConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch (e) {
    if (e && e.code === "ENOENT") return {};
    throw new Error(`cannot load memory config ${CONFIG_PATH}: ${e.message}`);
  }
}

function saveConfig(knobs) {
  const out = { version: CONFIG_VERSION, knobs };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, CONFIG_PATH);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  return out;
}

// Validate + persist a single knob. Returns { ok, knobs } or { ok:false, error }.
function setKnob(name, value) {
  const spec = KNOBS[name];
  if (!spec) return { ok: false, error: `unknown knob "${name}". Valid: ${Object.keys(KNOBS).join(", ")}` };
  let v = String(value).trim();
  if (spec.values) {
    v = v.toLowerCase();
    if (!spec.values.includes(v)) return { ok: false, error: `invalid value "${value}" for ${name}. Allowed: ${spec.values.join(" | ")}` };
  }
  const file = loadConfigFile();
  const knobs = { ...normalizeKnobs(file.knobs || {}), [name]: v };
  saveConfig(knobs);
  return { ok: true, knobs };
}

function configExists() {
  try { fs.accessSync(CONFIG_PATH); return true; } catch { return false; }
}

// Ensure a config file exists; write defaults if not. Returns { knobs, created }.
function ensureConfig() {
  if (configExists()) return { knobs: normalizeKnobs(loadConfigFile().knobs || {}), created: false };
  saveConfig(defaultKnobs());
  return { knobs: defaultKnobs(), created: true };
}

// ── helpers: env override coercion (undefined/"" → use fallback) ──────────────
function numEnv(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function boolEnv(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ── Resolve knobs → concrete low-level params the engine consumes ─────────────
// Precedence: explicit MEMORY_* env  >  persisted knob expansion  >  default.
function resolve(env = process.env) {
  const file = loadConfigFile();
  const knobs = normalizeKnobs(file.knobs || {});

  const cap = CAPACITY[knobs.capacity] || CAPACITY.standard;
  const preserve = knobs.retention !== "prune"; // anything but explicit prune = preserve

  const entryTarget = numEnv(env.MEMORY_ENTRY_TARGET, cap.target);
  const entryMax    = numEnv(env.MEMORY_ENTRY_MAX, cap.max);
  const tier2Max    = numEnv(env.MEMORY_TIER2_MAX, preserve ? cap.tier2 : 0);
  // NOTE: merge is now ALWAYS non-destructive (constituents are retained as Tier-2
  // 'detail', never deleted or overwritten) — there is no merge-keep flag. The
  // retention knob governs only the decay/over-cap forgetting lifecycle via tier2Max.
  const tiered      = tier2Max > 0;

  const forgetMultiplier = numEnv(env.MEMORY_FORGET_MULT, FORGETTING[knobs.forgetting] ?? 1);
  const incrementalWeave = boolEnv(env.MEMORY_INCREMENTAL_WEAVE, knobs.connections !== "thorough");
  const supersede        = boolEnv(env.MEMORY_SUPERSEDE, true); // always on (not a knob); env can force off for benches
  const entityMinFacts   = numEnv(env.MEMORY_ENTITY_MIN_FACTS, 2);

  return {
    knobs, configPath: CONFIG_PATH, configExists: configExists(),
    entryTarget, entryMax, tier2Max, tiered,
    forgetMultiplier, incrementalWeave, supersede, entityMinFacts,
  };
}

// One-line human summary of the active behavior (for setup / config show).
function describe(t = resolve()) {
  return [
    `retention=${t.knobs.retention} (${t.tiered ? "tiered: demote→Tier3, never delete" : "single-tier: delete faded/over-cap"})`,
    `capacity=${t.knobs.capacity} (inject ${t.entryTarget}/${t.entryMax}, recall ${t.tier2Max || "∞"})`,
    `forgetting=${t.knobs.forgetting} (half-life ×${t.forgetMultiplier})`,
    `connections=${t.knobs.connections} (${t.incrementalWeave ? "incremental" : "full"} weave)`,
    `corrections=${t.supersede ? "on" : "off"} (always on)`,
  ].join("\n  ");
}

module.exports = {
  KNOBS, CAPACITY, FORGETTING, CONFIG_PATH,
  defaultKnobs, normalizeKnobs, loadConfigFile, saveConfig, setKnob, ensureConfig, configExists,
  resolve, describe,
};
