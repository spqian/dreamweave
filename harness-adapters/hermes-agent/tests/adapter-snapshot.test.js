"use strict";
// Filesystem-only adapter regressions: no engine, database, network or model calls.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const adapter = path.resolve(__dirname, "../scripts/adapter-snapshot.js");

function manifest(f, records) {
  fs.writeFileSync(`${f.memory}.projection.json`, JSON.stringify({
    version: 1, memory_file: f.memory, records,
    displays: records.map((r) => r.display || r.fact),
  }));
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dream-adapter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = path.join(dir, "MEMORY.md");
  const output = path.join(dir, "snapshot.json");
  const daily = path.join(dir, "daily");
  fs.mkdirSync(daily);
  const env = { PATH: process.env.PATH, HOME: dir, HARNESS_MEMORY_DIR: dir,
    HARNESS_MEMORY_FORMAT: "hermes", HARNESS_DAILY_MEMORY_DIR: daily };
  function run(extra = {}) {
    const result = spawnSync(process.execPath, [adapter, output], {
      env: { ...env, ...extra }, encoding: "utf8",
    });
    return { ...result, items: result.status === 0 ? JSON.parse(fs.readFileSync(output, "utf8")) : null };
  }
  function ok(extra) {
    const result = run(extra);
    assert.equal(result.status, 0, result.stderr);
    return result.items;
  }
  return { dir, memory, output, daily, env, run, ok };
}

test("reordering cards does not change observation identities", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.memory, "Alpha observation\n§\nBeta observation\n");
  const before = new Map(f.ok().map((r) => [r.fact, r.id]));
  fs.writeFileSync(f.memory, "Beta observation\n§\nAlpha observation\n");
  for (const r of f.ok()) assert.equal(r.id, before.get(r.fact));
});

test("unchanged projections are excluded but newly added cards remain", (t) => {
  const f = fixture(t);
  const records = [{ signature: "fact-a", fact: "Known fact", display: "[recent] Known fact" },
    { signature: "gist-a", fact: "Standing policy\n\nDetail", display: "Standing policy\n\nDetail" }];
  manifest(f, records);
  fs.writeFileSync(f.memory, records.map((r) => r.display).join("\n§\n"));
  assert.deepEqual(f.ok(), []);
  fs.appendFileSync(f.memory, "\n§\nNew observation");
  assert.deepEqual(f.ok().map((r) => r.fact), ["New observation"]);
});

test("invalid manifests fail closed without replacing a prior snapshot", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.memory, "New observation");
  const prior = "[{\"id\":\"prior\",\"fact\":\"saved\"}]";
  for (const bad of [JSON.stringify({ version: 99, memory_file: f.memory, records: [], displays: [] }),
    "{broken", JSON.stringify({ version: 1, memory_file: "/wrong/MEMORY.md", records: [], displays: [] }),
    JSON.stringify({ version: 1, memory_file: f.memory, records: [], displays: ["New observation"] })]) {
    fs.writeFileSync(f.output, prior);
    fs.writeFileSync(`${f.memory}.projection.json`, bad);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.output, "utf8"), prior);
  }
});

test("changed raw observations get new IDs without overwriting older facts", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.memory, "Meeting Tuesday");
  const before = f.ok()[0];
  manifest(f, [{ fact: before.fact, display: before.fact }]);
  fs.writeFileSync(f.memory, "Meeting Wednesday");
  const after = f.ok()[0];
  assert.equal(after.fact, "Meeting Wednesday");
  assert.notEqual(after.id, before.id);
});

test("daily observations take their date from the filename, not mtime", (t) => {
  const f = fixture(t);
  const file = path.join(f.daily, "2024-02-29.md");
  fs.writeFileSync(file, "Historical observation\n\nSecond observation");
  fs.utimesSync(file, new Date("2026-09-10"), new Date("2026-09-10"));
  const items = f.ok();
  assert.equal(items.length, 2);
  for (const r of items) assert.equal(r.createdAt, "2024-02-29T00:00:00.000Z");
});

test("daily scan excludes legacy scratch exports and invalid dates", (t) => {
  const f = fixture(t);
  for (const name of ["scratch.md", "MEMORY.md", "2026-09-10-extra.md", "2025-02-29.md", "2026-13-01.md"])
    fs.writeFileSync(path.join(f.daily, name), "Must not ingest");
  fs.writeFileSync(path.join(f.daily, "2026-09-10.md"), "Valid dated observation");
  assert.deepEqual(f.ok().map((r) => r.fact), ["Valid dated observation"]);
});

