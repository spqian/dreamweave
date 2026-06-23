# Architecture & Design Principles

This document is the **design guideline** for dream-memory. It records the core
principles the engine must uphold. When in doubt, follow these; if a change violates
one, it needs an explicit, documented reason.

## The guiding model: human memory is TIERED

We do **not** try to keep every memory equally "live." That is biologically wrong and
computationally ruinous. Human memory is a hierarchy of stores with decreasing
activation and increasing capacity, and we mirror it with three tiers.

```
            cost / activation  ┃  capacity            mechanism
  ┌───────────────────────────╋──────────────────────────────────────────────┐
  │ TIER 1  "instincts"       ┃  ~500    injected every session; pure ATTENTION │
  │  (the projection)         ┃          over the text. No lookup. "Yes, I      │
  │                           ┃          know this." Gist only.                 │
  ├───────────────────────────╋──────────────────────────────────────────────┤
  │ TIER 2  "RAG class"       ┃  ~2500   graph + vector store. recall() does    │
  │  (the graph+vector DB)    ┃          vector KNN + GRAPH-NEIGHBOR expansion. │
  │                           ┃          Bounded, embed-once. The associative   │
  │                           ┃          recall layer.                          │
  ├───────────────────────────╋──────────────────────────────────────────────┤
  │ TIER 3  "the bookshelf"   ┃  ∞       raw fact dump. No embedding, no edges, │
  │  (the archive)            ┃          no nightly processing. KEYWORD search  │
  │                           ┃          only. "I know I read this somewhere —  │
  │                           ┃          let me dig." Slow but complete.        │
  └───────────────────────────┸──────────────────────────────────────────────┘
```

### Tier 1 — instincts (the projection, ~500)
The flat list injected into the agent's working set every session. Recall here is the
model's **attention** over the text — instant, no tool call. These are the *gist*
facts: standing policies, canonical entities, consolidated rollups. The 500-ish cap is
the **attention/context budget**, and it bounds **what we INJECT, not what we
REMEMBER.** Produced by `export-harness` (gist + unmerged; never `detail`/`archive`).

### Tier 2 — RAG class (the graph+vector DB, ~2500)
The bounded associative store that `recall` searches: vector KNN seeds → recursive
graph walk that **returns the seed's neighbors** (the whole point of a graph layer —
recall a fact and you recall what it connects to). Capped via `MEMORY_TIER2_MAX`
(default off; benchmark uses 2500). Over the cap, the weakest/oldest embedded facts are
**DEMOTED to Tier 3 — never deleted.** Salient and gist nodes are protected.

### Tier 3 — the bookshelf (the archive, uncapped)
Cold storage. A demoted fact keeps its raw text (`notes='archive'`) but **loses its
vector and its edges**, so it costs **zero** nightly work and is invisible to
vector/graph recall. It is reachable only by **brute-force keyword scan** in `recall`.
This is the "best-effort total knowledge base": inefficient, but nothing is ever truly
forgotten. When a specific question names a cold fact, the keyword tier surfaces it.

## Non-negotiable principles

1. **Pay the processing price ONCE.** A fact is embedded once (at ingest/weave) and its
   vector is stored. Nightly passes (weave, consolidate, supersede) **reuse the stored
   vector** (`queryVec`/`storedVecBlob`) — they must NOT re-embed the whole bank every
   night. MiniLM is deterministic, so the stored vector equals a fresh embed. Re-embed
   only genuinely new or changed text.

2. **Bounded nightly cost.** Per-night work must scale with *new* material, not with
   total store size. Tier 3 is excluded from every nightly loop; archived `detail` is
   excluded from salience/merge. The store can grow without the dream getting slower.

3. **Demote, don't delete (when retention is on).** Merge and cap-overflow MOVE facts
   down a tier; they do not destroy them. The cap on Tier 1 (and Tier 2) bounds
   activation, not knowledge. Deletion is reserved for true decay/eviction in
   single-tier (legacy) mode.

4. **Gist for attention, detail for recall.** A merge writes a `gist` survivor for the
   projection (Tier 1) and keeps the specific constituents as `detail` in Tier 2 (env
   `MEMORY_MERGE_KEEP`). Synthesis/"what's the policy" hits the gist; "what exactly did
   X commit to" retrieves the detail. Never let the gist *overwrite* the episode.

5. **Recall returns NEIGHBORS.** The graph layer exists so retrieval traverses: a hit
   pulls in its graph neighbors, not just itself. Don't reduce recall to flat vector
   top-k.

6. **Relevance order is primary in the injected context.** When rendering retrieved
   memories, rank by relevance (hops/strength). Do NOT globally reorder by time — an
   earlier experiment proved that starves pointed factual/synthesis questions. Temporal
   info is metadata (coarse, relative age tags), and sequence is carried by ordering the
   *episodic* facts within their tier, never by displacing relevance.

7. **No fabrication.** Consolidation/canonicalization may only assert what existing
   memories entail. The LLM judge decides types/aliases/merges/importance — it is a
   judge, not an author.

## Neuroscience grounding (why these tiers)

- **Complementary Learning Systems** (McClelland et al. 1995): a fast episodic store +
  a slow schematic store, reconciled by replay. Our Tier-2 `detail` ≈ episodic
  (verbatim), `gist` ≈ neocortical schema. Keep BOTH with different decay — do not let
  schema extraction erase the episode (that was our decision/synthesis regression).
- **Temporal Context Model** (Howard & Kahana): "when" is reconstructed from a drifting
  context (monotonic order + fuzzy distance), not a stored clock. Hence relative age
  tags + sequence, not timestamps as the load-bearing signal.
- **Sparse, capacity-bounded activation**: the brain bounds *interference and retrieval
  competition*, not raw storage. Tier 1/2 caps bound activation; Tier 3 is the
  effectively-unbounded substrate.

## Configuration summary

| Env / flag            | Meaning                                                |
|-----------------------|--------------------------------------------------------|
| `MEMORY_ENTRY_TARGET` | Tier-1 projection target (~250–500).                   |
| `MEMORY_ENTRY_MAX`    | Tier-1 hard cap (legacy single-tier eviction).         |
| `MEMORY_TIER2_MAX`    | Tier-2 (RAG) cap; overflow → Tier-3 archive. 0 = off.  |
| `MEMORY_MERGE_KEEP=1` | Non-destructive merge: keep `detail` constituents.     |
| `DREAM_LLM`           | Model spec for the judgment layer (typed extract,      |
|                       | canonicalization, salience, merge). Empty = mechanical.|
| `MEMORY_SUPERSEDE=1`  | Supersede-aware consolidation (corrections).           |

When adding features, state which tier they touch and which principle(s) they uphold.
