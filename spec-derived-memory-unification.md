# Spec: Derived-Memory Contract Unification (semantic gists + temporal chronicles)

Status: APPROVED for implementation (contract-layer scope).
Owner of design: this session. Implementer: delegated agent.
Engine: `Q:\src\dream-memory` (local-only, no external LLM; caller is authoritative judge).

---

## 1. Problem

We added chronicles to give recall a temporal axis, but the matched 180-day eval
regressed temporal reasoning from **5.0/6 → 2.0/6**. Root cause was NOT the temporal
model itself — it was that we built **two physically separate derived-memory
machineries that diverged**:

- **Semantic gist**: `nodes(kind='fact')` + `notes` contains `gist`; evidence linkage via
  `detail_of` and `gist_landmarks`; recall expansion via `gistLandmarkHits`
  (`src/recall.js` ~lines 810–862).
- **Temporal chronicle**: `nodes(kind='chronicle')` + `chronicles` / `chronicle_entries` /
  `chronicle_evidence` + dedicated vector indexes + dedicated triggers; recall expansion via
  `chronicleEvidenceHits` (`src/recall.js` ~lines 863–1110).

The semantic landmark-evidence reservation existed in the schema but **was never consumed by
`recall.js`** until a late patch this session. A strong semantic gist could therefore surface
while its authoritative dated evidence (e.g. q077's Feb 15 remediation-draft fact) lost the
evidence-slot competition, and the model answered from an adjacent earlier state. Two paths,
one wired, one not = silent divergence.

**Conceptual correction (approved):** a chronicle is just a **temporal-axis gist**. Both
gists and chronicles are lossy, derived indexes over authoritative evidence. They must obey
one identical contract and flow through one identical evidence-expansion seam so they can
never diverge again.

## 2. Decision & scope

**Contract-layer unification (chosen over full physical unification).**

- KEEP the two physical table families as-is (`detail_of`/`gist_landmarks` for semantic;
  `chronicles`/`chronicle_entries`/`chronicle_evidence` for temporal). No schema migration,
  no new `kind='gist'`, no `axis` column on `nodes`.
- ADD one shared **Derived-Memory Contract** and one shared **evidence-reservation routine**
  that BOTH axes are forced through. Axis-specific loaders feed the shared routine; the
  reservation, budgeting, tagging, priority, and anti-starvation policy are single-sourced.

The invariant we are hard-wiring, structurally (not just in prompts):

> A derived memory (semantic gist OR temporal chronicle) locates evidence; it is NEVER
> authoritative for exact dates, numbers, sequence, or attribution. Whenever a derived memory
> surfaces strongly in recall, the engine MUST reserve bounded authoritative source evidence
> for it in the evidence lane, uniformly tagged, with anti-starvation guarantees across both
> axes.

## 3. Non-goals

- No physical merge of the chronicle tables into the fact/gist tables.
- No change to how chronicles are *constructed* (period windows, day→week→month→quarter→year
  hierarchy, immutable versions, `coverage_seq`). Temporal construction stays; it is intrinsic
  to the axis ("why me, why now": calendar time genuinely needs windows + coarsening).
- No engine-side hard-coding of the benchmark epoch. q271 (ordinal-day mapping) is a separate
  workstream (§8), NOT part of this unification.
- No external-LLM calls in the engine. Caller remains the judge.

## 4. Current seams to unify (anchors)

Read these before changing anything:

- `src/recall.js`
  - `strongGists` selection: ~line 448–475.
  - Semantic gist render + landmark reservation (`gistLandmarkHits`): ~line 810–862.
  - Chronicle vector/time/lexical routing (`temporalRoutes`): ~line 863–1015.
  - Chronicle evidence recursion (`chronicleEvidenceHits`): ~line 1017–1108.
  - Final assembly: `nodeCount` (~1187), `.concat(gistLandmarkHits)` (~1200), and
    `evidenceHits` builder consuming `[...gistLandmarkHits, ...chronicleEvidenceHits, ...]`
    (~line 1287–1300).
- `src/dream.js`
  - Semantic landmark persistence (`applyMerges`): ~line 2386–2393 (`gist_landmarks` writes).
  - Chronicle evidence persistence (`applyChronicles`): ~line 2932+.
  - Doctor derived-memory checks incl. `dangling_landmarks`: ~line 3289, 3413.
- `src/schema.js`
  - `gist_landmarks` table: ~line 225–233.
  - `chronicle_evidence` + guard triggers: ~line 140–223.
- `src/memory-render.js`
  - `renderNodeEnvelope` / `chronicleMetadata` — index-labeling of both envelope types.

## 5. Target design

### 5.1 New module: `src/derived-memory.js`

Single source of truth for the contract. Pure, dependency-light (takes `db` + a language
service where needed, like the rest of the engine). Exports:

```
// Classify any node as a derived index, or null if it is authoritative evidence.
describeDerived(db, node) -> null | {
  axis: 'semantic' | 'temporal',
  sig: string,
  // axis-specific loader that returns candidate authoritative evidence for THIS derived memory,
  // already scored/ordered by that axis's own relevance signal but NOT yet budgeted:
  loadEvidence(ctx) -> Array<{
    sig, role,            // semantic role: 'change'|'current'|'before'; temporal role: 'in_window'|'endpoint'|'entry'
    node,                 // the resolved authoritative fact node row
    axisScore,            // axis-local ordering signal (lexical/date/depth for temporal; role rank for semantic)
    depth                 // 0 for direct landmark/entry evidence; >0 for recursive chronicle-evidence hops
  }>
}
```

- Semantic loader: reads `gist_landmarks` (roles change>current>before) then falls back to
  `detail_of` constituents; preserves the current change>current>before ordering.
- Temporal loader: reuses the existing entry lexical/date scoring and the recursive
  `chronicle_evidence` walk (depth ≤ 5), preserving in-window > endpoint > other ordering.

The two loaders are literally the *only* axis-specific code. Everything below is shared.

### 5.2 New shared routine: `reserveDerivedEvidence(db, selectedDerived, ctx)`

Replaces BOTH `gistLandmarkHits` and `chronicleEvidenceHits` production. One routine, one
output shape, one budget.

Inputs:
- `selectedDerived`: the union of strongly-surfaced derived memories across both axes
  (strong semantic gists from `strongGists` + selected `temporalRoutes`), each passed through
  `describeDerived`.
- `ctx`: `{ terms, dateRange, specificsIntent, nowRef, qFloat, k, L }` (already available in
  `recall.js`).

Behavior (the contract, enforced here):
1. **Rank the derived parents** by their own recall activation (the score that made them
   surface), capped at `DERIVED_PARENT_CAP` (default 6, env-overridable
   `MEMORY_DERIVED_PARENT_CAP`).
2. **Guaranteed reservation (anti-starvation):** for each of the top-ranked derived parents,
   reserve at least `DERIVED_MIN_PER_PARENT` (default 1) authoritative evidence node, taking
   the highest axis-priority item from its loader (semantic: first present of change/current/
   before; temporal: first in-window else endpoint). This guarantee holds **across both axes**
   — semantic reservation may not starve temporal and vice versa. This is the core property
   that fixes q077 without re-breaking q267.
3. **Fill:** after guarantees, fill remaining derived-evidence capacity
   (`DERIVED_EVIDENCE_CAP`, default `max(24, k*2)`, env `MEMORY_DERIVED_EVIDENCE_CAP`) by
   global activation across all remaining loader items.
4. **Tag uniformly.** Every reserved hit gets:
   `{ id, kind:'fact', class, tier, fact, raw_fact, first_seen, source_day, age_days, age,
      superseded, superseded_by, via:'derived_evidence', axis, parent, role, hops:depth,
      strength, semantic_similarity, activation }`.
   - Preserve exact source dates + supersession metadata (load via existing `loadSupersededBy`).
   - `via` is unified to `'derived_evidence'`; `axis` + `role` retain provenance.
     (Keep back-compat: if any consumer/test currently asserts `via:'gist_landmark'` or
     `via:'chronicle_evidence'`, update those assertions to `via:'derived_evidence'` +
     `axis`/`role` — do NOT keep the old split tags alive.)
5. **Priority.** Reserved derived evidence outranks unrelated keyword/archive evidence in the
   final `evidenceHits` lane but never outranks a directly-matched on-date exact record
   (`via:'active_time'`) — preserve existing authority order.
6. **Bounded.** Never emit more than `DERIVED_EVIDENCE_CAP`. Never let one parent consume more
   than `DERIVED_MAX_PER_PARENT` (default 4) so a single gist/chronicle can't flood the lane.

Output: a single `derivedEvidenceHits` array.

### 5.3 `recall.js` integration

- Delete the separate `gistLandmarkHits` block and the `chronicleEvidenceHits` mapping.
- After `temporalRoutes` are selected and `strongGists` are known, build
  `selectedDerived = [...strongGists, ...temporalRoutes].map(x => describeDerived(db, x))`
  (drop nulls) and call `reserveDerivedEvidence`.
- Replace every downstream reference:
  - `nodeCount`: use `derivedEvidenceHits.length` in place of `gistLandmarkHits.length`
    (chronicle evidence was not previously counted there — keep counts correct).
  - `.concat(gistLandmarkHits)` → `.concat(derivedEvidenceHits)`.
  - `evidenceHits` builder: `[...derivedEvidenceHits, ...rankedActive, ...unranked]`.
- `temporalRoutes` themselves (the chronicle overview envelopes) still appear in
  `out.cluster.nodes` / `out.temporalRoutes` as index rows — unchanged. Only their *evidence
  expansion* is now shared.

### 5.4 Projection labeling (memory-render.js)

Both envelope headers must state the same contract to the model: "index over evidence — not
source; expand/verify exact dates, numbers, attribution, sequence in returned details." This
is largely present for both; audit that the wording is identical in spirit for semantic and
temporal envelopes so the model treats them with the same non-authority.

### 5.5 Lifecycle & doctor (mostly exists — make uniform)

- Deletion already preserves referenced evidence (triggers + `removeDependentChronicles`).
  Add symmetric handling: a doctor check that BOTH `gist_landmarks` and `chronicle_evidence`
  have zero dangling `evidence_sig` (the `dangling_landmarks` check exists; add/confirm the
  chronicle-evidence equivalent, and a check that every derived memory has ≥1 evidence link —
  a derived memory with zero evidence is a defect).
- No new deletion paths needed for contract-layer scope.

## 6. The contract, restated (put this as a doc-comment atop `derived-memory.js`)

1. Not authoritative for exact date / number / sequence / attribution.
2. Must carry ≥1 evidence reference (else doctor flags it).
3. On strong retrieval, MUST reserve bounded authoritative evidence via
   `reserveDerivedEvidence` — same routine for both axes.
4. Projection labels it as an index.
5. Lifecycle/deletion preserves referenced evidence.
6. Neither axis may starve the other's reserved evidence.

## 7. Tests required (Dreamweave `test/`, all must pass under `npm test`)

Reuse existing fixtures where possible.

1. `test/gist-evidence.test.js` (extend): strong semantic gist reserves its `change` landmark
   into `evidenceHits` with `via:'derived_evidence'`, `axis:'semantic'`, `role:'change'`, and
   correct `source_day`; a competing unrelated gist cannot crowd it out.
2. `test/temporal-chronicles.test.js` (extend): a short-range temporal query reserves both
   endpoints' evidence with `via:'derived_evidence'`, `axis:'temporal'`; q267-shape
   (weekend→workweek) returns both sides.
3. New `test/derived-evidence-contract.test.js`:
   - With BOTH a strong semantic gist and a strong chronicle in one recall, each gets ≥1
     reserved evidence (cross-axis anti-starvation).
   - `DERIVED_MAX_PER_PARENT` caps a flooding parent.
   - A derived memory with zero evidence links is flagged by doctor.
   - Reserved derived evidence never outranks a `via:'active_time'` on-date exact record.
4. Confirm the full suite count: currently 39 files → 40 with the new test. `npm test` green.

## 8. Separate workstream (NOT this refactor): q271 ordinal-day coordinate gap

q271 asks about "days 160–161". Recall is calendar-indexed and has no ordinal→date mapping, so
the model invents a range. Do NOT hard-code Jan 1 in the engine. Preferred fix, in order:
1. Harness (`recall-bench-openclaw`) translates ordinal corpus days → calendar dates before
   calling `memory_search`/`memory_timeline`.
2. Or tool metadata exposes the corpus-day epoch so the agent can map it.
3. Or the agent prompt forbids inventing calendar bounds for unmapped ordinal references.
Track separately; it must not block the unification or the 500-day restart.

## 9. Validation gates (do not commit/push until all pass)

1. `npm test` in `Q:\src\dream-memory` → 40/40 files green.
2. Targeted real replays against the **validated** fixture
   `Q:\src\recall\packages\recall-bench\personas\executive-assistant\tools-500d`
   (embedding shim at `http://127.0.0.1:8799` must be up):
   - q077 day-50 gate → 6/6, cites exact Feb 15 evidence via derived_evidence.
   - q267 real date-range replay → both weekend + workweek evidence reserved.
3. OpenClaw `tsc` + build clean IF any adapter result-shaping changed (likely none for
   contract-layer scope).
4. Clean five-checkpoint smoke, then restart the full 500-day candidate. Do NOT use behavioral
   `--resume`. Do NOT commit/push until the 180d eval validates.

## 10. Do-not-break list

- Authority order: `exact episode/detail/archive > chronicle overview > semantic gist`.
- Ingest stays episodic-only; class/salience unchanged.
- No engine external-LLM calls.
- Chronicle construction (windows, hierarchy, immutable versions, coverage_seq) unchanged.
- Existing triggers, `removeDependentChronicles`, alias-fold facet remap unchanged.
- Recall performance: keep the index-driven bidirectional edge walk; do not introduce
  unindexed full scans in the new routine (batch vector reads like the current chronicle path).
