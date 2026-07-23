---
name: "graph-recall"
description: "Use INSTEAD OF m_recall for ANY query that may touch stored memory — people, systems, incidents, releases, regions, dates, prior decisions/threads, or ambiguous follow-ups. Expands injected Tier-1 entries via semantic vector seeds + graph-neighbor recall through the Tier 2 store, with keyword fallback into the Tier 3 archive. Always expand on a hit; never stop at the first matching line. Skip only for a trivial, non-cross-linked fact (a single stored preference or contact detail)."
---

Use this skill INSTEAD OF the host's flat memory lookup (`m_recall`) as the default path for memory-touching queries. `recall.js` already starts from the injected Tier-1 entries and runs its own vector seeding, so it is a superset of a flat lookup — running the flat tool first is redundant latency.

Triggering and usage policy:
- ALWAYS run graph-recall when the query references a person, system, incident, release, region, date, or prior decision/thread, OR is an ambiguous follow-up to a prior memory-grounded answer.
- On any memory hit, ALWAYS expand it with graph context. Never stop at the first matching memory line.
- SKIP (a plain lookup is fine) only for a trivial, non-cross-linked fact with no expansion value (e.g., a single stored preference or "what's my manager's email").
- Every gist is a semantic routing index, not authoritative evidence for an exact date, number, attribution, sequence, or exhaustive list. Use the episodic/detail rows returned beside it for exact claims; if no detail supports the claim, run a more specific recall and only then report "not found." A gist's derived evidence span describes its children and is never a source citation.
- **Temporal questions use the `--timeline` route (YOU decide, from the question — not the engine).** Plain recall is semantic and deliberately returns NO period chronicles in its cluster. Add `--timeline` ONLY when the question is about *order or change over time* — "when did…", "when did X first…/onset", "before/after…", "how did X change over…", "between <A> and <B>", the ordered progression of some thread — to surface the fixed-period **chronicle** overviews plus their exact dated evidence. **A bare "what was X as of <date>" is NOT a timeline question** — it is a plain topic search: run recall WITHOUT `--timeline`, do NOT paste the as-of date into the query (a date in the query text skews ranking toward that exact day and can bury the answer that lives a day or two away), and then keep the latest returned dated detail on-or-before the target date. The date is a filter you apply to the returned evidence, not a term you search with. For an ordinary "what is / who said / what's the value" question likewise do NOT add `--timeline`; the precise dated fact lives in the semantic evidence rows and a lossy period overview would only crowd it out. This is a judgment call the model makes from the phrasing, exactly like choosing a tool — it is not an engine date-parser. (Chronicle overviews are also injected flat in your Tier-1 context, so you can see a timeline exists even before you route into it.)
- **A chronicle / temporal-route overview is LOSSY by design — a map of WHEN to look, never the source of an exact fact.** Never state an exact date, number, attribution, or a "first/onset/when" answer from a chronicle overview alone. The overview points you at a period; to make the precise claim you MUST open that period's dated evidence — the `evidenceHits` / dated `detail` rows the timeline returns beside each chronicle (drill further with a more specific recall if needed) — and cite that dated record. A period overview that says a thing "moved" or "changed" is a pointer to the day it happened, not that day itself: read the underlying dated evidence to pin the actual onset date before answering. Likewise, a gist's derived **evidence date span** (e.g. `evidence 2026-01-01–2026-01-20`) is the RANGE that index covers, NOT an event date — the real date is stated inside the specific detail; never report a span boundary as the event/posted date. Conversely, do not over-drill: if a returned detail already states the exact date or number, cite it directly rather than opening more files to re-confirm.

Matching policy (semantic/fuzzy):
- Treat query->memory matching as semantic/fuzzy, not verbatim text matching.
- Handle typos, spacing/punctuation variants, and token variants (e.g., 'data-base' should match 'system:database').

Required workflow:
1) Start from injected Tier 1 memory entries in prompt context (the ~500 "instincts" projection, not the whole store).
2) If the query appears to match one or more entries, run vector+graph recall:

   ```
   node "<AGENT_MEMORY>/src/recall.js" --query "<user query>" --max-hops 2
   ```

   For a temporal question, add `--timeline` (and `--as-of <today>` for date-anchored recall):

   ```
   node "<AGENT_MEMORY>/src/recall.js" --query "how did <thread> change" --timeline --as-of <today>
   ```

   Supported recall flags verified against `src/recall.js`:
   - `--query "<text>"` — required query text.
   - `--max-hops N` — graph expansion depth, clamped to 1..3; default 2.
   - `--seed-limit N` — number of vector seed facts, clamped to 1..8; default 4.
   - `--k N` — KNN candidate count, clamped to seed limit..50; default 12.
   - `--as-of <iso>` — anchors "now" for date-aware recall. Resolves natural-language and RELATIVE dates in the query ("last week", "yesterday", "past 3 days", "last month", "recently") into a concrete time window so temporal queries surface time-indexed facts. Pass the current/simulated date on any time query; defaults to system now.
   - `--timeline` — the opt-in **temporal axis**. Off by default: plain recall returns only semantic fact clusters (no chronicles). With `--timeline`, the returned `cluster.nodes` also leads with the fixed day/week/month/quarter/year **chronicle** overviews for the query (and, with `--as-of` + a dated query, the periods overlapping that window), each paired with its exact dated evidence. Add it ONLY for genuinely temporal questions (see the temporal-questions policy above); it is your explicit choice, not an engine heuristic. Semantic-lane consumers can also read the always-present `temporalRoutes` array without opting in.

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
   - for every gist used, the supporting `detail` / `archive_detail` evidence for exact claims
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