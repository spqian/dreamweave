# Dreamweave — The Journey

> **Reading order:** [FIRST-PRINCIPLES](./FIRST-PRINCIPLES.md) →
> [ARCHITECTURE](./ARCHITECTURE.md) → **JOURNEY** (this doc).

This is the causal record of how the engine reached its current shape. Every decision is traced to the
**evidence that motivated it** and the **outcome that followed** — including the paths we tried and
**abandoned**, so the reasons we do *not* do certain things are never lost. Phases map to the 38
session checkpoints (`checkpoints/index.md`). Scores are the Recall Bench (EA persona, Azure
gpt-5.4-mini judge) overall /6 unless noted.

---

## Phase 1 — The temporal/supersede ranking bug (ckpt 1–2)
**Motivation.** Recall surfaced stale/superseded facts that outranked the correct current version;
both were retrieved, but the wrong one ranked top. This is the seed of the whole temporal thread.
**Decision.** Fixed supersede-aware ranking so a corrected value demotes (not deletes) its predecessor;
stood up the 500d dreamweave benchmark to measure at scale.
**Outcome.** Confirmed a real recall-ranking gap and gave us a measurement harness. The framing that
stuck: *the answer is often present but mis-ranked* — a theme that recurs to the very end (q286, q024).

## Phase 2 — Detail-recall gap: the DELETION insight (ckpt 3–5)
**Motivation.** Decision-tracking and synthesis were collapsing to "no record." Inspection of the
question logs showed the exact answers (e.g. day-30 "same-week resolution plan plus weekly executive
sponsor reviews") had *existed* in the corpus but were **gone** by the day-180 query — even a full-DB
recall returned nothing.
**Decision.** Diagnosed the cause as **aggressive merge + a hard 500-cap DELETING facts** before they
were queried. This motivated the core architectural move: the 500-cap is faithful to what the agent
*injects*, not what the side-DB must *remember*. → three tiers, **demote-don't-delete**.
**Outcome / lesson.** Many "recall misses" were **deletions**, not retrieval failures (→ principles 3
& 4). The v2 run was killed once the smoking gun was found: duplicated `detail` expansion flooded the
top-K, displacing the answer fact.

## Phase 3 — v3 regressions & hybrid lexical recall (ckpt 6–7)
**Motivation.** A v3 change regressed on pointed factual/standing-rule questions (pre-demotion
displacement).
**Decision.** Added a hybrid lexical pass to rescue exact-term hits the vector pass buried.
**Outcome.** Recovered the displaced pointed facts without reintroducing the flood.

## Phase 4 — Temporal weakness is partly a CORPUS artifact (ckpt 8–9)
**Motivation.** Temporal-reasoning was the worst category (~3.0 mean vs next-worst decision-tracking
4.10). We needed to know if this was the engine or the fixture.
**Decision.** Drilled every weak category to root cause.
**Outcome.** Temporal weakness was *partly* a corpus/fixture artifact and *partly* retrieval — a
distinction that later saved us from over-fitting the engine to a broken benchmark (Phase 12).

## Phase 5 — 500d parity, archive-vector sidecar (ckpt 10–12)
**Motivation.** Demoted (cold) facts had no retrieval path; a specific question naming a cold fact
could never reach it.
**Decision.** Added the **archive-vector similarity sidecar** — cold facts stay reachable by
deliberate similarity lookup without re-entering the hot KNN path (→ P8/P9).
**Outcome.** Archive recall became safe and score-neutral (it doesn't win points, it prevents losses).
Validated on a 150d A/B.

## Phase 6 — Nightly-cost superlinearity: bounded nightly work (ckpt 13–15)
**Motivation.** A full O(N) weave stalled at **~21 h/180d** — infeasible for 500 nights. Profiling
(`MEMORY_PROFILE`) found the cost grew with *total days*, not the capped active set: `ingest.refreshLoop`
re-`UPDATE`d **every** harness memory each night (16,708 no-op writes = 11.3 s at day300); `decayEdges`
multiplied mention/supersede weights by ×1.0 (identity writes); `canonicalizeLLM` sent *all* hubs each
time.
**Decision.** **Delta-scoped nightly** (accuracy-neutral, bit-identical output minus no-op writes): skip
no-op refresh writes, decay only sub-1.0 edge types, send only new+candidate hubs to canonicalize,
compute `degreeMap` once. Moved to **incremental weave** (touch only new/dirty facts, ~30/night vs
full's ~1389).
**Outcome.** The run that was infeasible at full-weave finished end-to-end (→ principles 1 & 2). The
incremental three-tier run became the **champion: 5.64 / 5.58 / 5.46 at 30/90/180d**, beating reflect at
every horizon with a margin that *grows* with distance — exactly where demote-don't-delete pays off.
**Lesson.** The 50k-decouple idea was reframed: the real cost driver was **entity-graph densification &
no-op writes**, not the fact count.

## Phase 7 — Temporal narrative synthesis + weave fixes (ckpt 16–17)
**Motivation.** "How did X change" still failed even with facts present.
**Decision.** Built a temporal-narrative synthesis pass and weave fixes.
**Outcome.** Partial help; set up the deeper root-cause work that followed.

## Phase 8 — Root-cause: LOCALIZATION vs REACHABILITY (ckpt 18–21)
**Motivation.** Temporal was still weak; we needed the *exact* failure mechanism, not a hypothesis.
**Decision.** Offline forensics on the 500d store (25,635 facts, 22,972 seq edges) over 30 unique
temporal questions, measuring "does the gold chain appear in retrieval."
**Outcome (measured).**
- It's a **REACHABILITY** problem, not ranking: raising K 15→40 gave *identical* reach — the chain
  simply wasn't in the cluster.
- **The 4-seed graph funnel was LOSING reach**: 30% chain-reach vs **47% for raw cosine top-15**. The
  funnel discarded cosine hits 5..15. Fix: widen to `seedLimit=max(12,k)`, `nodeLimit=max(200,8k)` →
  end-to-end chain-reach 30%→40%, no regressions.
- **Lexical/BM25 seeds are WORSE than cosine** (13% vs 40%) — the delta fact resembles dozens of daily
  restatements, so no query→single-fact match can pinpoint it. The retrieval *target* must be the
  CHAIN, then chronological traversal exposes the transition.

## Phase 9 — Sequence-edge temporal recall, corpus-independent, cohesion-gated (ckpt 22–27)
**Motivation.** From Phase 8: reach the topic, then present its versions chronologically.
**Decision.** Sequence edges linking a statement's evolving versions; recall completes the chain and
orders it. Made the sequence rule **corpus-independent** (no bench-specific day0 in the engine — "day N"
parsing lives in the adapter). Added a **cohesion gate** (chain members must share ≥2 query tokens) to
stop chain-completion from dragging in off-topic neighbors.
**Outcome.** Chain-reach and ordering improved; the cohesion gate prevented the flood the naive walk
would cause.
**Key reversal in this phase.** The **supersede-chain projection** (assemble from `supersededBy`) was
designed for these questions but returned **EMPTY** — the failing temporal transitions have NO supersede
edges (they're compound standing-instincts with no correction-cue word, e.g. `escalation-16`, str 0.01).
So supersede was the wrong lever. The right one: a **date-windowed, subject-anchored timeline** entered
from the semantic anchor, gathering active+archive facts by `first_seen` — which surfaces the str-0.01
transition KNN missed.

## Phase 10 — Semantic/temporal visualization toggle (ckpt 28)
**Motivation.** Debugging recall needed to *see* the graph in both modes.
**Decision / Outcome.** Added a viz mode toggle (tooling, not engine behavior).

## Phase 11 — Dreaming-as-SYNTHESIS: concept formation (ckpt 29–32)
**Motivation.** The live store accreted ~46 near-variant "PPVNET Sev4 DNS incident <ID>" nodes —
genuinely distinct events (correctly not merged) that crowd the hot set without adding meaning. Nothing
consolidated a fragment *cloud* into a *concept* (→ P0, P10).
**Decision.** Built the synthesis machinery: a deterministic **emit-candidates → LLM carve/refuse →
archive-members** loop (stateless LLM, all state in `memory.db`, transactional, monotone-terminating).
Research measured: entity-anchored clustering misses PPVNET (no entity hub); tight-cosine union-find over
a **dormant** pool (low strength, ≥N members, quiet) + LLM gate works — the mini model correctly
subdivided a mixed pool and refused to merge an item that mixed DNS with Dataflow-SLA. Added the
**time-indexed bookshelf** so cold members are reachable by concept→member + date.
**Outcome.** Synthesis abstracts many siblings into one hot concept + demotes members to cold, bounding
the hot set while keeping detail recoverable. Reconciles with P6 (demote not delete) and P7
(append-only, few clusters/night).

## Phase 12 — The broken 500d fixture; canonical 180d baseline (ckpt 33)
**Motivation.** 500d synthesis looked bad — but was the *fixture* trustworthy?
**Decision.** Investigated and found the 500d path ingested `tools-500d`, a locally LLM-generated,
untracked fixture that **silently drops facts** the validator confirms answerable. Rebuilt on the
tracked/canonical **`tools-180d`** (the same fixture the published openclaw 180d run used).
**Outcome.** Trustworthy baseline: **overall 5.355, temporal 6.000, synthesis 4.396**. Conclusion: at
180d, **synthesis is the real weak spot, not temporal** — which redirected all subsequent effort.
**Lesson.** Never tune the engine to an unvalidated fixture (this is why Phase 4's corpus-artifact
distinction mattered).

## Phase 13 — q286: a pure RANKING failure → activation rerank (ckpt 34–36)
**Motivation.** q286 ("what pattern … throughout the window") scored **0**. On a deterministically
rebuilt 180d store the answer was **fully present and correctly consolidated** (a str-0.697 recent gist
on a 16-node Apr→Jun delta-chain), yet lost the top-K to a str-0.001 *stale* restatement singleton — the
answer gist sat at **rank 52**. Every pointed single-instance question on the same topic scored 6. The
engine computed `strength` (ACT-R base-level activation) every night and **threw it away at read time.**
**Decision.** `activation = cosine + λ·strength`, cosine-dominant, bounded λ (→ principle 9 / P11).
Rubber-duck endorsed the direction and flagged seed-reach, cohesion, and old-fact protection guards.
**Outcome.** Offline: q286 moved **rank 52 → rank 0**, controls stayed green. Judged 180d A/B:
**overall 5.355 → 5.446 (+0.091)**, no catastrophic regressions; synthesis improved but remained the
weakest at **4.563**.

## Phase 14 — q024, the "not clueless" bar, single optimal path, perf (ckpt 37–38)
**Motivation.** Synthesis still lagged (4.563). q024 ("what private family items were on file by
2026-01-14") was **MISSING from the retrieval pool entirely** — the gold node (cosine 0.481, rank 38)
was outside the KNN seed cap and graph-isolated from the abstract-policy top hit. The user's bar:
*not a perfect answer, but "I've seen this before"* — surface the answer-bearing memory (→ P9).
**Decision.**
- Built a **fast retrieval-hit eval** (`_receval.js`) that faithfully replicates the adapter's
  re-scoring/dedup/chain/slice pipeline, so strategies can be compared in seconds instead of a full run.
- Added the **active-date detail sidecar** (principle 10): on explicit date intent, pull active facts
  whose `first_seen` is in the window, term-gated, text-deduped, scored `cos + 0.2`. Fixed a
  `collapseKeys` scope-collision bug (a `scope:family` key from another tier deduped away all 6 family
  rows) by deduping on TEXT only.
- Per user directive, **removed all feature-hiding env flags** — recall features are now unconditional
  ("single optimal path"), leaving only durable capacity/retention knobs configurable.
**Outcome.** q024 MISSING → **RENDERED @ rank 0**; synthesis fast-eval **5/8 → 6/8**, guards held 3/3,
all other questions byte-identical, tests 4/4. Committed + pushed (`9ebacaf`).
**Perf question (should we rewrite JS → .NET 10 / Rust?).** Measured: recall.js end-to-end ~1508 ms (of
which ~622 ms embedding HTTP, ~100 ms node cold start, ~25 ms native load); bench wall-clock ~4.5 s/query
dominated by the agentic LLM loop. **Verdict: negligible end-to-end gain** — the heavy math is already
native (sqlite-vec/SQL), embeddings are network-bound, and JS is only orchestration. The one real
overhead (per-query subprocess spawn) is fixable in JS with a warm process, not a rewrite.

---

## Key reversals & abandoned paths (why we do NOT do these)

- **Global gist-then-timeline context reorder (CLS experiment) — REGRESSION.** Reordering the *rendered*
  retrieval context by time starved pointed questions of their best evidence: **factual −0.6 (n=73),
  synthesis −0.8 (n=19)**. → principle 6: relevance order is primary; temporal info rides as metadata.
  P9/P11 rank *seed selection* by activation, which is NOT the same surface — never conflate them.
- **Temporal age tags on every fact — WASH.** Recency is only ~3.5% of questions; tags as metadata are
  ~neutral. Time is a *query-invoked* operation (P3), not a global stamp.
- **The 4-seed graph funnel — LOST reach.** 30% vs 47% raw cosine top-15; the graph walk was discarding
  cosine hits, not adding them. → widened seed/node limits.
- **Lexical/BM25 seeds — WORSE than cosine** (13% vs 40%) for delta facts buried among daily restatements.
- **Entity-anchoring as a global retrieval strategy — abandoned.** 100% gold-reach only with 25k
  candidates (useless); at a 15-fact budget it gives no net gain over cosine.
- **Validity intervals — rejected as a first principle.** They require nightly mutation of historical
  nodes (drift/corruption over 500 nights). Append-only edges + read-time work instead (P7).
- **Supersede-chain projection for temporal transitions — EMPTY.** The failing transitions carry no
  supersede edges; date-windowed subject-anchored timelines were the actual fix.
- **The "date-window anchoring is weak" verdict — RETRACTED.** It was a proxy artifact: "gold = nearest
  fact to a short date-only referenceAnswer" embeds onto a random date-mentioning fact. Against real
  judged failures + direct inspection, date-windowed retrieval was the STRONGEST fix. → *never trust a
  cosine proxy for ground truth; anchor on judged results.*
- **The hard 500-cap as the memory bound — DELETED answers.** It's faithful to what we INJECT, not what
  we REMEMBER. → three-tier demote-don't-delete.
- **Full O(N) nightly weave — infeasible (~21 h/180d).** → incremental weave (work scales with new
  material, not store size).
- **50k tier-2 decouple as the perf fix — mis-diagnosed.** The real cost was entity-graph densification
  and no-op refresh writes, not the fact count.
- **Language rewrite to .NET 10 / Rust — not worth it.** Wall-clock is LLM/network-bound and heavy math
  is already native; JS is orchestration. Fix the architecture (warm process, batch embeddings), not the
  language.
- **Chasing a perfect q024 answer — declined.** The question needs perfect recall + comprehension (it's
  a calendar app's job). The right bar is P9: *surface that we've seen it*, without building a calendar
  subsystem.

## The through-line
Almost every win came from the same realization in a new guise: **the answer is usually present in the
store — the failure is in reach, ranking, or lossy consolidation, not in missing knowledge.** So the
engine's job (P5) is to *deliver the complete, dated, ordered, correctly-ranked versions* and let the
LLM reason. Preserve everything recoverable (P6/P8), pay the processing price once (P1/P2 nightly cost),
rank by activation not raw cosine (P11), and invoke time only when the query asks for it (P3).
