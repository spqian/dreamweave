"use strict";

// Shared local embedding helper for the memory graph+vector store.
// Fully local & free: transformers.js with all-MiniLM-L6-v2 (384-dim, normalized).
// Model + dims + cache dir are configurable via config.js / environment.

const cfg = require("../config");

const MODEL = cfg.MODEL;
const DIMS = cfg.EMBED_DIM;

let _extractor = null;

async function getExtractor() {
  if (_extractor) return _extractor;
  // transformers.js ships an ESM build; resolve the installed package main, then
  // import the node ESM entry from the same dist dir (version/filename tolerant).
  const fs = require("fs");
  const path = require("path");
  const main = require.resolve("@huggingface/transformers"); // .../dist/transformers.node.cjs|mjs
  const distDir = path.dirname(main);
  const candidates = [
    path.join(distDir, "transformers.node.mjs"),
    path.join(distDir, "transformers.mjs"),
    main,
  ];
  const entry = candidates.find((p) => fs.existsSync(p)) || main;
  const url = require("url").pathToFileURL(entry).href;
  const { pipeline, env } = await import(url);
  // Cache model weights under the per-user data dir so we never re-download.
  env.cacheDir = cfg.MODEL_CACHE;
  _extractor = await pipeline("feature-extraction", MODEL);
  return _extractor;
}

// Embed an array of strings -> array of Float32Array(DIMS).
async function embedTexts(texts) {
  if (!texts.length) return [];
  const ex = await getExtractor();
  const out = [];
  const batchSize = 32;
  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize).map((t) => t || "");
    const res = await ex(batch, { pooling: "mean", normalize: true });
    const data = res.data;
    if (!data || data.length !== batch.length * DIMS) {
      throw new Error(`embedding shape mismatch: expected ${batch.length}x${DIMS}, got ${res.dims || (data && data.length) || "unknown"}`);
    }
    for (let i = 0; i < batch.length; i += 1) {
      out.push(Float32Array.from(data.subarray(i * DIMS, (i + 1) * DIMS)));
    }
  }
  return out;
}

async function embedOne(text) {
  return (await embedTexts([text]))[0];
}

// Pack a Float32Array into the bytes sqlite-vec expects.
function toVecBlob(floatArr) {
  return new Uint8Array(floatArr.buffer.slice(0));
}

module.exports = { getExtractor, embedTexts, embedOne, toVecBlob, DIMS, MODEL };
