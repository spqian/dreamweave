# agent-memory

Graph + vector long-term memory for AI agents — a drop-in replacement for the typical
"flat text + RAG" memory bank. It gives an agent a **durable, self-maintaining knowledge graph**
that a nightly **dream** pass consolidates (forget / merge / weave) and a **recall** path queries
with semantic vector search + graph expansion. Ships with a 3D **semantic nebula explorer** to
inspect the store.

Everything runs **locally and free**: SQLite (`better-sqlite3`) + `sqlite-vec` for the vector index,
and `@huggingface/transformers` for on-device embeddings (`all-MiniLM-L6-v2`, 384-dim). No API keys,
no network after the one-time model download.

---

## Why

Most agents store memory as a growing list of text snippets and retrieve with naive similarity.
That fails two ways at scale: the bank **grows unbounded** (blowing the context budget and diluting
attention), and facts sit **disconnected** (so retrieval can't hop between related facts). This
package fixes both:

- **FORGET** — a forgetting curve decays stale facts; noise evaporates, durable facts persist.
- **MERGE** — duplicate/over-lapping facts collapse into fewer, richer entries (count down, info kept).
- **WEAVE** — every surviving fact is connected into one graph via shared entities, so recall can
  traverse and attention can bind related facts.

The result is a small (~250-entry target), atomic, mostly-semantic, **fully connected** memory.

> **Design guideline:** the engine follows a **three-tier memory model** (instincts /
> RAG / bookshelf) with a few non-negotiable principles (embed-once, bounded nightly
> cost, demote-don't-delete, gist-for-attention/detail-for-recall). See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before making engine changes.

### Optional: LLM judgment layer

The engine runs fully on **local embeddings with zero API keys** — entity extraction is
self-bootstrapping (recurrence + case evidence, no seed/deny lists), and the bank stays bounded by
decay + deterministic eviction. That is the default, and it is portable and free.

Set **`DREAM_LLM`** to a small/cheap model spec to add a *judgment* layer a regex can't do — the same
role a person's sleeping brain plays, deciding what matters and what to fold together:

```
export DREAM_LLM=azure:gpt-5.4-mini     # or openai:gpt-4o-mini, anthropic:claude-...
```

- **Typed extraction + canonicalization** (`weave --llm`) — reads the real subjects of each fact,
  types them correctly (person/org/place/project/system), catches single-name principals, and folds
  aliases ("Jamie" → `person:jamie-chen`, "SF" → `place:san-francisco`) into one hub.
- **`reflect`** — the nightly judgment pass: **salience** (score each fact 0–2; only the rare critical
  ones are tagged to survive eviction and decay slowly — importance, not frequency) and **semantic
  merge** (roll up near-duplicate clusters into one richer fact, so the bank stays under cap by
  *consolidating* rather than blindly evicting).

The model is a **judge, not an author**: it never invents facts, only decides types, aliases, merges,
and importance over content the engine already holds. A mini model is the right tool. Every stage
degrades gracefully — no key, no problem; the mechanical path still runs.

---

## Architecture (one minute)

- **`memory.db`** (SQLite + `sqlite-vec`) is the durable source of truth and retrieval index.
- Two node kinds:
  - **fact** — an atomic memory (`kind='fact'`), carries a forgetting-curve `strength`, **projects
    back to your agent's memory bank**.
  - **entity** — a connector hub (`person:`/`team:`/`system:`/…), no decay, **never projects**;
    pure graph scaffolding that links facts so nothing is an island.
- A parallel `vec_nodes` (vec0, cosine, 384-dim) holds each node's embedding.
- The **host agent's memory bank is a disposable nightly projection** of the db. Daytime, the agent
  adds memories normally; the nightly **dream** ingests them, consolidates, and projects the curated
  set back.

```
  your agent's memories  ──dump──▶  snapshot.json
                                      │ ingest
                                      ▼
                                 memory.db  ──dream / weave / reflect / consolidate──▶  memory.db
                                      │ export-harness (diff)
                                      ▼
                          add/remove memories in the agent
```

---

## Install

Requirements: **Node ≥ 18** and a toolchain that can build `better-sqlite3` (prebuilt binaries cover
most platforms; otherwise you need Python + a C++ compiler).

```bash
cd agent-memory
npm install
npm run setup
```

`npm run setup` verifies dependencies, creates the data dir, initializes a fresh `memory.db` with the
full schema, and warms the embedding model (first run downloads ~90 MB once, then it's cached).

### Where data lives (all overridable)

| Env var | Default | What |
| --- | --- | --- |
| `AGENT_MEMORY_DIR` | `~/.agent-memory` | per-user data dir (db, model cache, rendered viz) |
| `MEMORY_DB` | `<dir>/memory.db` | the SQLite store |
| `MEMORY_VIZ` | `<dir>/memory-graph.html` | rendered 3D explorer output |
| `MEMORY_MODEL_CACHE` | `<dir>/model-cache` | embedding model weights |
| `MEMORY_MODEL` | `Xenova/all-MiniLM-L6-v2` | embedding model id |
| `MEMORY_EMBED_DIM` | `384` | embedding dimensionality (must match the model) |

To co-locate with a host agent's data dir, set `AGENT_MEMORY_DIR` to it (e.g. `~/.copilot/data`).

---

## Usage

### Recall (read path)

```bash
node lib/recall.js --query "who owns the gateway release" --max-hops 2
```

Returns semantic seeds (cosine similarity) plus a connected cluster (nodes + typed edges) for the
agent to ground an answer on. Drives the **`graph-recall`** skill.

### The nightly dream (maintenance path)

Run these in order (the **`dream`** skill orchestrates them with the host's memory tools):

```bash
# 1. WAKE: dump your agent's memories to snapshot.json  →  [{ id, fact, category }]
#    category ∈ decision (salient) | fact (semantic) | context (episodic) | preference

# 2. INGEST + verify (lossless, memory_id-keyed)
node src/dream.js ingest-harness --file snapshot.json
node src/dream.js verify-sync   --file snapshot.json   # exit 3 if any memory is missing

# 3. CONSOLIDATE: decay, reactivate, evaporate, housekeeping
node src/dream.js dream
node src/dream.js consolidate         # reports merge candidates (agent confirms)

# 4. WEAVE: connect every fact (guarantees zero islands)
node src/dream.js weave               # add --llm for typed extraction + alias canonicalization
node src/dream.js doctor              # health gate: exit 3 on islands/dangling edges

# 4b. REFLECT (optional, needs DREAM_LLM): salience tagging + semantic merge
node src/dream.js reflect

# 5. PROJECT: export the curated facts back to the agent's bank (apply the diff)
node src/dream.js export-harness

# 6. VIZ
node src/dream.js export-viz          # renders $MEMORY_VIZ
```

Helpers: `node src/dream.js stats` · `budget` (entry-count pressure + forecast) · `init` (just create
the db).

See **`skills/dream/SKILL.md`** for the full algorithm (strength model, schema-accelerated
consolidation, the ≤250-entry budget, salience rules) and **`skills/graph-recall/SKILL.md`** for the
recall contract. Those two files are the agent-facing instructions.

---

## The 3D explorer

`export-viz` renders a self-contained HTML explorer (`$MEMORY_VIZ`) plus its vendored engine next to
it. Open the file in any browser. Features: nodes laid out by **meaning** (PCA of the embeddings, so
the cloud fills space and semantically-similar memories cluster), color = fact class
(salient / semantic / episodic) with white balls for entity hubs, deep search over title+content,
click-to-focus with 2-hop pruning and a 3D "auto-dodge" that pushes irrelevant nodes out of view,
minimap, orbit controls, and smart auto-labeling. Append `?scoutTheme=dark` or `?scoutTheme=light`
to force a theme.

---

## Integrating with a host agent

The engine is **host-agnostic** — it only reads a snapshot JSON and writes an inject-ready export.
To wire it into an agent:

1. **Install the two skills.** Point your agent at `skills/dream/` and `skills/graph-recall/`
   (copy or symlink into wherever it loads skills from). They reference the engine as
   `node <AGENT_MEMORY>/lib/dream.js` / `lib/recall.js`.
2. **Map the memory tools.** The dream algorithm uses three host operations — *list all memories*,
   *add a memory*, *remove a memory*. Substitute your agent's equivalents (the SKILL.md uses Microsoft
   Scout's `m_list_memories` / `m_remember` / `m_forget` as the reference).
3. **Schedule it.** Run the nightly loop on a timer (cron / the agent's scheduler).
4. **Co-locate data** via `AGENT_MEMORY_DIR` if you want the store beside the agent's other state.

---

## Layout

```
agent-memory/
  config.js                 # env-overridable paths + model config
  setup.js                  # one-command bootstrap
  package.json
  lib/
    dream.js                # the consolidation engine (all subcommands)
    recall.js               # vector + graph recall (read path)
    embed.js                # local embeddings (transformers.js)
    entities.js             # entity extraction for the weave
    graphtext.js            # neighbor-naming text for embeddings
    schema.js               # fresh-db schema bootstrap
  viz/
    graph-store-visualization.html   # explorer template (empty data line)
    lib-3d-force-graph.min.js        # vendored 3D engine (MIT)
  skills/
    dream/SKILL.md          # nightly consolidation instructions (agent-facing)
    graph-recall/SKILL.md   # recall instructions (agent-facing)
```

---

## Licenses

MIT (this package). Bundled/declared dependencies: `3d-force-graph` (MIT), `better-sqlite3` (MIT),
`sqlite-vec` (MIT/Apache-2.0), `@huggingface/transformers` (Apache-2.0), and the
`all-MiniLM-L6-v2` model weights (Apache-2.0). Verify before redistribution.
