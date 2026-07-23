# Dreamweave Engine Hardening Plan

## ===== LIVE-CHRONICLE WIRING (2026-07-20) — write + read paths, validated, UNCOMMITTED =====
Made the live-harness `dream` + `graph-recall` skills able to BUILD and RECALL chronicles so the
temporal axis can be tested live (mirrors the eval's memory_search vs memory_timeline split).
WRITE gap (nightly loop never built chronicles): dream/SKILL.md stage-5 ordering now
`entities→aliases→salience→merges→synthesis→chronicles`; added the full report-chronicles/
apply-chronicles contract (changeKinds, complete-coverage invariant, atomic report-bound apply);
PROJECT stage treats chronicles as blank-memory_id db-native survivors (tier `chronicle`, timeless
like gists). projection-sync.md tier enums include `chronicle`.
READ gap (no temporal route + a leak): recall.js
 (1) `--timeline` flag: cluster.nodes appends `temporalRoutes` (chronicle overviews) ONLY under
     --timeline; plain semantic recall stays chronicle-free. graph-recall/SKILL.md documents the
     LLM-decides-from-phrasing policy (NOT engine date-parsing) + flag + example.
 (2) LEAK FIX (the important one): the undirected graph walk reached a chronicle node THROUGH its
     chronicle→evidence edges whenever an evidence fact was a seed, silently readmitting the lossy
     period overview into the DEFAULT semantic cluster (same leak class the eval fixed at the
     consumer with kind==='fact'). Now `clusterRows = clusterRows.filter(kind !== 'chronicle')`
     UNCONDITIONALLY, restoring the documented "chronicles never enter semantic fact clustering"
     invariant. Traversal-through preserved (far-side evidence still reachable); chronicles re-enter
     cluster.nodes only via the --timeline temporalRoutes append.
VALIDATED: minimal-fixture probe (1 entity + 2 facts + real report→apply chronicle) proved
 semantic → chronicle ABSENT from cluster.nodes (present in temporalRoutes); --timeline → chronicle
 PRESENT in cluster.nodes; temporalRoutes always populated. Full engine suite 40/40 green.
INERT for the running 500d eval: the adapter uses cluster nodes only via `facts=nodes.filter(kind
 ==='fact')` and the chronicle tests read out.temporalRoutes, never chronicles-in-cluster.nodes.
UNCOMMITTED (validation-gate hold): src/recall.js; skills/dream/SKILL.md; skills/dream/
 projection-sync.md; skills/graph-recall/SKILL.md (+ prior chronicles-as-gist / derived-memory
 redesign, and eval-side dream-search.ts leak fix). Do NOT commit/push until the 500d A/B passes.
BACKGROUND: 500d leak-fix run `oc-500d-leakfix-20260720` monitored by schedule #52; watch
 decision-tracking + cross-reference (should recover) and temporal (should hold).

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

- `ingested_seq`: revision when the engine first accepted the node.
- `dirty_seq`: latest content or processing-relevant revision.
- stage cursors: the highest successfully processed revision.

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
- Replace visualization's quadratic Gram PCA with a bounded linear semantic projection.

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
- [x] Phase 1.3 dirty entity propagation (approved hub/form backfill, ambiguous
  short-name filtering, and bounded cross-night mechanical evidence complete).
- [x] Phase 2 mutation integrity (atomic/idempotent dream, report-bound merges,
  committed merge vectors, edge uniqueness, and expanded doctor checks complete;
  future non-empty memory-id uniqueness is enforced without rewriting diagnosed
  legacy duplicates, which remain explicit doctor/operator repair items). Merge
  reports now carry deterministic report identity; apply is all-or-nothing with
  structured stale/cross-cluster/overlap rejection and retry-safe cursors.
- [x] Phase 3 recall correctness (pre-truncation activation, historical target-date
  ranking, active date coverage, numeric/cross-month parsing, and ambiguous-May guard
  complete; archive dedup preserves distinct scoped assertions and supersede lineage
  requires same-aspect overlap).
- [ ] Phase 4 performance (recall graph, supersession, sequence, and returned-edge
  queries are seed/cluster scoped and index-driven; reembedding reads only touched
  edges and runs real 32-item model batches; vector identity self-heals and visualization
  projection is linear; empty report/apply surfaces skip weave entirely. Remaining work:
  scope non-empty maintenance passes and alias reporting without changing semantics).
- [x] Phase 5 documentation and operational hardening (strict atomic config, exact
  anchor recognition (including wrapped host text), and public contract/configuration
  reconciliation complete).
- [x] Local validation (27/27 unit files, migration/doctor on a live-store copy,
  report/apply/projection/recall/viz checks, embedding and projection probes).
- [x] Live harness validation (Scout invoked graph-recall for a Germany West
  Central timeline, separated calendar week from release-train lineage, and
  ranked the superseding false-alarm correction over the original SLA alert).
- [x] Full 180-day validation. The report-bound merge-contract run passed:
  Against `oc-180d-hardening-edfea02`, 1,087 occurrence-aligned judgments across
  311 questions moved 5.635 -> 5.593 (-0.041), while final-per-question results
  improved 5.511 -> 5.585 (+0.074). The run completed all 18 checkpoints with no
  timeout, apply-merges exit-3, stale report, or report-envelope incompatibility.
  Final factual recall (+0.160), decision tracking (+0.281), and contradiction
  resolution (+0.111) improved. Small mixed category deltas and the larger
  occurrence-only synthesis variance came from different LLM consolidation
  survivors/judgments; inspected final reversals were isolated rather than a
  systematic merge-contract failure. That run exposed a pre-existing parser gap:
  q310's "Monday through Friday" did not activate date-window retrieval and scored
  4/6. Weekday-range parsing is now implemented and must restore temporal reasoning
  to 6/6 in the next current-head evaluation before this gate closes. A targeted
  180-day rerun passed q310 at 6/6 after the benchmark adapter also forwarded its
  simulated checkpoint date as recall's `--as-of`; retrieval then surfaced the
  June 22, 23, 25, and 26 records directly.
- [x] Pluggable-language/entity-lifecycle 180-day validation. Against the prior
  merge-contract run, the canonical 1,087-judgment profile improved 5.593 -> 5.640
  occurrence-weighted, and the 180-day checkpoint improved 5.522 -> 5.536.
  Temporal reasoning scored 6/6 on all 31 occurrences. Per-question inspection
  found no language-service or entity-correction mechanism regression; the mixed
  reversals were retrieval/consolidation and judge variance already present in
  this LLM-driven profile.
- [x] Push/release approved after local, live-harness, full-evaluation, and targeted
  weekday-range validation gates passed.

---

# Temporally Aware Memory: Semantic Gists + Multi-Resolution Chronicles

Status: design review in progress. Implementation is blocked until the design passes
an independent Opus 4.8 rubber-duck review.

## Problem statement

The validated 500-day evaluation showed that exact dated episodes survive consolidation,
but semantic merge destroys the temporal structure needed to reconstruct them:

- the merge judge receives fact text without source dates, ordering, inherited evidence
  spans, or prior-gist breadth;
- intra-cluster `sequence` and `supersedes` edges collapse into survivor self-edges and
  are discarded;
- repeated re-merging reparents all prior details while showing the judge only the
  compressed headline, producing broad semantic snowballs;
- projected gists expose neither source dates nor a temporal companion;
- recall computes a coarse evidence span, but a min/max span does not encode the
  pending/change/current trajectory;
- the model repeatedly searches the semantic axis because the harness presents one
  blended result ranking and no first-class temporal memory surface.

Live-store measurements at approximately day 350:

- 2,129 gists, all with retained details;
- median direct-child evidence span 16 days, p90 127 days, maximum 349 days;
- 103 gists span more than 180 days;
- 2,129 gists have multiple details, but the entire graph retains only 12 `sequence`
  and one `supersedes` edge, with zero such edges between sibling details;
- a June Caldwell reschedule gist owns 64 details spanning January 1 through June 23;
- the Tier-1 export contains 2,130 gists, zero gist source dates, zero projected
  evidence-span fields, and only 831 gist texts containing an ISO date.

The defect is therefore not simply missing date ranking. Dreamweave has semantic
consolidation but lacks a persistent temporal abstraction capable of preserving and
progressively coarsening autobiographical sequence.

## User questions and design feedback

This design must answer the user's stated concerns rather than merely patch benchmark
queries:

> "don't go for simple fix. This deserves a proper design: temporally aware
> merges/projections"

> "merge the time component into facts, where it is significant"

> "keep the time component as a separate fact, like 'timeline view' and it's a record
> of 'what happened on what day on the week', like journal but highly condensed form"

> "the latter feels natural to me since I can clearly give you a detailed breakdown of
> what happened on Monday->Friday last week, but as it become more distant they become
> lossy (so I can only remember major events last month)"

> "Repeated merges will make this timeline fact recency biased automatically. We can
> also use multiple entries (per day, per week, etc.) just have to make sure they fade
> to make room for other things to enter"

> "so how would this help the failing questions in the eval? take a few examples and
> worktrhough them"

> "The worry that I have is it'll match the semantic gists and the model forgets that
> there's this temporal parallel axis to read"

> "the retrivial is one thing, what about gists projected back into the haress? how
> will model use those to realize there is time dimension to this question's answer?"

These imply four non-negotiable requirements:

1. Temporal memory is a first-class consolidation and projection axis, not hidden
   metadata on semantic gists.
2. Recent chronology remains fine-grained while distant chronology becomes
   progressively lossy.
3. A matched semantic gist must itself disclose whether its answer depends on an
   evolving temporal trajectory and point at the relevant temporal representation.
4. Retrieval cannot depend on the model remembering that a hidden second index exists.

## Architectural model

Dreamweave will maintain one authoritative evidence substrate with two orthogonal
derived memory families:

```text
                                     semantic consolidation
dated episodic evidence ------------------------------------------> semantic gist
         |
         |
         +---------------- temporal consolidation ----------------> chronicle
```

### Episode

- An immutable, source-dated observation or assertion.
- Carries exact wording, `source_day`, entity/aspect links, and correction/sequence
  relationships.
- Is the authoritative evidence for exact dates, numbers, attribution, and event order.
- May demote from active detail to archive, but consolidation never rewrites its fact
  or destroys its temporal topology.

### Semantic gist

- Captures enduring meaning: a rule, policy, relationship, current understanding,
  repeated pattern, or important transition.
- Routes by subject and meaning.
- Is not itself assigned a fabricated event date.
- May retain temporal language when time is semantically significant, such as
  "after the June approval," but does not replace the full chronology.
- Declares its temporal character and exposes relevant chronicle routes in projection.

### Chronicle

- A first-class, lossy, ordered temporal memory over a closed period.
- Captures what happened, what stayed stable, what changed, and the important
  before/change/after landmarks.
- Links every summary entry to existing episode or lower-resolution chronicle
  evidence.
- Routes by period, entity, aspect, and transition.
- Supports broad temporal narrative directly; exact claims remain expandable to
  source-dated episodes.

The two index families may reference the same episode. That is not duplicate truth:
the episode is the sole evidence record, while gist and chronicle are different
retrieval doors.

## Multi-resolution temporal pyramid

Chronicles use immutable calendar windows:

```text
episodes -> day -> week -> month -> quarter -> year when justified
```

Examples:

- day: an ordered account of the day's meaningful state changes;
- week: a Monday-through-Sunday account retaining day landmarks;
- month: major weekly transitions, persistent themes, and significant events;
- quarter/year: only durable transitions and major periods when the caller judges
  that a useful abstraction exists.

Windows do not roll indefinitely. A June chronicle cannot absorb January evidence,
and the newest week cannot become a survivor that recursively owns the entire year.

### Temporal resolution frontier

Recency bias comes from active resolution, not from overwriting history:

- recent periods remain active at day resolution;
- older periods are represented primarily by week;
- still older periods are represented primarily by month or quarter;
- finer children demote only after a valid parent chronicle covers their period;
- salient or frequently reactivated periods may retain finer active resolution;
- archived chronicles and episodes remain recallable.

At any historical interval, active temporal memory retains the finest resolution
justified by recency, importance, and use. This keeps the active temporal skyline
bounded while preserving lossless evidence in colder storage.

## Chronicle data model

Chronicles remain `nodes` so they participate in strength, salience, projection, and
recall, with normalized temporal metadata:

```text
chronicles(
  node_sig,
  resolution,          -- day|week|month|quarter|year
  period_start,
  period_end,
  version,
  compression_level,
  covered_event_count,
  omitted_event_count,
  latest_event_day
)

chronicle_entries(
  chronicle_sig,
  ordinal,
  slot_label,          -- Monday, week 2, early June, etc.
  summary,
  change_kind,         -- continuity|introduced|changed|resolved|reversed|completed
  state_label,         -- caller wording such as pending|posted|confirmed
  aspect
)

chronicle_evidence(
  chronicle_sig,
  entry_ordinal,
  evidence_sig
)

chronicle_entry_entities(
  chronicle_sig,
  entry_ordinal,
  entity_sig
)

gist_landmarks(
  gist_sig,
  role,                -- before|change|current
  ordinal,
  evidence_sig
)

evidence_transitions(
  src_sig,
  rel,                 -- sequence|supersedes
  dst_sig,
  first_seen,
  last_reinforced
)
```

Additional graph relationships:

- `chronicle_of`: chronicle to covered episode or child chronicle;
- `next_period`: adjacent chronicles at the same resolution;
- `evidence_transitions`: durable sequence and correction topology that survives
  Tier-3 demotion without keeping an archived node in the active semantic graph;
- `detail_of`: semantic gist to evidence;
- shared evidence provides the exact join between semantic and temporal axes.

Chronicle prose is lossy, but its coverage manifest remains complete: episodes omitted
from the prose summary are still linked and searchable within the period.

Chronicles use `kind='chronicle'`, not `kind='fact'`. Every existing `kind='fact'`
scope must be reviewed explicitly:

- semantic merge, salience, and ordinary weave exclude chronicles;
- recall KNN and keyword surfaces search both kinds but return them in separate groups;
- archive demotion preserves `chronicle_evidence` and `evidence_transitions`;
- `exportHarness`, `dump-active`, visualization, doctor, and projection sync render
  chronicles through their own typed path;
- a chronicle can never become a member of a semantic fact merge.

There is one canonical chronicle per calendar period, resolution, and version, rather
than one chronicle per subject. Its entries carry entity/aspect facets. This keeps
chronicle growth proportional to elapsed periods, while semantic gists route to the
relevant entries through shared evidence.

## Caller-owned temporal judgment

The engine remains local-only and never invokes an LLM. It deterministically emits
candidates; the caller LLM decides meaning through report -> judge -> apply.

### Temporally aware semantic merge report

Each merge member must include:

```json
{
  "sig": "fact:...",
  "fact": "...",
  "sourceDay": "2026-06-25",
  "tier": "episodic|detail|gist",
  "evidenceStart": "2026-01-01",
  "evidenceEnd": "2026-06-25",
  "latestEvidenceDay": "2026-06-25",
  "detailCount": 64,
  "supersededBy": null
}
```

Members are presented in temporal order. Prior gists disclose their inherited breadth,
preventing a narrow-looking headline from silently importing months of lineage.

The judge returns:

```json
{
  "merge": true,
  "form": "atemporal|trajectory|recurring|period-bound",
  "fact": "...",
  "keepStrongest": 2,
  "landmarks": {
    "before": ["fact:..."],
    "change": ["fact:..."],
    "current": ["fact:..."]
  }
}
```

- `atemporal`: redundant expressions of a stable invariant;
- `trajectory`: distinct states whose order is important;
- `recurring`: repeated episodes supporting a pattern;
- `period-bound`: meaning is inseparable from a bounded period;
- refusal remains valid when compression would erase subject, aspect, or chronology.

The engine validates all signatures and computes all dates. The caller cannot invent
an evidence member or move an event outside its source period.

`gist_landmarks` persists the judge-selected before/change/current evidence roles.
Those stored landmarks are the deterministic source of the semantic envelope's compact
transition sketch. Chronicle entries are the source of period narratives. Neither is
silently inferred from prose during projection.

### Chronicle report

Once a period closes, the engine emits its dated episodes and/or immediate child
chronicles in order. The caller returns:

```json
{
  "resolution": "week",
  "periodStart": "2026-06-22",
  "periodEnd": "2026-06-28",
  "summary": "Customer scheduling and family travel preparation dominated the week.",
  "entries": [
    {
      "slot": "Wednesday",
      "summary": "Caldwell's reschedule remained blocked pending approval.",
      "changeKind": "changed",
      "stateLabel": "pending",
      "aspect": "customer-reschedule",
      "entitySigs": ["person:theresa-caldwell"],
      "evidenceSigs": ["fact:..."]
    },
    {
      "slot": "Thursday",
      "summary": "The approved destination-neutral reschedule note was sent.",
      "changeKind": "completed",
      "stateLabel": "sent",
      "aspect": "customer-reschedule",
      "entitySigs": ["person:theresa-caldwell"],
      "evidenceSigs": ["fact:..."]
    }
  ]
}
```

Apply is report-bound and atomic. Period bounds, ordering, membership, evidence
coverage, and duplicate versions are engine-validated.

### Late evidence and correction

Closed chronicles are immutable. Late-arriving or corrected evidence produces a new
chronicle version that supersedes the prior version. The previous version demotes;
historical summaries are not rewritten nightly. Parent rollups consume only the latest
valid child versions.

A late correction invalidates at most one ancestor path: day -> week -> month ->
quarter -> year. A consolidation run may create at most one new version at each affected
resolution. Each new parent is caller-rejudged from the latest child versions; unrelated
periods are untouched.

## Preserve evidence topology

Semantic merge must stop deleting the temporal graph:

- original `sequence` and `supersedes` relationships are copied into durable
  `evidence_transitions` between retained episode/detail nodes;
- an intra-cluster edge is never rewritten into a gist self-edge and dropped;
- merge may add gist-to-evidence routing edges but does not substitute them for
  evidence-to-evidence chronology;
- active semantic `edges` may be removed during Tier-3 demotion, but durable
  `evidence_transitions`, `chronicle_evidence`, and `detail_of` lineage survive;
- existing stores receive an additive, idempotent topology repair based on trustworthy
  source-day and correction evidence;
- ambiguous same-day ordering is left unordered rather than fabricated.

Chronicle entry order and evidence links provide a second reconstructable temporal
structure without replacing the source graph.

## Projection contract

Projection must not emit bare, answer-looking gist strings. It emits typed memory
envelopes whose temporal affordances are visible in ordinary flat harness memory.

### Projection surfaces

The contract must be implemented on all three real surfaces:

1. **Live flat projection:** `exportHarness()` emits semantic and chronicle envelopes
   into the host's Tier-1 injected memories.
2. **Evaluation/tool recall:** `recall.js` returns temporal form, landmarks, companion
   family, and chronicle metadata on result nodes; `dream-search.ts` renders the same
   disclosure into `memory_search` snippets. The current OpenClaw evaluation has no
   separate flat-injection step, so this surface is mandatory for benchmark impact.
   Legacy `Q:\src\recall\bench-harnesses\{agent-memory,dream-memory}\index.mjs`
   adapters must likewise replace their `kind==='fact'` filters and flat
   `cluster.nodes` truncation with typed-array consumption if those profiles remain
   supported.
3. **File/detail reads:** `dump-active.js`, `DreamConsolidator.writeFactFiles()`, and
   `exportConsolidatedMarkdown()` render the same envelope in files read by
   `memory_get`.

A shared deterministic renderer must produce equivalent semantics across the surfaces.
Projection and recall never invoke an LLM.

### Semantic envelope

```text
[SEMANTIC MEMORY · EVOLVING]

Subject: Riley school conference
Current understanding: The conference settled on January 14.

Temporal shape:
This memory changed through distinct pending, posted, and confirmed states.
Do not treat those states as simultaneous.

Available timeline:
Week of 2026-01-05 · 3 dated transitions
pending -> portal posted -> confirmed

For exact timing or sequence, consult the linked temporal memory.
```

The stored gist does not permanently embed a specific chronicle ID. It carries a stable
memory-family key and persisted landmark sketch. The active day/week/month companion
uses the same family key. This avoids rewriting and re-embedding every gist when the
active temporal resolution changes while still allowing export and recall to resolve
the current companion through shared evidence.

### Chronicle envelope

```text
[TEMPORAL MEMORY · WEEK · 2026-01-05--2026-01-11]

Riley school conference:
- Jan 6 -- Schedule had not been posted.
- Jan 7 -- Portal posted the Jan 14 conference window.
- Jan 8 -- Jan 14 was confirmed; exact time remained pending.

Evidence: 3 dated episodes
Compression: low
Exact claims can be expanded to source evidence.
```

Chronicles are projected as first-class memories without pretending that the chronicle
itself was observed on one fabricated `createdAt`. Period bounds remain explicit in the
text and structured engine output.

### Temporal skyline and projection budget

The harness projection contains semantic and temporal allocations within the existing
single Tier-1 cap:

```text
SEMANTIC MEMORY
- stable rules, relationships, patterns, and current understanding

TEMPORAL MEMORY
- recent day chronicles
- earlier week chronicles
- older month/quarter chronicles
```

The default contract reserves up to 20% of the existing Tier-1 cap for the temporal
skyline when eligible chronicles exist; unused temporal capacity returns to semantic
memory. It does not increase the physical cap. Projection selects a non-overlapping
skyline so the same period is not redundantly injected at day, week, and month
resolution unless salience or reactivation justifies the overlap.

`exportHarness()` enforces the combined projection budget using the existing
`ENTRY_MAX`; when eligible chronicles exist, semantic facts receive at most 80% and
chronicles receive up to 20%, with unused chronicle slots returned to facts. This is a
projection selection rule separate from the larger Tier-2 storage cap. The evaluation
mirrors the typed reservation in `dream-search.ts`; legacy benchmark adapters mirror it
in their `buildContext()` functions.

This does not globally reorder mixed recall results by time. Semantic memories retain
their relevance/strength ordering, temporal memories retain their own ordering, and
the retrieval adapter presents typed groups. The prior factual/synthesis regression
from a single gist-then-timeline ordering must remain a validation tripwire.

Authority is explicit:

```text
episode/detail/archive evidence > chronicle temporal overview > semantic gist
```

Chronicles may answer a broad "what happened that week?" narrative. Exact dates,
numbers, quotations, attribution, and correction state must remain expandable and
traceable to the linked evidence.

## Paired-axis retrieval

The user's concern that the model will match a semantic gist and forget the parallel
timeline is valid. The temporal axis therefore cannot depend only on an extra prompt or
optional hidden tool.

Every search returns independently ranked groups:

```text
semanticHits[]
temporalRoutes[]
evidenceHits[]
```

- each group has reserved capacity;
- semantic similarity cannot displace all temporal routes or exact evidence;
- explicit date expressions constrain temporal lookup deterministically;
- a semantic hit exposes related chronicles through shared evidence;
- a chronicle exposes its linked semantic subjects and exact evidence;
- ordinary non-temporal queries may ignore an empty or irrelevant temporal group.

`recall.js` will add top-level `semanticHits`, `temporalRoutes`, and `evidenceHits`
arrays while retaining `cluster.nodes` during compatibility migration. The OpenClaw
adapter must consume the typed arrays directly. `dream-search.ts` reserves output slots
for temporal and evidence groups before its final truncation, just as it currently
reserves sequence-chain members; the final `slice(0, k)` may not evict those slots.

The first tool response renders all three compact groups. The dedicated timeline tool
is for expansion and reconstruction, not for discovering that the temporal axis exists.

Temporal retrieval surface:

```text
memory_timeline(
  query,
  route?,
  from?,
  to?,
  at?,
  asOf?,
  entities?,
  aspect?,
  resolution?,
  includePreviousChange?,
  includeNextChange?,
  expandEvidence?
)
```

This preserves caller agency: the LLM chooses the appropriate route, aspect, and
resolution. Robustness does not depend on the caller remembering that the route exists,
because the first search visibly presents it.

## Failure-question walkthroughs

### q010: Riley conference posted versus confirmed

Current retrieval surfaced January 8 confirmation more prominently than the January 7
portal-posting episode, causing the model to answer that the conference was posted on
January 8.

The weekly chronicle preserves:

```text
Jan 6 not posted -> Jan 7 posted -> Jan 8 confirmed
```

The projected semantic gist declares `trajectory`, exposes the week companion, and warns
that posting and confirmation are distinct states. Exact evidence establishes January
14 as the conference date and January 7 as the posting date.

### q313: Caldwell June reschedule

Current searches repeatedly returned the January-February Caldwell escalation gist and
missed the June 24-25 transition.

The June 22-28 chronicle preserves:

```text
Jun 24 send blocked pending approval -> Jun 25 sent
```

An explicit June 25 query independently searches the temporal group, so the old
semantic Caldwell incident cannot consume the June timeline slots. The timeline call
can request the target state plus the previous change.

### q267: weekend to workweek posture

Current retrieval returned the May 31 endpoint and generic weekday guidance but omitted
the Monday-Tuesday workweek evidence.

The transition crosses a fixed Sunday/Monday week boundary. It is reconstructed by
stitching adjacent day chronicles through `next_period`, not by creating a rolling week
that violates calendar-window identity:

```text
Sun: quiet maintenance and conservative triage
Mon-Tue: protected preparation and sequencing around June close, ERP, and board timing
```

The semantic gist records the recurring weekend-to-weekday pattern; the May 31, June 1,
and June 2 day chronicles and exact evidence supply the requested occurrence. Older
versions may route through adjacent week/month entries, but exact endpoint evidence
remains the final authority.

### q401: friend support versus parent medical care

Current semantic search matched Jamie's parent's managed-care family because it shared
Jamie, illness, support, and the same date.

The August 15-16 chronicle partitions entries by entity/aspect while sharing one period:

```text
friend support: flowers, meal delivery, short personal note
parent care: private managed-care coordination
```

Temporal lookup first bounds the weekend, then filters by the caller-selected
friend/illness-support aspect. The full coverage manifest retains the friend episode
even if coarser prose later omits the individual actions.

### q118 and q137: temporal endpoints

- q118 uses a timeline ending before March 11 to recover the repeated hold posture
  before the urgent pivot.
- q137 requests the March 12 and March 18 endpoints and returns the exact wording from
  both dated episodes.

These are evidence-stitching cases rather than proof that fine chronicle prose remains
active forever. At long horizons, a coarse chronicle locates the period, while temporal
recall expands archived dated evidence for the precise endpoints.

## Decay, reactivation, and boundedness

- Chronicles use existing strength, salience, reactivation, and tier semantics.
- Chronicle embedding, decay, reactivation, and skyline demotion require explicit
  chronicle-aware code paths because the current loops are `kind='fact'` scoped; they
  may reuse formulas and tuning but not silently rely on fact-only queries.
- Resolution coarsening is a resource policy; semantic significance and summary content
  remain caller-judged.
- Fine chronicles demote only after parent coverage exists.
- Reactivation may retain or restore finer active resolution for a period.
- The active temporal skyline is bounded by resolution-specific capacity and
  non-overlap, not by deleting evidence.
- Chronicle evidence edges are linear in covered members and are never pairwise event
  histories.
- Parent chronicles reference child chronicles and their evidence manifests without
  copying every fact into new node text.
- Doctor reports uncovered periods, overlapping active skyline entries, stale
  chronicle versions, missing evidence, out-of-period evidence, broken ordering,
  temporal self-loops, and cap violations.

## Migration

1. Add chronicle metadata, entry, and evidence tables through idempotent migrations.
2. Preserve all existing source-dated episodes and `detail_of` lineage.
3. Repair only trustworthy episode topology:
   - retain surviving `sequence`/`supersedes`;
   - copy evidence-level relationships into `evidence_transitions`;
   - remap a gist-attached transition to details only when lineage, source day, and
     subject/aspect identify unique endpoints;
   - reconstruct order for distinct source days within a coherent subject/aspect only
     when the existing evidence establishes one trajectory;
   - do not invent same-day order or correction semantics.
4. Compute inherited gist evidence spans and breadth.
5. Rejudge broad existing gists with temporally aware merge reports where needed;
   never automatically rewrite their meaning from dates alone.
6. Build chronicles bottom-up from historical closed periods through the same
   report -> judge -> apply caller loop.
7. Change projection only after companion chronicles exist, avoiding dangling
   temporal routes.

Migration measurements must identify the exact source DB path, checkpoint/as-of date,
and schema version. The 2,129-gist / 12-sequence / one-supersedes measurements above
refer to the active 500-day candidate at approximately day 350; older 180-day stores
have materially different topology and are not substitutes for migration sizing.

Historical backfill is bounded by elapsed calendar periods: at 500 days, approximately
500 day reports, 72 week reports, 17 month reports, and a small number of quarter/year
reports. Parent reports consume child chronicles rather than the full raw corpus.

## Implementation phases

### Phase T1: Restore temporal evidence integrity

- Extend merge reports and caller merge judgment with ordered temporal context,
  inherited span, member tier, breadth, temporal form, and landmark references.
- Preserve intra-cluster sequence and supersession topology.
- Introduce durable `evidence_transitions` so archive demotion and synthesis cannot
  destroy temporal relationships.
- Add doctor and regression coverage for topology preservation and semantic snowballs.
- Add additive migration for existing trustworthy topology.
- Enumerate and classify every hard-coded `kind='fact'` scope across dream, recall,
  export, dump, schema, visualization, and adapters so chronicles are neither silently
  dropped nor admitted to semantic-only mutation paths.

### Phase T2: Chronicle storage and caller surfaces

- Add chronicle schema and lifecycle helpers.
- Implement closed-period candidate reports for day and week.
- Implement caller judge contract and atomic apply.
- Add immutable versioning, supersession, and coverage validation.
- Add month/quarter rollup using child chronicles after day/week behavior is correct.

### Phase T3: Temporally aware projection

- Emit semantic memory envelopes with temporal character and derived companion routes.
- Emit a bounded non-overlapping temporal skyline.
- Implement the shared envelope on `exportHarness`, `recall.js`/`dream-search.ts`, and
  `dump-active`/`memory_get`, acknowledging that the current eval uses the latter two
  rather than flat injection.
- Preserve the flat harness contract while making temporal affordances readable in text.
- Update projection synchronization, memory-usage instructions, and live skills.

### Phase T4: Paired semantic/temporal recall

- Add first-class chronicle indexing and ranking.
- Return typed semantic, temporal, and evidence groups from the engine and preserve
  their reserved slots through adapter truncation.
- Add timeline lookup by route, range, as-of, entity, aspect, resolution, and adjacent
  changes.
- Order expanded evidence chronologically and expose exact source provenance.
- Update OpenClaw tool schemas and agent instructions.

### Phase T5: Historical migration and validation

- Build chronicles on a copy of the live 500-day candidate DB.
- Replay q010, q313, q267, q401, q118, q137, and the complete known temporal failure
  set against real projection and recall.
- Measure active projection size, chronicle count by resolution, edge growth,
  consolidation runtime, and query latency.
- Run the full local suite, harness integration, and live-copy validation.
- Run a validated 180-day regression guard, reusing the unchanged same-corpus baseline.
- Run one new validated-fixture 500-day candidate and compare per question.

## Acceptance criteria

The design is complete only when:

- merge never destroys evidence sequence or supersession;
- every evolving projected gist visibly exposes temporal shape and an active companion;
- temporal companions remain discoverable through flat injection, `memory_search`
  snippets, and `memory_get` files without engine-private metadata;
- semantic hits cannot crowd all temporal/evidence results out of recall;
- the OpenClaw adapter preserves engine-reserved temporal/evidence slots after final
  ranking and truncation;
- chronicle summaries never contain out-of-period or unreferenced events;
- exact claims remain traceable to source-dated episodes;
- archive demotion and synthesis preserve durable evidence transitions;
- active timeline resolution becomes coarser with age while archived detail remains
  recoverable;
- storage and nightly work grow linearly with evidence and period coverage;
- the targeted temporal failures retrieve both required endpoints/aspects;
- 180-day factual, synthesis, negative-recall, and temporal categories do not materially
  regress;
- the validated 500-day temporal score recovers without sacrificing the bounded
  reactivation-storage improvement;
- no commit is pushed until unit, live harness, and evaluation gates pass.

## Phase P - Ingest-time O(N^2) perf fix (2026-07-19)

The first full 500-day run surfaced super-linear ingest growth (day200=582s ->
day390=6048s while the corpus only ~doubled). Root cause: the AUTO-REACTIVATE cue
expansion in `dreamCoreImpl` fanned out over EVERY fact mentioning a shared entity
with no degree cap, so ubiquitous connector hubs (topic:family, org:park-household,
person:jamie-park, ...) re-cued ~19k siblings per new fact. This is:

- foundational/pre-existing (present since scaffold 8ce9162 and in committed HEAD),
  only latent until 500d pushed the graph to ~20k facts / ~19k-degree hubs; and
- amplified by the (uncommitted) reactivation_members persistence, which turned the
  transient fan-out into an 885k-row / 171 MB DB bloat plus per-pair writes.

Fixes (src/dream.js):

1. AUTO-REACTIVATE ubiquity guard: compute `specificHubState(db)` once and skip cue
   expansion for any mentioned entity whose `mentions` in-degree exceeds `maxDegree`
   (= max(8, ceil(0.20 * active))). Reuses the exact cut the schema-fit / demotion
   paths already apply; a fact sharing only a ubiquitous hub carries no real recurrence
   signal. This also guts the reactivation_members bloat (those hubs were its top
   families) so no separate member-pruning dimension was added.
2. decayEdges: skip rels whose decay factor is exactly 1.0 (mentions, supersedes,
   sequence) instead of reading all ~506k edges each night to write a no-op.

Validation:

- 40/40 unit files pass (reactivation-synthesis bounded-family test diluted with 150
  filler facts so its stress hub stays a SPECIFIC entity, preserving the counter /
  example-cap intent under the new guard).
- Structural probe on the real day-390 snapshot: one night's fan-out drops
  5,081,309 -> 369,285 inner iterations (-92.7%), skipping 34 ubiquitous hubs.
- Next: q077 temporal gate, then a fresh full 500-day run watching temporal-reasoning.
