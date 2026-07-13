"use strict";

// Direct object injection must reach the entity-hub embedding renderer, not only
// extraction/query parsing. Module-path plugins already flow through the process
// environment; this guards the separate in-process injection contract.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-langsvc-reembed-"));
const dreamCli = path.join(__dirname, "..", "src", "dream.js");
execFileSync(process.execPath, [dreamCli, "init"], {
  env: { ...process.env, AGENT_MEMORY_DIR: dataDir },
  encoding: "utf8",
});

const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const English = require("../src/langsvc.English");
const { applyEntities } = require("../src/dream");

let renderCalls = 0;
const injected = {
  ...English,
  id: "render-probe",
  renderNodeText(sig, edges) {
    renderCalls += 1;
    return `PLUGIN<${sig}>:${edges.length}`;
  },
};

(async () => {
  let ok = true;
  const fail = (message) => { console.error("FAIL:", message); ok = false; };
  const db = new Database(path.join(dataDir, "memory.db"));
  sqliteVec.load(db);
  try {
    const result = await applyEntities(db, [{
      sig: "topic:render-probe",
      type: "topic",
      forms: ["render probe"],
    }], {
      asOf: "2026-01-05T00:00:00.000Z",
      languageService: injected,
    });
    if (!result.complete || result.created !== 1) fail(`entity apply failed: ${JSON.stringify(result)}`);
    if (renderCalls < 1) fail("directly injected renderNodeText was not called during hub re-embedding");

    const hub = db.prepare("SELECT text FROM nodes WHERE signature='topic:render-probe'").get();
    if (!hub || hub.text !== "render probe") fail(`hub forms were overwritten during re-embedding: ${JSON.stringify(hub)}`);
  } finally {
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(ok
    ? "PASS \u2713 direct language-service injection reaches hub re-embedding"
    : "\nFAILED \u2717 direct language-service re-embedding contract violated");
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error(error);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
});
