---
name: "graph-recall"
description: "Expands memory through graph and vector recall."
version: "1.0.0"
license: "MIT"
platforms: [linux, macos]
metadata:
  hermes:
    category: "memory"
    tags: ["memory", "dreamweave", "recall"]
    related_skills: ["dream"]
---

# Graph Recall Skill

Use Dreamweave for questions involving stored people, systems, incidents, releases, dates, decisions, or prior threads. It combines vector seeds with graph neighbors and archive fallback.

## When to Use

Use it whenever a request may depend on persistent memory or is an ambiguous follow-up to a memory-grounded answer. Skip it only for a trivial isolated preference or contact detail already present in context.

## Prerequisites

- The adapter is installed into the selected `$HERMES_HOME` (default `~/.hermes`).
- Engine and daily paths are explicit in `$HERMES_HOME/dreamweave-adapter.json`.
- The isolated database is `$HERMES_HOME/dreamweave-data/memory.db`.
- Node.js is installed and `node` is available on `PATH` (`command -v node`).
- Run the helper with Hermes' `terminal` tool.

## How to Run

```bash
python3 "${HERMES_HOME:-$HOME/.hermes}/scripts/dreamweave.py" recall \
  --query "<user query>" --max-hops 2
```

For questions about order or change over time:

```bash
python3 "${HERMES_HOME:-$HOME/.hermes}/scripts/dreamweave.py" recall \
  --query "how did <thread> change" --timeline --as-of <today>
```

## Quick Reference

- `--query`: required semantic query.
- `--max-hops`: graph depth from 1 to 3; default 2.
- `--seed-limit`: vector seed count from 1 to 8; default 4.
- `--k`: candidate count up to 50; default 12.
- `--as-of`: current or simulated date for time-aware queries.
- `--timeline`: include chronicle routes for genuinely temporal questions.

The JSON exposes three independently ranked lanes:

- `semanticHits`: active gist/standing-memory matches; use these for broad context, not exact dates or figures.
- `evidenceHits`: dated episodic/detail/archive facts; use these to support exact claims.
- `temporalRoutes`: lossy chronicle overviews that route a temporal question to periods and linked evidence. They are always returned as a separate lane, while `--timeline` also appends them to `cluster.nodes`.

Evidence rows carry `source_day`, the authoritative day-level provenance for the fact. `first_seen` is an internal ordering/age field and is not a substitute for `source_day`. A row with `superseded: true` is stale for a current-state answer; follow `superseded_by` and prefer the surviving fact. Historical questions may cite a superseded row when its former validity is relevant and clearly qualified.

## Procedure

1. Search with the user's topic, omitting an as-of date from ordinary semantic queries.
2. Use `--timeline` only for ordering, onset, before/after, or change-over-time questions.
3. Read `semanticHits`, `evidenceHits`, and, when relevant, `temporalRoutes`; use `cluster.nodes` and `cluster.edges` for compatibility and relationship traversal.
4. Ground exact dates, numbers, attribution, and sequence in `evidenceHits` with a non-null `source_day`, not gist or chronicle summaries.
5. For current-state answers, exclude `superseded: true` evidence unless needed to explain a transition; follow `superseded_by` to the replacement.
6. Synthesize only relevant direct hits and one- or two-hop relationships.

## Pitfalls

- Never report a gist evidence-span boundary as an event date.
- Never use a chronicle overview as exact evidence.
- Do not fabricate nodes, edges, or claims.
- Preserve relevance ordering; do not globally reorder results by date.
- If no graph or archive hit exists, say so plainly.

## Verification

Run a query expected to match this installation, then validate the typed lanes and evidence metadata rather than checking only that JSON was emitted:

```bash
out="$(mktemp)"
python3 "${HERMES_HOME:-$HOME/.hermes}/scripts/dreamweave.py" recall \
  --query "Dreamweave memory" --max-hops 2 >"$out"
jq -e '
  (.semanticHits | type == "array") and
  (.evidenceHits | type == "array") and
  (.temporalRoutes | type == "array") and
  (.cluster.nodes | type == "array") and
  (.cluster.edges | type == "array") and
  (((.semanticHits | length) + (.evidenceHits | length)) > 0) and
  (all(.evidenceHits[]; has("source_day") and has("superseded") and has("superseded_by")))
' "$out"
rm -f "$out"
```

If the known query has no match, verification has not passed; choose a fact known to exist in the database and rerun it.
