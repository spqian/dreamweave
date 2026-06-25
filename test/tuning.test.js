"use strict";
// Unit test for the tuning resolver: defaults deliver the target (tiered) UX,
// the persisted config file pins knobs, validation rejects junk, and raw env
// vars still override everything (so benches / CI keep working).

const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dw-tuning-"));
process.env.MEMORY_CONFIG = path.join(tmp, "memory.config.json");
// Pin a data dir too so config.js doesn't touch the real one.
process.env.DREAM_MEMORY_DIR = tmp;

const T = require("../src/tuning");

let ok = true;
function chk(cond, msg) { if (!cond) { console.error("FAIL:", msg); ok = false; } else { console.log("  ok:", msg); } }

// 1) Defaults (no config file) → target experience.
let r = T.resolve({});
chk(r.knobs.retention === "preserve", "default retention = preserve");
chk(r.tiered === true, "default is tiered (demote, don't delete)");
chk(r.tier2Max === 2500, "default tier2Max = 2500");
chk(r.entryTarget === 250 && r.entryMax === 500, "default capacity = standard 250/500");
chk(r.supersede === true, "corrections (supersede) always on");
chk(r.incrementalWeave === true, "default connections = incremental");
chk(r.forgetMultiplier === 1, "default forgetting = natural (×1)");
chk(r.llmSpec === null, "default judgment = off");
chk(T.setKnob("corrections", "off").ok === false, "corrections is not a knob (rejected)");

// 2) setKnob persists + validates.
chk(T.setKnob("retention", "prune").ok === true, "setKnob retention prune ok");
chk(T.setKnob("retention", "bogus").ok === false, "reject invalid retention value");
chk(T.setKnob("nope", "x").ok === false, "reject unknown knob");
r = T.resolve({});
chk(r.knobs.retention === "prune", "persisted retention = prune");
chk(r.tiered === false && r.tier2Max === 0, "prune → single-tier (delete)");

// 3) Capacity profile expands.
T.setKnob("capacity", "compact");
r = T.resolve({});
chk(r.entryTarget === 150 && r.entryMax === 300, "compact → 150/300");

// 4) Forgetting multiplier + judgment knob → llmSpec.
T.setKnob("forgetting", "slow");
T.setKnob("judgment", "azure:gpt-5.4-mini");
r = T.resolve({});
chk(r.forgetMultiplier === 2, "forgetting slow → half-life ×2");
chk(r.llmSpec === "azure:gpt-5.4-mini", "judgment knob → llmSpec");
chk(T.setKnob("judgment", "garbage-no-colon").ok === false, "reject malformed judgment spec");

// 5) Raw env overrides win over file + knob (bench/CI escape hatch).
r = T.resolve({
  MEMORY_ENTRY_TARGET: "999",
  MEMORY_FORGET_MULT: "0.25",
  DREAM_LLM: "openai:gpt-4o-mini",
  MEMORY_TIER2_MAX: "0",
  MEMORY_MERGE_KEEP: "0",
});
chk(r.entryTarget === 999, "env MEMORY_ENTRY_TARGET overrides capacity profile");
chk(r.forgetMultiplier === 0.25, "env MEMORY_FORGET_MULT overrides forgetting knob");
chk(r.llmSpec === "openai:gpt-4o-mini", "env DREAM_LLM overrides judgment knob");
chk(r.tiered === false, "env can force single-tier (TIER2_MAX=0 + MERGE_KEEP=0)");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(ok ? "\nPASS ✓ tuning resolver" : "\nFAILED ✗");
process.exit(ok ? 0 : 1);
