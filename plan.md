# Dreamweave Engine Hardening Plan

Status: local implementation in progress on `hardening/audit-remediation`.

## Release gate

Do not push this branch or any hardening commit to `origin` until all three gates pass:

1. Local validation: targeted regressions, full unit suite, schema migration checks,
   doctor/vector invariants, and relevant performance probes.
2. Live harness validation: run the installed Dream and Graph Recall skills against a
   safe database copy, then validate the real harness integration and projection flow.
3. Full 180-day evaluation: compare against the most recent same-commit baseline,
   inspect per-question deltas, and resolve every material regression.

Local commits and checkpoints are allowed. Remote publication and release tags are not.

## Architectural rule

`first_seen` is event time. It must never be used to decide whether engine work has
already processed a node.

Incremental stages instead use monotonic engine-owned processing metadata:

- `ingested_at`: when the engine first accepted the node.
- `dirty_at`: when content or processing-relevant metadata last changed.
- stage cursors: the highest successfully processed change revision/time.

Stage cursors advance only after that stage completes successfully.

## Phase 1 - Restore pipeline correctness

### 1. Separate processing time from event time

- Add guarded schema migrations for processing metadata.
- Stamp new and edited harness facts as dirty.
- Move dream, weave, entity, salience, and merge incremental gates off `first_seen`.
- Preserve `first_seen` exclusively for temporal recall, age tags, ordering, and
  historical lineage.
- Add regressions for:
  - newly ingested backdated facts;
  - edited old facts;
  - retry after a stage failure;
  - event dates earlier than every processing cursor.

### 2. Correct nightly ordering

- Ensure new/dirty facts receive entity associations before subject reactivation.
- Advance reactivation/dream cursors only after association succeeds.
- Verify a newly mentioned subject reactivates an existing fact exactly once.

### 3. Propagate dirty entities and aliases

- Pass caller-approved new or changed hub forms into a scoped mention backfill.
- Persist mechanical entity-candidate evidence across nights.
- Use short person-name forms only when unique or explicitly approved.

## Phase 2 - Guarantee mutation integrity

### 4. Make dream atomic and retry-safe

- Commit decay, reactivation, demotion/deletion, journal writes, and watermark together.
- Record completed run IDs so a retry is a no-op.
- Keep external embedding/LLM work outside write transactions.

### 5. Harden merge apply

- Bind decisions to the exact report/cluster set.
- Reject stale, overlapping, archive, detail, or unrelated members.
- Precompute replacement embeddings before mutation.
- Commit node, vector, lineage, and edge changes atomically.

### 6. Strengthen schema and doctor

- Deduplicate edges, then enforce `UNIQUE(src, rel, dst)`.
- Enforce uniqueness for non-empty `memory_id` values.
- Add `(rel, src)`, `(rel, dst)`, and targeted node indexes.
- Extend doctor to validate active/archive vector placement, vector cardinality,
  dimensions, duplicate identities, and duplicate edges.

## Phase 3 - Correct recall behavior

### 7. Apply activation before seed truncation

- Overfetch fact-only KNN candidates.
- Compute cosine + bounded strength activation before selecting final seeds.
- Preserve historical/supersede behavior and lexical supplementary seeds.

### 8. Repair temporal recall

- Recognize `as of`, `on`, and historical target dates.
- Make supersession penalties target-date-aware.
- Rank ordinary active and date-sidecar candidates in one ordering.
- Include all non-archive active note states.
- Permit bounded date-only retrieval without topical terms.
- Add numeric dates, cross-month ranges, and ambiguous-month guards.

### 9. Scale graph retrieval

- Replace all-edge supersede, sequence, and output-edge scans with scoped indexed SQL.
- Cap distinct versions after duplicate collapse rather than raw chain traversal.
- Confirm byte-equivalent reachable sets before replacing existing queries.

## Phase 4 - Reduce nightly cost

- Consolidate repeated per-surface weave calls into dirty propagation plus one final weave.
- Make embedding inference truly batched/chunked.
- Scope graph repair and degree work while preserving full `doctor` validation.
- Incrementally report alias candidates instead of all hubs.
- Replace visualization's quadratic Gram PCA with bounded randomized/covariance PCA.

## Phase 5 - Operations and documentation

- Reject malformed persisted configuration instead of silently using defaults.
- Save configuration through atomic replace.
- Match the exact versioned engine anchor rather than any `[memory-usage]` prefix.
- Reconcile README, INSTALL, architecture, and skills with the live CLI:
  - `src/` paths;
  - four knobs;
  - caller-owned LLM judgment;
  - continuous salience score;
  - vector-backed archive recall;
  - current commands and defaults.

## Validation matrix

| Area | Required evidence |
|---|---|
| Processing clock | Backdated insert and old-node edit reach every incremental stage |
| Reactivation | New co-mention reactivates prior subject once, never zero or twice |
| Entity apply | Approved hub receives mention edges and survives the next dream |
| Atomicity | Injected failures leave no partial mutations; retry is idempotent |
| Merge | No missing vectors, overlapping members, or unreported clusters |
| Recall | Activation, historical as-of, date-only, numeric, and cross-month regressions |
| Scale | Query plans use scoped indexes; no whole-edge materialization on recall |
| Harness | Dream/project/anchor/graph-recall work against live integration |
| Evaluation | Full 180-day result has no unexplained material regression |

## Progress

- [x] Audit completed and prioritized.
- [x] Local-only branch and no-push validation gate established.
- [x] Phase 1.1 processing/event clock separation.
- [x] Phase 1.2 nightly ordering.
- [ ] Phase 1.3 dirty entity propagation (approved hub/form backfill complete;
  ambiguous short-name filtering complete; cross-night mechanical evidence remains).
- [ ] Phase 2 mutation integrity (atomic/idempotent dream, report-bound merges,
  committed merge vectors, edge uniqueness, and expanded doctor checks complete;
  non-empty memory-id enforcement remains).
- [ ] Phase 3 recall correctness (pre-truncation activation, historical target-date
  ranking, active date coverage, numeric/cross-month parsing, and ambiguous-May guard
  complete; scoped edge retrieval and remaining dedup policy work remain).
- [ ] Phase 4 performance.
- [ ] Phase 5 documentation and operational hardening (strict atomic config and exact
  anchor recognition complete; public documentation reconciliation remains).
- [ ] Local validation.
- [ ] Live harness validation.
- [ ] Full 180-day evaluation.
- [ ] Push/release.
