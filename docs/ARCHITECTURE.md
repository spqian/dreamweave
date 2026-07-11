# Architecture & Design Principles

> **Reading order:** [FIRST-PRINCIPLES](./FIRST-PRINCIPLES.md) (*why the system is shaped this
> way — the evidence-derived foundation, P0–P12*) → **ARCHITECTURE** (this doc — *the design that
> follows*) → [JOURNEY](./JOURNEY.md) (*the chronological path of decisions and their evidence*).
> The numbered principles below are the operational form of the first principles; each cross-refers
> to its Layer-1/2/3 origin.

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
  │ TIER 3  "the bookshelf"   ┃  ∞       raw fact dump + cold vector sidecar;   │
  │  (the archive)            ┃          no nightly graph processing. Bounded  │
  │                           ┃          vector/keyword/time lookup. "I read it"│
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
(default 2500 in the standard profile). Over the cap, the weakest/oldest embedded facts are
**DEMOTED to Tier 3 — never deleted.** Gists and high-salience-score facts are protected.

### Tier 3 — the bookshelf (the archive, uncapped)
Cold storage. A demoted fact keeps its raw text (`notes='archive'`) and moves its
embedding from `vec_nodes` to `vec_archive`; graph edges are removed, so it costs zero
nightly graph work. Recall reaches it through bounded cold-vector, keyword, explicit-date,
or gist→detail lookup. This is the "best-effort total knowledge base": slower than the
active graph, but nothing is truly forgotten.

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
   projection (Tier 1) and **always** keeps every constituent — including the survivor's
   own pre-merge verbatim — as `detail` in Tier 2 (non-destructive by invariant, not a
   flag). Synthesis/"what's the policy" hits the gist; "what exactly did X commit to"
   retrieves the detail. The gist never *overwrites* an episode.

