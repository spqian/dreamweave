"use strict";

// Central path + tunable resolution for the agent-memory engine.
// EVERYTHING is environment-overridable so the package is portable across
// machines, OSes, and host agents (Scout, a plain CLI, CI, etc.).
//
//   AGENT_MEMORY_DIR   per-user data dir (db, model cache, rendered viz)   default: ~/.agent-memory
//   MEMORY_DB          path to the SQLite store                           default: <dataDir>/memory.db
//   MEMORY_VIZ         rendered explorer HTML output                      default: <dataDir>/memory-graph.html
//   MEMORY_MODEL_CACHE transformers.js model cache dir                    default: <dataDir>/model-cache
//   MEMORY_MODEL       embedding model id                                 default: Xenova/all-MiniLM-L6-v2
//   MEMORY_EMBED_DIM   embedding dimensionality                           default: 384

const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname);
const HOME = os.homedir();

const DATA_DIR = process.env.DREAM_MEMORY_DIR || process.env.AGENT_MEMORY_DIR || path.join(HOME, ".dream-memory");
const DB_PATH = process.env.MEMORY_DB || path.join(DATA_DIR, "memory.db");
const VIZ_OUT = process.env.MEMORY_VIZ || path.join(DATA_DIR, "memory-graph.html");
const MODEL_CACHE = process.env.MEMORY_MODEL_CACHE || path.join(DATA_DIR, "model-cache");

const VIZ_DIR = path.join(ROOT, "viz");
const VIZ_TEMPLATE = path.join(VIZ_DIR, "graph-store-visualization.html");
const VIZ_LIB = path.join(VIZ_DIR, "lib-3d-force-graph.min.js");

const MODEL = process.env.MEMORY_MODEL || "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = Number(process.env.MEMORY_EMBED_DIM || 384);

module.exports = {
  ROOT, HOME, DATA_DIR, DB_PATH, VIZ_OUT, MODEL_CACHE,
  VIZ_DIR, VIZ_TEMPLATE, VIZ_LIB, MODEL, EMBED_DIM,
};
