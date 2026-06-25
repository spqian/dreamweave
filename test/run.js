"use strict";
// Minimal test runner: execute every *.test.js in this folder, each as its own
// process (they manage their own tmp data dirs + env). Exit non-zero on any fail.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = __dirname;
const tests = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).sort();
let failed = 0;

for (const t of tests) {
  console.log(`\n──── ${t} ────`);
  try {
    execFileSync(process.execPath, [path.join(dir, t)], { stdio: "inherit" });
  } catch {
    failed += 1;
  }
}

console.log(`\n${tests.length - failed}/${tests.length} test files passed`);
process.exit(failed ? 1 : 0);
