# Projection sync — writing the consolidated db back into the harness

This is the runbook the **host LLM** (Clawpilot / Scout / any caller) follows for **stage 7 (PROJECT)**
of the nightly dream: reconcile the flat harness memory with the engine's consolidated projection, and
teach the db the harness ids it assigns. It is the step that finally produces a **non-zero diff** once
consolidation is routed through `apply-*` (see `SKILL.md` stage 5).

> All engine calls: `node <AGENT_MEMORY>/src/dream.js <cmd>` with `AGENT_MEMORY_DIR` pointing at the live
> data dir (default `~/.dream-memory`). Host memory ops are shown as `m_list_memories` / `m_remember` /
> `m_forget` — substitute your host's equivalents.

## Mental model
- **The db is the source of truth. The harness is a disposable projection of it.** After consolidation,
  the db holds three tiers; only **Tier 1** (gist + un-merged active facts) is injected into the harness.
- A **merge/synthesis survivor is born inside the db**, signature-first, with **`memory_id = ""`** — it has
  never existed in the harness. Projecting it (m_remember → capture id → record-projection) is what creates
  the diff. Its merged constituents are demoted to **`notes='detail'`** (kept for recall, **not** injected).
- Historically the live harness produced **zero diff every night** because caller judgment/apply was
  skipped: no survivor was ever born in the db, so `export-harness` only re-emitted ids the harness already had.
  With stage 5 now routing through `apply-merges`/`apply-synthesis`, survivors exist — this runbook ships them.

## Preconditions (must already hold when you reach this stage)
1. This run already did **INGEST + `verify-sync`** on the fresh morning harness → **db ⊇ harness** (every
   harness id is a node in the db). Do not start projection if `verify-sync` did not pass.
2. `dream` / `weave` / the five `report→judge→apply` surfaces have run.
3. `doctor` is clean (`fact_islands=0`, `dangling_edges=0`, `healthy=true`).

## Inputs
- **Target projection** — `node <AGENT_MEMORY>/src/dream.js export-harness --as-of <today>` → a JSON array
  `P`. Excludes entity hubs, `detail`, and `archive`. Each record:
  ```json
  { "memory_id": "<harness id or ''>", "signature": "fact:<slug>",
    "category": "decision|fact|context|preference", "tier": "gist|episodic",
    "strength": 0.87, "first_seen": "2026-01-11T...", "age": "months ago|null",
    "fact": "<raw text>", "display": "<inject-ready line; episodic is age-prefixed>" }
  ```
  - `P[0]` is the engine **anchor record** (channel E) — always present; treat like any other record.
    Its id round-trips via the engine's `meta` kv: on a fresh store it emits `memory_id === ""` (so
    the ADD path below m_remembers it and `record-projection` persists the assigned id); afterwards it
    emits that real id so it lands in `exportedIds` and is **KEPT, never FORGOTten**. Always include the
    anchor's `{signature:"memory-usage-anchor", memory_id:<assignedId>}` pair when you ADD it.
  - **`memory_id === ""`** → a **db-native survivor not yet in the harness** → needs a NEW harness memory.
  - **`memory_id === "<id>"`** → already projected → reconcile its text.
- **Current harness** — `m_list_memories` → `H` = `[{ id, fact, category, source, ... }]`.

## Reconcile (compute + apply the diff)
Build `exportedIds = { every non-empty P[i].memory_id }`. Then:

### 1. ADD — project the new survivors
For each `r` in `P` with `r.memory_id === ""`:
1. `m_remember` the fact with **attribution mapped from the record** (see table below) — use `r.display`
   as the text.
2. Capture the harness id the tool returns → `assignedId`.
3. Append `{ "signature": r.signature, "memory_id": assignedId }` to `projPairs`.

### 2. FORGET — shrink the flat list ("forget the raw parts")
For each harness memory `h` in `H` whose `h.id` is **NOT** in `exportedIds`:
- `m_forget(h.id)`.
- These are the merged constituents now demoted to `detail`, plus any `archive` rows. They **remain in the
  db** and stay recallable via `recall`; they are simply no longer injected into Tier 1.
- **Safe because** `verify-sync` passed (db ⊇ harness), so every `h.id` is a known db node; absence from the
  export means the engine intentionally demoted it, never data loss.

### 3. UPDATE — re-project changed text
For each `r` in `P` with a non-empty `memory_id` that matches some `h` in `H` **whose underlying fact
changed** — compare `r.fact` against `h`'s text with any leading age prefix stripped,
i.e. `r.fact !== stripAge(h.fact)` where `stripAge(t) = t.replace(/^\[[^\]]+\]\s+/, "")`
(a gist got re-summarized, or a supersede rewrite changed it):
- `m_forget(h.id)`, then `m_remember(r.display, …attribution…)`, capture the new id, and append
  `{ signature: r.signature, memory_id: newId }` to `projPairs`.
- (If your host has an in-place update that preserves the id, use it and still record the pair.)

> **Diff on the fact, NOT `r.display`.** Episodic `display` is age-prefixed (`[past couple weeks] …`),
> and that prefix drifts as time passes. Comparing `r.display` would flag a memory as "changed" every
> time its age bucket rolls over, triggering a needless `m_forget`+`m_remember` — pure churn that
> re-creates the memory (and risks a host resetting its `createdAt`) even though nothing meaningful
> changed. Comparing the stripped fact means we only re-create on a genuine content change. Tradeoff:
> an untouched memory's injected age tag can lag one bucket until the fact itself changes; refresh age
> tags deliberately (a periodic full re-project) rather than on every rollover.

