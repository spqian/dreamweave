"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");
const script = path.join(root, "harness-adapters/MicrosoftScout/scripts/install-skills.js");
const { installSkills } = require(script);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scout-install-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const target = path.join(dir, "custom skills");
  fs.mkdirSync(home);
  return { dir, home, target };
}

test("Scout discovery preserves legacy directory precedence only on explicit install", (t) => {
  for (const [present, expected] of [
    [[".copilot/m-skills", ".scout/m-skills"], ".copilot/m-skills"],
    [[".copilot", ".scout/m-skills"], ".scout/m-skills"],
    [[".copilot", ".scout"], ".copilot/m-skills"],
    [[".scout"], ".scout/m-skills"],
  ]) {
    const f = fixture(t);
    for (const name of present) fs.mkdirSync(path.join(f.home, name), { recursive: true });
    const result = installSkills({ home: f.home, target: null });
    assert.equal(result.dir, path.join(f.home, expected));
    assert.deepEqual(result.names, ["dream", "graph-recall"]);
    assert.equal(fs.existsSync(path.join(result.dir, "dream", "SKILL.md")), true);
  }
});

test("missing Scout fails clearly without creating host directories", (t) => {
  const f = fixture(t);
  f.target = "";
  const result = cli(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no .*\.copilot.*\.scout.*SCOUT_SKILLS_DIR/i);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test("dangling skill symlinks count as existing customizations before any write", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.target);
  fs.symlinkSync(path.join(f.dir, "missing"), path.join(f.target, "graph-recall"), "dir");
  const result = cli(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists/);
  assert.deepEqual(fs.readdirSync(f.target), ["graph-recall"]);
  assert.equal(fs.lstatSync(path.join(f.target, "graph-recall")).isSymbolicLink(), true);
});

