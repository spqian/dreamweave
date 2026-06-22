---
name: "graph-recall"
description: "Memory expansion over injected memory entries with fast vector + graph cluster lookup."
---

Use this skill as memory expansion on top of injected memory entries.

Triggering and usage policy:
- Invoke this skill whenever a user query may map to existing memory entries (people, systems, incidents, releases, topics, prior decisions, prior threads), including ambiguous follow-ups.
- If there is a memory hit, ALWAYS expand it with graph context. Never stop at the first matching memory line.

Matching policy (semantic/fuzzy):
- Treat query->memory matching as semantic/fuzzy, not verbatim text matching.
- Handle typos, spacing/punctuation variants, and token variants (e.g., 'data-base' should match 'system:database').

Required workflow:
1) Start from injected memory entries in prompt context.
2) If the query appears to match one or more entries, run the vector+graph recall
   (semantic KNN seeds via sqlite-vec, then a recursive-CTE graph walk):

   ```
   node <AGENT_MEMORY>/lib/recall.js --query "<user query>" --max-hops 2
   ```

   - `<AGENT_MEMORY>` is the install dir of this package (the folder containing `lib/` and `config.js`).
   - Returns `seedDetails[].similarity` (cosine, higher = closer) plus `cluster.nodes`/`cluster.edges`.
   - Backend: the SQLite + sqlite-vec store at `$MEMORY_DB` (default `~/.agent-memory/memory.db`),
     vec0 cosine over 384-dim local embeddings (Xenova/all-MiniLM-L6-v2), is the SINGLE SOURCE OF
     TRUTH. The `dream` skill builds and maintains it via `lib/dream.js`
     (nodes are `kind='fact'` or `kind='entity'`; recall seeds on either and expands along
     `mentions`/`related_to` edges).
3) Use returned cluster (seeds, cluster.nodes, cluster.edges) to expand context:
   - direct hit(s)
   - strongest 1-hop links
   - key 2-hop links only when they materially explain the question
4) Synthesize an answer grounded in both injected memory hit(s) and cluster evidence.

Output contract for memory hits:
- Direct answer
- Memory hits (which injected entries matched)
- Expanded context (top related nodes and explicit relationships)
- Why it matters now (short relevance statement)

If no graph hit is found, say so clearly and answer without fabricated links.

Guardrails:
- Do not fabricate nodes, edges, or claims.
- Prefer precision over breadth; keep only relevant links.
- Use graph expansion for memory-hit queries by default.

