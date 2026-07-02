# Dreamweave — First Principles

> **Reading order:** **FIRST-PRINCIPLES** (this doc — *why the system is shaped this way*) →
> [ARCHITECTURE](./ARCHITECTURE.md) (*the design that follows from these principles*) →
> [JOURNEY](./JOURNEY.md) (*the chronological path of decisions and their evidence*).

Each principle below is grounded in a **measurement**, not philosophy. The evidence that
motivated it is quoted inline so the reason is never lost. Principles are layered: Layer 1
(P1–P7) defines the recall *object and contract*; Layer 2 (P0, P8–P10) defines what the
active store is *for* and what *dreaming consolidates*; Layer 3 (P11) defines *read-time
ranking*.

---

## Layer 1 — the recall OBJECT and CONTRACT (2026-06-29)

### P1. The atom is a STANDING ASSERTION WITH A HISTORY, not an event.
Evidence: 63 facts/day but only ~8.6 novel deltas/day (median 5); 86% are restatements. The
corpus is mostly the same standing statements re-emitted daily, occasionally changing.

### P2. Truth is TIME-RELATIVE and NON-MONOTONIC.
Evidence: "Caldwell in active recovery" (2/11–2/26) then "stabilized" (2/27). Both are in the
store; neither is wrong — each is true as-of its time. Recall must answer "what was asserted
as of T" and "how did it change", and must DEMOTE, never DELETE, a superseded value.

### P3. TIME IS A QUERY-INVOKED OPERATION, not a global property of recall.
Evidence: global date-filtering floods (q267: 571 in-window facts, top hit = medical noise).
Most queries are not time-bearing; some are ("on 2/27", "first", "how did it change"). Time
must apply to a TOPIC neighborhood when the QUERY asks for it — never stamped on every fact
(the "robotic" failure mode).

### P4. Recall is TWO-PHASE: semantic localization, THEN intra-topic resolution.
Evidence: pure semantic misses dated deltas (q106 "couldn't find 2/26–2/27"); pure time-filter
floods (q267). Neither axis alone works. Locate the topic semantically (time-agnostic), then
resolve within it along the dimension the query names (time, etc.).

### P5. The ENGINE retrieves; the LLM reasons.
The engine's contract: "deliver the COMPLETE, correctly-DATED, ORDERED set of distinct versions
for the topic the query addresses." Evidence: given ordered dated versions the LLM computes
asOf/first/trajectory itself; when versions are MISSING it fails (q106, q095). q077 shows it can
still err with facts present — but the engine's job is to guarantee the versions are PRESENT and
LEGIBLE (dated, ordered), not to compute the answer.

### P6. NEVER lose information you can't recover.
Evidence: lossy collapse of non-identical text can delete the exact transition asked about (if
2/27 "stabilized" collapses into 2/26 "active recovery", asOf/window can never surface it).
Collapse ONLY verbatim duplicates; preserve every DISTINCT version.

### P7. The store is LONG-LIVED and INCREMENTAL (500 nights). Prefer append-only, low-mutation.
Evidence: nightly re-closing of validity intervals = mutating historical nodes every night for
500 nights = drift/corruption risk. Append-only edges drift far less. Minimize nightly state
rewrites.

### What Layer 1 RESOLVES
- The essential OBJECT (P1,P2,P6): a standing assertion + its DISTINCT DATED VERSIONS, none deleted.
- The essential CONTRACT (P3,P4,P5): semantic-locate the topic, then deliver its distinct dated
  versions ORDERED, with the query's time-intent selecting/filtering — engine retrieves, LLM reasons.
- The essential CONSTRAINTS (P6,P7): keep all distinct versions; prefer append-only / read-time work
  over nightly mutation.

=> Validity INTERVALS are NOT a first principle — they are an optional precomputed convenience that
   P7 actively discourages (they require nightly mutation). We don't need them.

### The one irreducible hard kernel
Everything above depends on ONE subproblem: **given the topic a query addresses, GROUP its versions
across time and distinguish a genuine CHANGE (delta) from a mere restatement — keeping distinct
sub-topics (q313 reschedule vs onsite) and distinct scopes ([principal] vs [direct-reports])
SEPARATE, and handling PERIODIC/recurring states (q095/q267 weekend-vs-weekday) without misreading
them as linear progression.** Edges-vs-intervals-vs-read-time is plumbing around this kernel.

### Kernel measurement result (2026-06-29) — the assumption was PARTLY FALSIFIED
- Temporal VERSION-GROUPING is NOT the bottleneck. When the anchor lands on the right topic, distinct
  dated versions group + order correctly and the answer is present: q010 (Riley), q106 (Caldwell 2/27
  transition), q137 (Daniel Kim). **Phase 2 works.**
- The REAL bottleneck is PHASE-1 TOPIC LOCALIZATION (the anchor). Every case that worked has a rare
  NAMED ENTITY (Riley/Caldwell/Daniel); every drift case is an ABSTRACT topic where the question
  vocabulary ("calibration","shift") doesn't embed near the fact vocabulary ("concise, lightly warm").
  ~5/18 die at localization, BEFORE any temporal step.
- PERIODICITY confirmed as a separate mode (~4/18): weekend↔weekday; the linear-version model misfits it.
- **New priority order:** (1) phase-1 localization robustness (entity-anchor when a rare entity is named;
  else query-expansion / agent-loop), (2) topic-anchored ordered distinct-version delivery (lean),
  (3) recurrence-aware grouping. Phase-2 plumbing is the EASY part.

---

## Layer 2 — PURPOSE & THE ACTIVE-TIER CONTRACT (2026-06-30)

