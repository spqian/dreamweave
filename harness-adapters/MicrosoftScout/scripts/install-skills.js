"use strict";

// Microsoft Scout host wiring only. Run `npm run setup` in the repository root
// first for shared dependency checks, database, embedding cache and tuning.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ENGINE_ROOT = path.resolve(__dirname, "../../..");
const SKILLS = ["dream", "graph-recall"];

function resolveProspectivePath(target) {
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    const entry = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (entry) return path.join(fs.realpathSync(cursor), ...missing);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve install target: ${target}`);
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function assertOutsideSource(sourceRoot, target) {
  const relative = path.relative(sourceRoot, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))) {
    throw new Error("The install target must not be inside the package's source skills directory");
  }
}

function installSkills({
  target = process.env.SCOUT_SKILLS_DIR, home = os.homedir(),
  engineRoot = ENGINE_ROOT, force = false,
} = {}) {
  // Legacy Scout discovery lives here, never in the shared engine bootstrap.
  if (!target) {
    const parents = [path.join(home, ".copilot"), path.join(home, ".scout")];
    target = parents.map((parent) => path.join(parent, "m-skills")).find((dir) => fs.existsSync(dir));
    if (!target) {
      const parent = parents.find((dir) => fs.existsSync(dir));
      if (parent) target = path.join(parent, "m-skills");
    }
  }
  if (!target) throw new Error("no ~/.copilot or ~/.scout directory found; set SCOUT_SKILLS_DIR to the intended Microsoft Scout skills directory");
  let dir = resolveProspectivePath(target);
  const engine = path.resolve(engineRoot).replace(/\\/g, "/");
  const sourceRoot = fs.realpathSync(path.join(engineRoot, "harness-adapters/MicrosoftScout/skills"));
  assertOutsideSource(sourceRoot, dir);
  // Check every destination before writing either skill.
  const existing = SKILLS.filter((skill) => fs.lstatSync(path.join(dir, skill), { throwIfNoEntry: false }));
  if (existing.length && !force) {
    throw new Error(`${path.join(dir, existing[0])} already exists; review customizations before using --force`);
  }
  // Read every shipped file before changing destinations, so an incomplete
  // package cannot displace a working customized installation.
  const bundles = SKILLS.map((skill) => {
    const source = path.join(sourceRoot, skill);
    const files = fs.readdirSync(source).map((name) => {
      let content = fs.readFileSync(path.join(source, name));
      if (name.toLowerCase().endsWith(".md")) {
        content = content.toString("utf8").split("<AGENT_MEMORY>").join(engine);
      }
      return { name, content };
    });
    return { skill, files };
  });
  fs.mkdirSync(dir, { recursive: true });
  dir = fs.realpathSync(dir);
  assertOutsideSource(sourceRoot, dir);
  let backup = null;
  if (existing.length) {
    backup = fs.mkdtempSync(path.join(dir, ".dreamweave-backup-"));
    for (const skill of existing) fs.renameSync(path.join(dir, skill), path.join(backup, skill));
  }
  for (const { skill, files } of bundles) {
    const destination = path.join(dir, skill);
    fs.mkdirSync(destination);
    for (const { name, content } of files) {
      fs.writeFileSync(path.join(destination, name), content, { flag: "wx" });
    }
  }
  return { installed: true, dir, names: [...SKILLS], backup };
}

module.exports = { installSkills };

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const unknown = args.find((arg) => !["--force", "--help"].includes(arg));
    if (unknown) throw new Error("Unknown argument: " + unknown);
    if (args.includes("--help")) {
      console.log("Usage: node harness-adapters/MicrosoftScout/scripts/install-skills.js [--force]");
      console.log("Run npm run setup from the repository root first. SCOUT_SKILLS_DIR overrides Scout discovery.");
      console.log("Existing skills are refused unless --force is explicit; --force moves them to a unique backup directory.");
    } else {
      const result = installSkills({ force: args.includes("--force") });
      if (result.backup) console.log("Backup: " + result.backup);
      console.log(`Microsoft Scout skills installed into ${result.dir}: ${result.names.join(", ")}`);
      console.log("Restart Microsoft Scout to load the skills; complete the four-knob interview in harness-adapters/MicrosoftScout/install.md.");
    }
  } catch (error) {
    console.error("SCOUT INSTALL ERROR: " + error.message);
    process.exitCode = 1;
  }
}
