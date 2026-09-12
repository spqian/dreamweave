"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");

test("release archive requires both adapter-owned skill bundles and the core contract", () => {
  const required = [
    "docs/JUDGMENT-SURFACES.md",
    "harness-adapters/MicrosoftScout/skills/dream/SKILL.md",
    "harness-adapters/MicrosoftScout/skills/graph-recall/SKILL.md",
    "harness-adapters/hermes-agent/skills/dream/SKILL.md",
    "harness-adapters/hermes-agent/skills/graph-recall/SKILL.md",
  ];
  for (const relative of required) {
    assert.match(workflow, new RegExp(relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `release workflow must require ${relative}`);
  }
  assert.doesNotMatch(workflow, /"\$\{NAME\}\/skills\/(dream|graph-recall)\/SKILL\.md"/,
    "release workflow must not require removed root skill paths");
});