Layer 1 is silent on what the live store is FOR, and what keeps it BOUNDED over 500 nights.
Motivating evidence: the live store accreted ~46 near-variant "PPVNET Sev4 DNS incident <ID>" nodes
differing only by incident-id/region/timestamp. They are genuinely DISTINCT events (correctly NOT
merged as duplicates), yet kept hot they are noise — they crowd the nebula and the KNN path without
adding meaning. The gap is not recall; it is that nothing CONSOLIDATES a fragment cloud into a concept.

### P0 (sits above all). Memory serves future REASONING with a BOUNDED, GENERALIZED working set — it is NOT a perfect log of the past.
Photographic recall is a BURDEN, not a gift: it never compresses fragments into "what they mean," so
the hot set silts up and every fragment competes equally. The value of memory is compression that is
LOSSY in the hot tier and LOSSLESS in cold: keep the GENERALIZATION instantly available, keep the
DETAILS recoverable on deliberate lookup.

### P8. TWO TIERS, DIFFERENT CONTRACTS.
- HOT (active, fast KNN) = generalizations + REINFORCED specifics = "what you KNOW." Bounded.
- COLD (bookshelf, time-indexed) = raw detail = "what you can LOOK UP." Reached by DELIBERATE retrieval
  (keyword/similarity + generalization→member lineage + date), NOT by the hot KNN path.

This REFINES P6: preserve ≠ keep-hot. Preserve = keep-RECOVERABLE-in-cold.

### P9. The eval rewards RECALL, not INSTANT recall.
Getting the right answer is credited; getting it from the hot set is not required. "What happened on
Feb 23rd, asked 4 months later" SHOULD be a bookshelf walk (topic concept → cold members filtered by
date), not a hot-KNN hit. Reinforced / re-asked details legitimately stay hot: reactivation is the
signal that a specific still matters.

### P10. DREAMING'S DEFINING JOB IS SYNTHESIS — forming NEW, higher-level concepts from fragments.
Dreaming is not merely decay + dedup-merge. Its reason to exist is to CONNECT fragmented memories and
FORM NEW ONES that GENERALIZE them. When a connected cluster of near-variant, LOW-ACTIVATION memories
shares a theme, dreaming asks the LLM to abstract it and writes ONE new generalization into the hot
tier, DEMOTING the members to cold (linked, not deleted). This is activation-GATED: recently-reactivated
members are exempt and stay hot. It is distinct from supersede (correction) and from sequence (lineage
of ONE evolving statement): synthesis abstracts MANY distinct siblings into a concept they instantiate.
The PPVNET cloud → ONE hot node ("~50 PPVNET Sev4 DNS incidents recurred across June, all
auto-mitigated") + 50 cold members on the shelf.

**How synthesis reconciles with Layer 1:** P6 — synthesis DEMOTES to cold, never deletes. P7 — it
APPENDS a concept node + `generalizes` edges and flips the members' tier flag (bounded mutation on a
few low-activation clusters per night, not a global rewrite). The kernel's periodicity mode: "recurring
X" is itself the correct ABSTRACTION of a periodic series, so synthesis is also the lever for
recurrence-aware grouping.

**Open research (how to generalize):** detecting WHEN a cluster warrants a concept (a real shared theme)
vs. coincidental co-location is the hard part. Candidate pool = tight-cosine union-find + DORMANT +
low-strength + multi-member; the LLM decides carve/refuse; write concept + `generalizes` edges + demote
to cold with `first_seen` retained; guard with a pure-coincidence NEGATIVE test.

---

## Layer 3 — RETRIEVAL RANKING = ACTIVATION (2026-07-01)

Layers 1–2 are silent on the READ-TIME question q286 exposed: given the right facts are IN the store
AND correctly consolidated, WHICH of them wins the top-K the agent actually reads?

### P11. RETRIEVAL RANKS BY ACTIVATION = semantic match (cosine) ⊕ BASE-LEVEL activation (strength) — NOT cosine alone.
Evidence (q286, synthesis, scored 0, on a deterministically-rebuilt 180d store): the dream built the
answer CORRECTLY — a str-0.697 recent gist ("protect the operating review; deconflict by moving the more
flexible adjacent internal item") sitting on a 16-node Apr→Jun sequence/supersedes delta-chain. Recall
ranked seeds by PURE COSINE, so the str-0.001 Jan/Feb GENERIC restatement — a delta-chain SINGLETON — took
the top-3 seed slots and the answer gist sat at RANK 52, below the top-K the agent reads. Proof it is
RANKING, not recall/consolidation: every POINTED single-instance question on the identical topic
(q164/238/259/270/280/297/305) scored 6.

The engine ALREADY computes base-level activation and throws it away at read time. `strength` is updated
every night by DECAY (`strength·2^(−Δt/H)`, the forgetting curve — dream.js:411) + REACTIVATION boosts
(+~0.10 each night a fact is re-cued — dream.js:464). That IS ACT-R base-level activation = recency ×
frequency × schema. Cosine is only ACT-R's spreading/semantic term.

**Fix:** `activation = cosine + λ·strength` (cosine-DOMINANT; bounded λ). Recent & reinforced = high
activation = surfaced; distant & un-re-cued = decayed = stays down UNLESS it stayed strong. A buried
high-activation fact is rescued INTO the window, after which chain-completion surfaces the rest of its
lineage.

**Reconciliation with principle 6 (no global time-reorder):** P11 does NOT reorder the rendered context
by time (that experiment — CLS gist-then-timeline — REGRESSED: factual −0.6 n73, synthesis −0.8 n19). It
makes STRENGTH a first-class term in SEED SELECTION only, which principle 6 already names as part of
relevance. It uses activation, NOT a clock — explicit-date queries still route through the time-window
path, so old-dated-fact recall is unaffected by decay. Bound λ so a strong OFF-topic fact can never
outrank a strongly on-topic one; validate across factual/temporal/contradiction, not just synthesis.
