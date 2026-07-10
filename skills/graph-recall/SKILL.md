---
name: "graph-recall"
description: "Use INSTEAD OF m_recall for ANY query that may touch stored memory — people, systems, incidents, releases, regions, dates, prior decisions/threads, or ambiguous follow-ups. Expands injected Tier-1 entries via semantic vector seeds + graph-neighbor recall through the Tier 2 store, with keyword fallback into the Tier 3 archive. Always expand on a hit; never stop at the first matching line. Skip only for a trivial, non-cross-linked fact (a single stored preference or contact detail)."
---

Use this skill INSTEAD OF the host's flat memory lookup (`m_recall`) as the default path for memory-touching queries. `recall.js` already starts from the injected Tier-1 entries and runs its own vector seeding, so it is a superset of a flat lookup — running the flat tool first is redundant latency.

Triggering and usage policy:
- ALWAYS run graph-recall when the query references a person, system, incident, release, region, date, or prior decision/thread, OR is an ambiguous follow-up to a prior memory-grounded answer.
- On any memory hit, ALWAYS expand it with graph context. Never stop at the first matching memory line.
- SKIP (a plain lookup is fine) only for a trivial, non-cross-linked fact with no expansion value (e.g., a single stored preference or "what's my manager's email").
- Compressed / generalized summaries: if a matched entry is marked as a generalized summary or says a value was compressed/omitted (a "vagueness" hint on a gist), do NOT answer an exact figure/date or enumerate a list from it directly — run recall for the specific value first, and only report "not found" after that specific recall returns nothing. Exact numbers and dates are retained in the store even when the summary omits them.

Matching policy (semantic/fuzzy):
- Treat query->memory matching as semantic/fuzzy, not verbatim text matching.
- Handle typos, spacing/punctuation variants, and token variants (e.g., 'data-base' should match 'system:database').

Required workflow:
1) Start from injected Tier 1 memory entries in prompt context (the ~500 "instincts" projection, not the whole store).
2) If the query appears to match one or more entries, run vector+graph recall:

   ```
   node "<AGENT_MEMORY>/src/recall.js" --query "<user query>" --max-hops 2
   ```

   Supported recall flags verified against `src/recall.js`:
   - `--query "<text>"` — required query text.
   - `--max-hops N` — graph expansion depth, clamped to 1..3; default 2.
   - `--seed-limit N` — number of vector seed facts, clamped to 1..8; default 4.
   - `--k N` — KNN candidate count, clamped to seed limit..50; default 12.

   - `<AGENT_MEMORY>` is the install dir of this package (the folder containing `src/` and `config.js`).
   - Returns `seedDetails[].similarity` (cosine, higher = closer) plus `cluster.nodes`/`cluster.edges`.
   - Backend: the SQLite + sqlite-vec store at `$MEMORY_DB` (default `<dataDir>/memory.db`, where `dataDir` is `DREAM_MEMORY_DIR` or `AGENT_MEMORY_DIR`, else `~/.dream-memory`).
   - Embeddings use 384-dim local vectors by default (`MEMORY_MODEL`, default `Xenova/all-MiniLM-L6-v2`; `MEMORY_EMBED_DIM`, default `384`).
   - The `dream` skill builds and maintains the store via `src/dream.js`.
   - Tier 2 recall seeds on `kind='fact'` rows, expands through graph neighbors (`mentions`, `related_to`, `supersedes`, and other stored edges), and returns the connected cluster for synthesis.
   - Tier 3 archive rows (`notes='archive'`) have no vector and no edges; `recall` can still surface them with bounded keyword scan when query terms match.
3) Use returned cluster (seeds, `cluster.nodes`, `cluster.edges`) to expand context:
   - direct hit(s)
   - strongest 1-hop links
   - key 2-hop links only when they materially explain the question
   - archive hits only when specifically relevant
4) Synthesize an answer grounded in both injected memory hit(s) and cluster evidence.

Output contract for memory hits:
- Direct answer
- Memory hits (which injected entries matched)
- Expanded context (top related nodes and explicit relationships)
- Why it matters now (short relevance statement)

If no graph or archive hit is found, say so clearly and answer without fabricated links.

Guardrails:
- Do not fabricate nodes, edges, or claims.
- Prefer precision over breadth; keep only relevant links.
- Preserve relevance ordering from recall; do not globally reorder retrieved context by time.
- Use graph expansion for memory-hit queries by default.