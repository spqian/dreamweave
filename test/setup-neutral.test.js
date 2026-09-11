"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.resolve(__dirname, "..");

// Exercise the actual bootstrap with real temporary filesystem/tuning. Only
// native DB/model boundaries are faked: this contract test needs no downloads.
async function bootstrap(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dreamweave-setup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home");
  const scout = path.join(home, ".copilot", "m-skills");
  fs.mkdirSync(scout, { recursive: true });
  const cfg = {
    ROOT: root, DATA_DIR: path.join(dir, "data"),
    DB_PATH: path.join(dir, "data", "memory.db"),
    MODEL: "test-fixture", MODEL_CACHE: path.join(dir, "cache"),
  };
  const events = [];
  const output = [];
  const tuningModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, "src/tuning.js"), "utf8"), {
    module: tuningModule,
    require: (id) => id === "../config" ? cfg : require(id),
    process: { env: {}, pid: process.pid },
  });
  class Database {
    constructor(file) { events.push(["db", file]); }
    pragma(value) { events.push(["pragma", value]); }
    prepare() { return { get: () => ({ c: 0 }) }; }
    close() { events.push(["close"]); }
  }
  const deps = {
    "./config": cfg, "./src/tuning": tuningModule.exports,
    "better-sqlite3": Database,
    "sqlite-vec": { load: () => events.push(["vec"]) },
    "./src/schema": { ensureSchema: () => events.push(["schema"]) },
    "./src/embed": { embedOne: async (text) => { events.push(["embed", text]); return [0, 1]; } },
    os: { homedir: () => home },
  };
  const localRequire = (id) => Object.hasOwn(deps, id) ? deps[id] : require(id);
  localRequire.resolve = (id) => id;
  await vm.runInNewContext(fs.readFileSync(path.join(root, "setup.js"), "utf8"), {
    require: localRequire,
    console: { log: (s) => output.push(s), error: (s) => output.push(s) },
    process: {
      env: { SCOUT_SKILLS_DIR: scout },
      stdout: { write: (s) => output.push(s) },
      exit: (code) => { throw new Error(`unexpected exit ${code}`); },
    },
  }, { filename: "setup.js" });
  return { cfg, scout, events, output: output.join("\n") };
}

test("shared bootstrap initializes data, schema, embedding and tuning", async (t) => {
  const { cfg, events, output } = await bootstrap(t);
  assert.equal(fs.statSync(cfg.DATA_DIR).isDirectory(), true);
  assert.deepEqual(events, [
    ["db", cfg.DB_PATH], ["vec"], ["pragma", "journal_mode = WAL"],
    ["schema"], ["close"], ["embed", "agent memory bootstrap"],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, "memory.config.json"), "utf8")).knobs, {
    retention: "preserve", capacity: "standard", forgetting: "natural", connections: "incremental",
  });
  assert.match(output, /Ready/);
});

test("shared bootstrap never installs host skills even with Scout configured", async (t) => {
  const { scout, output } = await bootstrap(t);
  assert.deepEqual(fs.readdirSync(scout), []);
  assert.doesNotMatch(output, /Restart Scout|skills installed into/);
});

test("shared bootstrap announces the four authoritative behavioral knobs", async (t) => {
  const { output } = await bootstrap(t);
  assert.match(output, /these are the 4 knobs/);
});

test("shared bootstrap directs host integration to the adapter router", async (t) => {
  const { output } = await bootstrap(t);
  assert.match(output, /INSTALL\.md.*adapter/);
  assert.doesNotMatch(output, /skills\/dream\/SKILL\.md/);
});