test("multiple daily directories retain separate stable source identities", (t) => {
  const f = fixture(t);
  const other = path.join(f.dir, "other");
  fs.mkdirSync(other);
  for (const dir of [f.daily, other]) fs.writeFileSync(path.join(dir, "2026-09-10.md"), "Same words");
  const run = (dirs) => f.ok({ HARNESS_DAILY_MEMORY_DIRS: JSON.stringify(dirs) });
  const before = run([f.daily, other]);
  assert.equal(before.length, 2);
  assert.equal(new Set(before.map((r) => r.id)).size, 2);
  assert.equal(new Set(before.map((r) => r.source)).size, 2);
  assert.deepEqual(new Set(run([other, f.daily]).map((r) => r.id)), new Set(before.map((r) => r.id)));
});

test("missing explicit daily sources and malformed directory lists fail closed", (t) => {
  const f = fixture(t);
  const missing = path.join(f.dir, "missing");
  for (const env of [{ HARNESS_DAILY_MEMORY_DIR: missing },
    { HARNESS_DAILY_MEMORY_DIRS: JSON.stringify([f.daily, missing]) },
    { HARNESS_DAILY_MEMORY_DIRS: "[]" }, { HARNESS_DAILY_MEMORY_DIRS: "[1]" }]) {
    assert.notEqual(f.run(env).status, 0);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test("cold start skips and flags unmatched rendered wrappers, preserving raw observations", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.memory, ["[SEMANTIC MEMORY · policy]\nDerived summary\n\nIts evidence",
    "[TEMPORAL MEMORY · week]\nDerived timeline", "[memory-usage] Engine anchor",
    "[long ago] Old rendered episode", "New raw observation"].join("\n§\n"));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.items.map((r) => r.fact), ["New raw observation"]);
  assert.match(result.stderr, /Skipped unmatched projection wrapper/);
  assert.match(result.stderr, /manifest missing/i);
});

test("cold-start exact matching can use a frozen export without opening the engine DB", (t) => {
  const f = fixture(t);
  const exported = path.join(f.dir, "frozen-export.json");
  fs.writeFileSync(exported, JSON.stringify([{ fact: "Known plain gist", display: "Known plain gist" }]));
  fs.writeFileSync(f.memory, "Known plain gist\n§\nNew observation");
  assert.deepEqual(f.ok({ HARNESS_PROJECTION_EXPORT_FILE: exported }).map((r) => r.fact), ["New observation"]);
  fs.writeFileSync(exported, "{}");
  assert.notEqual(f.run({ HARNESS_PROJECTION_EXPORT_FILE: exported }).status, 0);
});

// Real projection/next-snapshot roundtrip is covered in test_dreamweave_harness.py.

test("a missing configured daily directory fails closed", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, "dreamweave-adapter.json"), JSON.stringify({
    version: 1, daily_dir: path.join(f.dir, "missing-daily")
  }));
  const result = spawnSync(process.execPath, [adapter, f.output], {
    env: { PATH: process.env.PATH, HOME: f.dir, HERMES_HOME: f.dir }, encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.output), false);
});

test("standalone snapshot uses the selected Hermes profile config", (t) => {
  const f = fixture(t);
  const home = path.join(f.dir, "profile");
  fs.mkdirSync(path.join(home, "memories"), { recursive: true });
  fs.writeFileSync(path.join(home, "memories/MEMORY.md"), "Profile observation\n\nDetail");
  fs.writeFileSync(path.join(f.daily, "2024-01-02.md"), "Daily observation");
  fs.writeFileSync(path.join(home, "dreamweave-adapter.json"), JSON.stringify({
    version: 1, daily_dir: f.daily, engine: path.join(f.dir, "unused-engine")
  }));
  const result = spawnSync(process.execPath, [adapter, f.output], {
    env: { PATH: process.env.PATH, HOME: f.dir, HERMES_HOME: home }, encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const items = JSON.parse(fs.readFileSync(f.output, "utf8"));
  assert.deepEqual(items.map((r) => r.fact), ["Profile observation\n\nDetail", "Daily observation"]);
});

test("section-sign cards retain internal blank lines, even a single Hermes card", (t) => {
  const f = fixture(t);
  const card = "Alpha observation\n\nSupporting detail";
  for (const content of [card, `${card}\n§\nBeta observation`]) {
    fs.writeFileSync(f.memory, content);
    assert.equal(f.ok()[0].fact, card);
  }
});