test("CLI help and unknown arguments never perform installation", (t) => {
  const f = fixture(t);
  const help = cli(f, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:.*install-skills.*--force/);
  assert.equal(fs.existsSync(f.target), false);
  const bad = cli(f, ["--froce"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown argument/);
  assert.equal(fs.existsSync(f.target), false);
});

test("incomplete source package fails before moving customized skills", (t) => {
  const f = fixture(t);
  const engineRoot = path.join(f.dir, "incomplete engine");
  const sourceRoot = path.join(engineRoot, "harness-adapters/MicrosoftScout/skills");
  fs.mkdirSync(path.join(sourceRoot, "dream"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "dream", "SKILL.md"), "<AGENT_MEMORY>");
  fs.mkdirSync(path.join(f.target, "dream"), { recursive: true });
  fs.writeFileSync(path.join(f.target, "dream", "SKILL.md"), "custom dream");
  assert.throws(() => installSkills({ target: f.target, home: f.home, engineRoot, force: true }), /ENOENT/);
  assert.deepEqual(fs.readdirSync(f.target), ["dream"]);
  assert.equal(fs.readFileSync(path.join(f.target, "dream", "SKILL.md"), "utf8"), "custom dream");
});

test("a forced install cannot replace the package's source skills", (t) => {
  const f = fixture(t);
  const engineRoot = path.join(f.dir, "engine");
  const source = path.join(root, "harness-adapters/MicrosoftScout/skills");
  const target = path.join(engineRoot, "harness-adapters/MicrosoftScout/skills");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  const before = fs.readFileSync(path.join(target, "dream", "SKILL.md"), "utf8");
  assert.throws(() => installSkills({ target, engineRoot, home: f.home, force: true }), /source skills/);
  assert.equal(fs.readFileSync(path.join(target, "dream", "SKILL.md"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(target).sort(), ["dream", "graph-recall"]);
});

test("a nonexistent target beneath a symlink cannot enter source skills", (t) => {
  const f = fixture(t);
  const engineRoot = path.join(f.dir, "engine");
  const source = path.join(root, "harness-adapters/MicrosoftScout/skills");
  const sourceRoot = path.join(engineRoot, "harness-adapters/MicrosoftScout/skills");
  fs.mkdirSync(path.dirname(sourceRoot), { recursive: true });
  fs.cpSync(source, sourceRoot, { recursive: true });
  const link = path.join(f.dir, "source-link");
  fs.symlinkSync(sourceRoot, link, "dir");
  const target = path.join(link, "nested-install");
  assert.throws(() => installSkills({ target, engineRoot, home: f.home, force: true }), /source skills/);
  assert.equal(fs.existsSync(path.join(sourceRoot, "nested-install")), false);
});

test("a pinned destination wins over discovery and never falls back on error", (t) => {
  const f = fixture(t);
  const discovered = path.join(f.home, ".copilot", "m-skills");
  fs.mkdirSync(discovered, { recursive: true });
  assert.equal(cli(f).status, 0);
  assert.deepEqual(fs.readdirSync(discovered), []);
  assert.equal(fs.existsSync(path.join(f.target, "dream", "SKILL.md")), true);
  const blocked = path.join(f.dir, "not-a-directory");
  fs.writeFileSync(blocked, "keep");
  f.target = path.join(blocked, "skills");
  assert.equal(cli(f).status, 1);
  assert.deepEqual(fs.readdirSync(discovered), []);
  assert.equal(fs.readFileSync(blocked, "utf8"), "keep");
});

test("importing the Scout installer has no filesystem side effects", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ["-e", "require(process.argv[1])", script], {
    cwd: f.dir, encoding: "utf8",
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, SCOUT_SKILLS_DIR: f.target },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test("Scout guide preserves the interview and later host setup steps", () => {
  const doc = fs.readFileSync(path.join(root, "harness-adapters/MicrosoftScout/install.md"), "utf8");
  const { KNOBS } = require("../src/tuning");
  assert.match(doc, /^# Installing dreamweave into Microsoft Scout/);
  assert.doesNotMatch(doc, /OpenClaw/);
  for (const [name, spec] of Object.entries(KNOBS)) {
    const row = doc.split("\n").find((line) => line.startsWith("| ") && line.includes("`" + name + "`"));
    assert.ok(row, `documented knob: ${name}`);
    for (const value of spec.values) assert.ok(row.includes(value));
    assert.ok(row.includes("**" + spec.default + "**"));
  }
  for (const section of ["INTERVIEW THE USER", "Interview script", "Schedule the nightly dream", "Restart Scout", "Auto-approve the recall command", "Precedence & power-user overrides", "Uninstall", "Known limitations"]) {
    assert.ok(doc.includes(section), `preserved section: ${section}`);
  }
  assert.match(doc, /npm run setup\s+npm run setup:scout/);
  assert.match(doc, /repository\/package root/);
  assert.equal(require("../package.json").scripts["setup:scout"], "node harness-adapters/MicrosoftScout/scripts/install-skills.js");
});

test("host skill bundles are owned by their adapters, not the repository root", () => {
  for (const skill of ["dream", "graph-recall"]) {
    assert.equal(fs.existsSync(path.join(root, "skills", skill)), false,
      `root skill namespace must not contain ${skill}`);
    assert.equal(fs.existsSync(path.join(root, "harness-adapters/MicrosoftScout/skills", skill, "SKILL.md")), true,
      `Microsoft Scout must own its ${skill} skill`);
    assert.equal(fs.existsSync(path.join(root, "harness-adapters/hermes-agent/skills", skill, "SKILL.md")), true,
      `Hermes Agent must own its ${skill} skill`);
  }
});

function cli(f, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: f.dir,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, SCOUT_SKILLS_DIR: f.target },
    encoding: "utf8",
  });
}

test("explicit Scout install copies both skills and substitutes absolute engine paths", (t) => {
  const f = fixture(t);
  const result = cli(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(f.target).sort(), ["dream", "graph-recall"]);
  const sourceRoot = path.join(root, "harness-adapters/MicrosoftScout/skills");
  for (const skill of ["dream", "graph-recall"]) {
    for (const file of fs.readdirSync(path.join(sourceRoot, skill))) {
      const source = fs.readFileSync(path.join(sourceRoot, skill, file), "utf8");
      const installed = fs.readFileSync(path.join(f.target, skill, file), "utf8");
      assert.equal(installed, source.split("<AGENT_MEMORY>").join(root.replace(/\\/g, "/")));
    }
  }
  assert.match(result.stdout, /Restart Microsoft Scout/);
});

test("existing customized skills cause a preflight refusal without partial writes", (t) => {
  const f = fixture(t);
  const existing = path.join(f.target, "graph-recall");
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, "SKILL.md"), "user customization");
  const result = cli(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists.*--force/);
  assert.equal(fs.readFileSync(path.join(existing, "SKILL.md"), "utf8"), "user customization");
  assert.deepEqual(fs.readdirSync(f.target), ["graph-recall"]);
});

test("explicit force backs up complete customized skill directories", (t) => {
  const f = fixture(t);
  assert.equal(cli(f).status, 0);
  fs.writeFileSync(path.join(f.target, "dream", "SKILL.md"), "custom dream");
  fs.mkdirSync(path.join(f.target, "dream", "private"));
  fs.writeFileSync(path.join(f.target, "dream", "private", "extra.txt"), "keep me");
  const result = cli(f, ["--force"]);
  assert.equal(result.status, 0, result.stderr);
  const backups = fs.readdirSync(f.target).filter((name) => name.startsWith(".dreamweave-backup-"));
  assert.equal(backups.length, 1);
  const backup = path.join(f.target, backups[0]);
  assert.equal(fs.readFileSync(path.join(backup, "dream", "SKILL.md"), "utf8"), "custom dream");
  assert.equal(fs.readFileSync(path.join(backup, "dream", "private", "extra.txt"), "utf8"), "keep me");
  assert.equal(fs.existsSync(path.join(backup, "graph-recall", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(f.target, "dream", "private")), false);
  assert.match(result.stdout, /Backup:/);
  assert.equal(cli(f, ["--force"]).status, 0);
  assert.equal(fs.readdirSync(f.target).filter((name) => name.startsWith(".dreamweave-backup-")).length, 2);
});