### 4. KEEP — no-op
`r.memory_id` present in `H` and `r.fact === stripAge(h.fact)` → do nothing (even if the age tag differs).

## Attribution mapping (export record → harness memory)
Set these on every `m_remember` you issue in ADD/UPDATE. The point is that a projected survivor must read
as a **consolidation-born dream memory**, not a fresh session note:

| harness field | value from the record |
|---|---|
| text/content | `r.display` (episodic already age-prefixed; gist is timeless) |
| `category`    | `r.category` |
| `source`      | **`"dream"`** (or `"consolidation"`) — **never** `"session"` |
| `createdAt`   | `r.first_seen` — **preserve it; do not reset to now** |
| tier hint     | `r.tier` (`gist`/`episodic`) if the host stores a tier/tag |

> **`createdAt` is load-bearing and MUST round-trip.** Every recreate (ADD and UPDATE) passes
> `createdAt = r.first_seen`, which is now the memory's real event date. If the host `m_remember`
> silently stamps its own "now" instead of honoring this argument, then every diff-driven recreate
> launders the event date away — the exact failure that collapsed a whole store onto ingest/rebuild
> dates. **Verify once** that the host honors it: after a projection that recreated ≥1 memory,
> re-read that memory and confirm its `createdAt` equals the `first_seen` you sent (not ~now). If it
> doesn't, that's a **host bug** — stop relying on `createdAt` as the event-date source and treat the
> engine's `repair-dates` (in-text dates) as the source of truth until the host is fixed.
> If the host `m_remember` cannot set `source`/`createdAt`, project anyway but record the limitation — the
> db-side provenance (tier, vagueness, first_seen) still lives in the engine; the harness copy is only a
> projection. The **must-have** is that survivors are projected and `record-projection` runs.

## Teach the db the assigned ids
Write `projPairs` to `projection.json` and run:
```bash
node <AGENT_MEMORY>/src/dream.js record-projection --file projection.json
```
This sets `memory_id` on each survivor node (matched by `signature`). Tomorrow's ingest will recognize the
survivor by its id and **refresh** it instead of creating a duplicate — the loop becomes idempotent.

## Confirm alignment
1. `m_list_memories` → fresh `snapshot.json`.
2. `node <AGENT_MEMORY>/src/dream.js ingest-harness --file snapshot.json --prune`
   - `--prune` tombstones only **Tier-1 projected** facts the user deleted from the harness during the day.
   - It **excludes `detail`/`archive`** — demoted tiers are db-internal and are meant to be absent from the
     flat list, so they are never pruned. (Verified: pruning a snapshot that omits 3830 detail rows deletes 0.)
3. `node <AGENT_MEMORY>/src/dream.js verify-sync --file snapshot.json` → must pass (db ⊇ harness).

## Verification checklist (a healthy live night)
- `dream_journal` shows `merge`/`bridge` ops (not just `keep`).
- Some nodes now have `notes='gist'` and `vagueness > 0` (`stats` / a quick db query).
- `export-harness` emits ≥1 record with `memory_id === ""` (a survivor to project).
- After ADD + `record-projection`, those survivors have real ids and the **harness memory count changed**
  (survivors added, merged raw parts forgotten) → **non-zero diff**.
- Projected survivors read `source:"dream"` (or your host's equivalent), not `"session"`.
- `verify-sync` passes; `doctor` clean.

## Pseudocode
```text
P = export-harness --as-of today            # target projection (array)
H = m_list_memories                         # current flat harness
exportedIds = { r.memory_id for r in P if r.memory_id != "" }
stripAge = t -> t.replace(/^\[[^\]]+\]\s+/, "")   # drop the age prefix from a stored display
projPairs = []

# 1. ADD new survivors
for r in P where r.memory_id == "":
    id = m_remember(r.display, category=r.category, source="dream", createdAt=r.first_seen)
    projPairs += { signature: r.signature, memory_id: id }

# 2. FORGET demoted / removed
for h in H where h.id not in exportedIds:
    m_forget(h.id)

# 3. UPDATE changed  (compare the FACT, not the age-prefixed display -> no churn on age rollover)
for r in P where r.memory_id != "" and r.fact != stripAge(text_of(H, r.memory_id)):
    m_forget(r.memory_id)
    id = m_remember(r.display, category=r.category, source="dream", createdAt=r.first_seen)
    projPairs += { signature: r.signature, memory_id: id }

# teach the db
write projection.json = projPairs
record-projection --file projection.json

# confirm
snapshot = m_list_memories
ingest-harness --file snapshot --prune     # detail/archive protected
verify-sync --file snapshot                # must pass
```

## Safety rails
- **Never project before `verify-sync` passed** at INGEST — projection assumes db ⊇ harness.
- **`memory_id` is identity** — reconcile and `record-projection` key on it; a survivor's `signature` is
  the stable join key between db and the pairs file, never dedup on text.
- **Demote, don't delete** — the FORGET step removes facts from the *flat list only*; they persist as
  `detail`/`archive` in the db and stay recallable. Do not `m_forget` a memory whose id is still in the
  export set.
- **No fabrication** — projection only ships what the engine emitted; never edit fact text here.