5. **Recall returns NEIGHBORS — this is how we aid SYNTHESIS.** The graph layer exists
   so retrieval traverses: a hit pulls in its graph neighbors (shared-entity facts,
   related/supersede chains, the gist↔detail link), not just itself. `recall` /
   `m_recall` must surface this connected cluster, because synthesis questions ("how did
   X evolve", "what stayed constant across Y") are answered by *assembling related
   memories*, not by one top-k vector hit. A flat vector top-k that drops neighbors will
   fail synthesis. (Empirically, the synthesis category is won by the breadth of the
   recalled neighborhood, not by any single fact's rank.)

6. **Relevance order is primary in the injected RETRIEVAL context.** When rendering
   retrieved memories for an answer, rank by relevance (hops/strength). Do NOT globally
   reorder that context by time — an experiment proved a global gist-then-timeline
   reorder *starves* pointed factual/synthesis questions of their best evidence
   (factual −0.6 n=73, synthesis −0.8 n=19). Temporal info rides as metadata, not as a
   reordering of the retrieval result.

7. **No fabrication.** Consolidation/canonicalization may only assert what existing
   memories entail. The LLM judge decides types/aliases/merges/importance — it is a
   judge, not an author.

8. **Merge with TEMPORAL SEQUENCING — the Tier-1 "instincts" are sequence-aware.** Two
   parts:
   - **Within the projection:** the injected gist list is laid out so the *episodic*
     (dated) facts carry their order — Tier 1 is not a bag of timeless statements, it is
     sequence-aware, so "what's current / what came before what" is legible from the
     instincts alone (without a lookup). Order the episodic tier chronologically; gist
     schema facts are timeless. Carry coarse, *relative* age (the brain reconstructs
     "when" from order + fuzzy distance, not a stored clock) — never a precise timestamp
     as the load-bearing signal.
   - **Within merge:** consolidation must PRESERVE the temporal sequence it summarizes.
     A merge that collapses a multi-day evolution ("$510M → $480M → $465M") into one
     timeless blob destroys the answer to "how did it change" and "what's the latest".
     The gist may summarize, but the dated constituents survive as `detail` (principle
     4) so the sequence is recoverable. Never let a merge erase *when*.

   Guardrail (learned the hard way): sequence-awareness lives in the **projection layout
   and the retained detail**, NOT in reordering the retrieval context (see principle 6).
   The two are different surfaces; don't conflate them.

9. **Seeds rank by ACTIVATION (cosine ⊕ strength), not cosine alone.** The vector-KNN
   seeds that enter recall's top-K are scored by semantic match **combined with base-level
   activation** (`strength`), not raw cosine. `strength` is the engine's ACT-R base-level
   activation — nightly **decay** (`strength·2^(−Δt/H)`, dream.js:411) + **reactivation**
   boosts (dream.js:464) already fuse *recency × frequency × schema* — so ranking on cosine
   alone discards the very signal the dream spends the whole run computing. Use
   `activation = cosine + λ·strength`, **cosine-dominant** (bounded λ). This rescues a
   buried, high-activation *consolidated* state into the window — the q286 failure was a
   str-0.697 recent answer gist stranded at **rank 52** while a str-0.001 stale restatement
   took the top-3 — after which principle-5 neighbor/chain expansion surfaces its lineage.
   **This is distinct from principle 6:** it is *seed selection by relevance-incl-strength*
   (which principle 6 explicitly names), **not** a global time-reorder of the rendered
   context (that experiment regressed). It uses activation, **not a clock** — explicit-date
   queries still route through the time-window tier, so old-dated-fact recall is unaffected
   by decay. Bound λ so a strong *off-topic* fact can never outrank a strongly on-topic one;
   validate across factual/temporal/contradiction, not just synthesis, before shipping.

10. **Date-anchored recall reconstructs from the DATE, not just the topic.** A dated query
    ("what was on file by 2026-01-14", "how did X evolve May 27–29") names a *time*, and the
    answer is often a specific active record whose exact-date snapshot carries *lower* cosine
    than the abstract gist that paraphrases it — so pure vector-KNN never reaches it. When the
    query bears explicit date intent, recall pulls active facts whose `first_seen` falls in the
    window (term-gated, bounded, text-deduped so distinct dated records survive scope-collapse)
    and scores them by cosine + a bounded date bonus, so the on-date record surfaces. This is
    *reconstructive temporal navigation entered from the semantic anchor* — it fires ONLY on
    date intent, so timeless standing-preference queries (the recency-bias guards) are untouched.
    Combined with the cold-bookshelf time-window tier, this is how "I've seen this on that date"
    recall works without a calendar subsystem.

11. **Event time and processing time are different clocks.** `first_seen` records when the
    remembered event occurred and must remain stable for timeline recall. Incremental eligibility
    uses engine-owned monotonic revisions (`change_seq`, `ingested_seq`, `dirty_seq`) and stage
    cursors (`last_*_seq`). A backdated fact ingested today is old in the timeline but new work for
    every maintenance stage. Never use `first_seen` as a processing watermark.

12. **Salience is continuous importance, not a durability class.** Every harness fact enters
    `class='episodic'`; reactivation may earn `class='semantic'`. Only the nightly caller-judged
    salience surface sets `salience_score ∈ [0,1]`, which continuously extends half-life and marks
    scores ≥0.5 for protection/display. The engine never creates `class='salient'`.

Single optimal path: recall features are unconditional — no env feature-flags gate real
behavior (they are wired on, tuned by validated in-code constants). Only the durable
capacity/retention knobs in the table below are configurable.

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
| `MEMORY_SUPERSEDE=1`  | Supersede-aware consolidation (corrections).           |

When adding features, state which tier they touch and which principle(s) they uphold.

## Experiment log (Recall Bench, EA persona, Azure gpt-5.4-mini judge, sample=6)

Evidence behind the principles. Scores are /6 overall at the 30/90/180-day checkpoints.

| Variant                                   | 30d  | 90d  | 180d | Verdict |
|-------------------------------------------|------|------|------|---------|
| baseline (mechanical dream, 500-cap)      | 5.13 | 5.15 | 4.90 | —       |
| **+ reflect (LLM salience + merge)**      | 5.36 | 5.21 | 5.01 | **champion** |
| + CLS context reorder (gist+timeline)     | 5.29 | 4.80 | 4.66 | REGRESSION — reordered away from relevance; starved factual(−0.6,n73)/synthesis(−0.8,n19). → principle 6 |
| + temporal age tags (relevance kept)      | 5.24 | 5.03 | 4.95 | wash — tags as metadata are ~neutral; recency is only ~3.5% of Qs |
| + retain-detail / 3-tier (full weave)     | 5.38 | —    | —    | ties champion at 30d; full O(N) weave stalled (~21 h/180d) → moved to incremental |
| **+ 3-tier, INCREMENTAL weave**           | **5.64** | **5.58** | **5.46** | **NEW CHAMPION** — beats reflect at every horizon (+0.28 / +0.37 / +0.45), and the margin *grows* with distance |

The incremental three-tier run is the new champion. The win is concentrated exactly where
the diagnosis predicted: **decision-tracking 5.71 at 180d (n=21)** — the category that had
been collapsing to "no record" — and synthesis holds at 4.89 (n=19) aided by recall
returning graph neighbors. Hallucination stays low (4.4 / 4.9 / 8.3%). Cost is bounded:
incremental weave touches only new/dirty facts (~30/night vs full's ~1389), so the run that
was infeasible at full-weave O(N) finished end-to-end. The growing margin at 90d/180d is the
point — retain-detail + demote-don't-delete pays off most at long range, where the old
500-cap had been deleting the answers.

Key diagnoses from the question logs:
- **Decision-tracking & synthesis failures were DELETIONS, not retrieval misses.** The
  exact answers existed in the corpus (e.g. day-30 "same-week resolution plan plus
  weekly executive sponsor reviews") but aggressive merge + the hard 500-cap had
  *removed* them before the day-180 query — so even a full-DB recall returned "no
  record". → principles 3 (demote-don't-delete) & 4 (keep detail).
- **Reflect's merge lifted synthesis over baseline** (gist kills redundancy) **but the
  same merge hurt decision/recency** by collapsing distinct dated states. → principle 8
  (merge must preserve temporal sequence; keep the dated detail).
- **The 500-cap is faithful to what Scout INJECTS, not what our side DB must REMEMBER.**
  Conflating the two caused the deletions. → the whole three-tier split.
- **q286 (synthesis) proved a pure RANKING failure — not a recall or consolidation miss.**
  On a deterministically-rebuilt 180d store the answer was fully present and correctly
  consolidated (a str-0.697 *recent* gist "protect the operating review; move the more
  flexible adjacent internal item", sitting on a 16-node Apr→Jun sequence/supersedes
  delta-chain) yet lost the top-K to a str-0.001 *stale* restatement singleton because
  seeds ranked by pure cosine — the answer gist sat at rank 52. Every pointed
  single-instance question on the identical topic scored 6. `strength` (ACT-R base-level
  activation: nightly decay + reactivation) was computed but discarded at read time.
  → principle 9 (rank seeds by activation = cosine ⊕ strength).

Resolved by the incremental run: the embedded (Tier-2) set stays bounded — demotion holds
the cap (active plateaus ~2500, archive grows free at zero nightly cost), and incremental
weave keeps per-night work flat instead of O(N). Residual follow-up: the graph-maintenance
passes (island-scan / degree map / repair) still walk all edges nightly, so pace degrades
mildly as the bank fills (~0.33→0.17 days/min past the cap). Flattening those to incremental
is the next cost optimization — not correctness-critical, the cap itself is firmly bounded.
