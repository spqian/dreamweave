"use strict";

const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "viz", "graph-store-visualization.html"), "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc\b)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);

for (const script of scripts) new Function(script);

for (const id of ["edgeAlways", "edgeClick", "edgeHover"]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`missing ${id} edge control`);
}
if (!html.includes("edgeMode=rawLinks.length>1000?'hover':'always'")) {
  throw new Error("dense graphs must default to hover edges and small graphs to always-on edges");
}
if (!html.includes("elGraph.addEventListener('wheel',pointerDolly,{passive:false,capture:true})")) {
  throw new Error("pointer-centered wheel zoom is not installed");
}

console.log("PASS \u2713 visualization template compiles with adaptive edge modes");
