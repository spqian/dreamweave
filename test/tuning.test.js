"use strict";
// Unit test for the tuning resolver: defaults deliver the target (tiered) UX,
// the persisted config file pins knobs, validation rejects junk, and raw env
// vars still override supported low-level settings.

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
chk(Object.keys(r.knobs).length === 4, "four user-facing knobs");
chk(r.knobs.retention === "preserve", "default retention = preserve");
chk(r.tiered === true, "default is tiered (demote, don't delete)");
chk(r.tier2Max === 2500, "default tier2Max = 2500");
chk(r.entryTarget === 250 && r.entryMax === 500, "default capacity = standard 250/500");
chk(r.supersede === true, "corrections (supersede) always on");
chk(r.incrementalWeave === true, "default connections = incremental");
chk(r.forgetMultiplier === 1, "default forgetting = natural (×1)");
chk(T.setKnob("corrections", "off").ok === false, "corrections is not a knob (rejected)");
chk(T.setKnob("judgment", "off").ok === false, "judgment is not a knob (rejected)");

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

// 4) Forgetting multiplier.
T.setKnob("forgetting", "slow");
r = T.resolve({});
chk(r.forgetMultiplier === 2, "forgetting slow → half-life ×2");

// 5) Raw env overrides win over file + knob (bench/CI escape hatch).
r = T.resolve({
  MEMORY_ENTRY_TARGET: "999",
  MEMORY_FORGET_MULT: "0.25",
  MEMORY_TIER2_MAX: "0",
});
chk(r.entryTarget === 999, "env MEMORY_ENTRY_TARGET overrides capacity profile");
chk(r.forgetMultiplier === 0.25, "env MEMORY_FORGET_MULT overrides forgetting knob");
chk(r.tiered === false, "env can force single-tier (TIER2_MAX=0)");

// 6) Malformed/invalid persisted config must fail clearly instead of silently
// resetting user behavior to defaults.
fs.writeFileSync(process.env.MEMORY_CONFIG, "{not-json", "utf8");
let malformedFailed = false;
try { T.resolve({}); } catch (e) { malformedFailed = /cannot load memory config/.test(e.message); }
chk(malformedFailed, "malformed config fails clearly");
fs.writeFileSync(process.env.MEMORY_CONFIG, JSON.stringify({ version: 1, knobs: { retention: "surprise" } }), "utf8");
let invalidFailed = false;
try { T.resolve({}); } catch (e) { invalidFailed = /invalid persisted value/.test(e.message); }
chk(invalidFailed, "invalid persisted knob fails clearly");

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(ok ? "\nPASS ✓ tuning resolver" : "\nFAILED ✗");
process.exit(ok ? 0 : 1);