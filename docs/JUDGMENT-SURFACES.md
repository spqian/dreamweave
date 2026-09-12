# Dreamweave judgment-surface contract

This is the canonical, host-neutral contract for Dreamweave’s six caller-judged
surfaces. Host adapters own transport, audit envelopes, checkpointing, projection,
and scheduling. They must preserve these engine payload schemas and semantic
invariants rather than defining another skill with the same global name.

## Report → caller judges → apply
   The engine is **local-only and never calls an LLM**: it emits candidate JSON (`report-*`), the
   **caller (host LLM) is the judge**, and the engine applies the caller's decision (`apply-*`). Run the
   surfaces in this order, each as report → judge → write `decisions.json` → apply:
   **entities → aliases → salience → merges → synthesis → chronicles**. `report-*` are read-only and take `--as-of`;
   `apply-*` read `--file <decisions.json>` and also take `--as-of`. `sig` strings are stable between a
   report and its apply — judge only the facts in the report, **never invent facts, sigs, or members**.

   For each surface, the report OUTPUT the caller reads and the decision INPUT the caller must write:

   - **entities** — type the recurring named subjects of each fact, PLUS review the bounded set of
     mechanically-created entity hubs the engine proposes.
     The mechanical extractor (a local, deterministic, PROPOSING-only language service —
     `src/langsvc.js`/`src/langsvc.English.js`, never an LLM) is **not authoritative**: every
     hub it creates is `provisional` until you review it here, and it never auto-splits a
     multi-token label ("First Last") into single-token forms — only the full phrase is a
     default surface form, so a bad candidate can never become a magnet that falsely
     co-mentions unrelated facts. Short forms/aliases only exist once YOU add them.
     report: `{surface:"entities", report_id, basis_seq, facts:[{sig,fact}], hubs:[{sig,type,label,forms,degree,sample,status}]}`
     `hubs[]` is bounded: every not-yet-reviewed (`status:"provisional"`) hub first (highest
     mention `degree`/blast-radius first), plus a small rotating slow re-review window over
     already-`approved` older hubs. `sample` is a few facts that mention the hub — use it
     (not just the label) to judge whether the candidate is real.
     judge (facts): for each fact list concrete named entities (people/orgs/teams/places/projects/systems/recurring topics); resolve a bare first name to its full name when another fact disambiguates; **skip** dates, numbers, generic nouns, one-off phrases. Type ∈ `person|org|team|place|project|system|topic`; `sig` = `"<type>:<kebab-name>"`; `forms` = lowercased surface strings (full name + long tokens, ≥3 chars).
     judge (hubs): for each hub in `hubs[]`, decide one action — **conservatively**, from the
     `sample` facts alone:
       • `keep` — the hub is a real, correctly-typed entity as-is.
       • `retype {type, new_sig, forms:[...]}` — same entity, wrong type/sig (e.g. mechanically
         typed `person:` but it's really a `system:`/`topic:`); `forms` may add caller-approved
         aliases for the NEW sig (still explicit, never auto-derived).
       • `reject` — this is not a real entity at all (a Mapping-Dataflow-style misparse); its
         mention edges and any fact-pair sibling edge they may have corroborated are severed,
         and the sig is never mechanically recreated.
       • `remove_forms {forms:[...]}` — the hub is real but carries a bad alias (never the
         hub's own base/full-phrase form — that requires `retype`/`reject` instead); only
         facts that matched solely via the removed alias lose their mention edge.
     decision file: `{report_id, decisions:[{sig, type, forms:[...]}], hub_reviews:[{sig, action, ...}]}`
     `decisions[]` is keyed by entity hub sig, not by source fact. If several facts
     mention the same entity, emit one consolidated create/augment decision for that
     exact sig, combining only caller-approved forms. Duplicate decisions for a sig
     are invalid and reject the apply.
     (the legacy bare array `[{sig,type,forms}]` — entity **create/augment only**, no hub
     review — is still accepted unchanged). `apply-entities` is atomic on the hub-review half:
     any stale `report_id` or invalid `hub_reviews` entry (unknown sig, bad action/type/forms)
     rejects the WHOLE apply — `complete:false`, structured `rejected`, zero mutation, cursor
     unmoved. The engine validates only report membership/action/type/forms — it never
     re-judges your decision.

   - **aliases** — merge entity hubs that name the SAME entity.
     report: `{surface:"aliases", hubs:[{sig,label}]}`
     judge: group first-name↔full-name, abbreviation↔expansion, spelling/case variants. **Be conservative** — distinct people who merely share a name are NOT the same. Use exact `sig` strings; only emit groups that actually merge.
     decision: `[{canonical:"<sig to keep>", aliases:["<sig to fold in>", ...]}]`

   - **salience** — EARN importance for the rare high-stakes facts (Layer 4 / P12). Frequency ≠ importance; the harness may NOT assert it — it is judged ONLY here, at dream time.
     report: `{surface:"salience", facts:[{sig, fact, nearest_prior:{fact,cosine}, supersedes:[...]}], review:[{sig, fact, salience_score, superseded_by_new, nearest_prior}]}`
     judge each `facts[]` candidate on a CONTINUOUS `score ∈ [0,1]` from two signals (do NOT score affect/emotion — the surface can't observe it):
       • **S2 material stakes** — does acting on / forgetting this fact carry real consequence? (firm decision/commitment, security or Sev1/2 incident, exec/leadership or org-structure change, core identity/role, big business value, hard deadline).
       • **S3 novelty / contradiction** — is it genuinely new or a correction? Use the supplied context: a HIGH `nearest_prior.cosine` ⇒ a near-restatement (LOW novelty ⇒ lower score); a non-empty `supersedes` ⇒ it corrects/updates a prior fact (higher novelty/contradiction).
       Most facts score LOW (mundane episodic). Emit only the facts you scored, with their score; the engine keeps a sparse top slice (~15% of active, ~20% of the batch) so over-scoring is safely capped.
       Then review `review[]` (facts currently salient): if one is now stale, resolved, or `superseded_by_new`, list its `sig` under `downgrade` to REVOKE salience (non-destructive — the fact and its strength survive; it simply loses protection).
     decision: `{salient:[{sig, score}], downgrade:[sig]}`  (legacy `{salientSigs:[sig]}` = score 1.0 still accepted)

   - **merges** (alias `consolidate`) — roll up each near-duplicate cluster into ONE richer fact.
     report: `{surface:"merges", report_id, basis_seq, cursor_seq, clusters:[[{sig,fact}], ...]}`
     judge: per cluster, merge ONLY facts about the same subject that are redundant/incremental/a correction sequence; write one consolidated `fact` that preserves every distinct still-true detail and names all specifics; prefer the LATEST value on conflict but keep prior value as context if it aids recall. If a cluster mixes unrelated subjects, **do not merge it** (emit `null` / omit). `survivorSig` = the member whose identity to preserve; `memberSigs` = all members in the cluster (≥2 live).
     decision file: `{report_id:"<copy exactly from report>", decisions:[{fact, survivorSig, memberSigs:[...]} | null]}`
     (null/omitted cluster = reviewed and declined). Every merge must stay inside ONE reported
     cluster; never combine members from separate clusters. `apply-merges` is atomic: any stale,
     overlapping, malformed, or cross-cluster submitted decision returns structured `rejected`
     details and exits 3 with ZERO mutations, so correct the decisions or re-report and retry.
     An empty report-bound `decisions:[]` means "reviewed and declined all" and advances the
     incremental cursor. A legacy bare array remains accepted when non-empty, but bare `[]` is
     intentionally inert and does not close the report window.

   - **synthesis** — extract semantics from recurrence. It has two candidate lanes in one report:
     dormant similarity families (`pools`) and repeatedly reactivated subject families
     (`reactivation_pools`). Reactivation is only a signal to inspect; the deterministic
     engine never promotes the episode itself.
     report: `{surface:"synthesis", report_id, basis_seq, pools:[{poolId,members,hotSiblings}], reactivation_pools:[{poolId,mode:"reactivation",hub,members:[{sig,fact,firstSeen,archiveEligible,evidenceCount}],evidence:[{newSig,oldSig,hubSig}]}]}`
     judge dormant `pools`: partition into genuine sub-themes and write one concept per
     recurrence family. Never demote `hotSiblings`.
     judge `reactivation_pools`: ask what was actually learned — the invariant/pattern,
     significant change, why the recurrence matters, and whether the shared hub is merely
     generic coincidence. `archiveEligible:false` marks current/recent exemplars that MUST
     remain active. For a genuine family choose `action:"synthesize"` and select only
     `archiveEligible:true` historical members; provide a self-contained `concept`, time
     `span`, and count/`scale`. If no real semantic abstraction is entailed, choose
     `action:"reject"` so the episodes return to ordinary episodic decay. Never invent
     causality, facts, members, ids, dates, or outcomes.
     decision: `{report_id, decisions:[{poolId,groups:[{concept,memberSigs,span,scale}]}], reactivation_reviews:[{poolId,action:"synthesize",groups:[{concept,memberSigs,span,scale}]}|{poolId,action:"reject"}]}`
     Apply is report-bound: stale or malformed reactivation reviews reject the whole apply
     with zero mutations. Accepted and rejected families remain suppressed until new
     reactivation evidence accrues.
     Synthesis is a caller-owned LOOP: re-run report→judge→apply until a turn yields zero groups (bound to ~3 turns).

   - **chronicles** — the **temporal axis**: roll each SETTLED time period (day, then coarser week/
     month/quarter/year as it ages) into ONE fixed-period overview plus an ordered list of what changed,
     every claim backed by dated evidence already in the db. Run this LAST (after merges/synthesis) so it
     summarizes consolidated facts over resolved entities. Chronicles never invent content — they distill
     existing dated evidence into a period-bound account the caller can recall via `recall.js --timeline`.
     report: `{surface:"chronicles", report_id, basis_seq, candidates:[{periodId, resolution, periodStart, periodEnd, nextVersion, coverageSeq, members:[{sig, kind, fact, sourceDay, periodStart, periodEnd, entitySigs}]}]}`
     `candidates[]` is bounded to newly-closeable/re-coverable periods; `members[]` are the dated evidence
     facts (and, for coarser periods, the finer child chronicles **in full**) that fall in the window — the
     ONLY sigs you may cite. `entitySigs` on a member are the caller-approved entity hubs it mentions.

     judge: choose a manageable subset of candidates and write ONE `summary` plus an ordered
     `entries[]` timeline for each. **When a day candidate exists, always include the newest day**
     so the live timeline advances; use remaining capacity for older or coarser backlog. Omitted
     candidates remain pending for the next report and do not block the selected periods.

     **`summary` is the period's retrieval surface.** It is embedded and later matched against
     natural-language questions — *"what happened around \<date\>"*, *"what changed with X"*,
     *"when did X first come up"*. Write the sentences those questions will land on:
     - **Name things.** Use the actual people, systems, artifacts and outcomes as they appear in the
       members' text; the members' `entitySigs` hubs are the approved vocabulary. Questions are asked in
       the words of the subject matter, never in the words of the bookkeeping.
     - **Record transitions with their subject** — what began, finished, reversed, or is still open,
       always attached to *what it was about*.
     - **Record firsts.** The first appearance of a person, system, or thread in this period is what
       answers *"when did X first happen"*.
     - **Say the period in words** ("Monday 22 July 2026") so date-phrased questions match.
     - **Let length follow the period.** A dull day gets a short, concrete summary naming the little that
       happened. There is no quota in either direction — never pad, never compress a busy day to fit.
     - **Never write counts as content.** Coverage and compression are exact numbers already in
       `chronicles`/`chronicle_evidence`, recomputable with one query, and they match no question anyone
       asks. If a number matters, attach it to a named subject ("three separate OneIdentity approvals for
       the Gateway release"). Never use `changeKind` values as prose.
     - **Self-check before writing the decision:** name two or three questions someone would ask six
       months from now to find this period. If the summary lacks the words of those questions, rewrite it.

     For coarser periods the members ARE the child chronicles, supplied in full. Carry their named
     specifics upward, selecting what still matters at this resolution — never aggregate them into totals.

     Each `entries[]` entry = a `slot` label that marks *when or at what event* within the period
     ("morning", "week 1", "after the incident") — NOT a restatement of `changeKind` — a `summary`
     (≥4 chars) of what happened, named the same way as above, a `changeKind ∈ {continuity, introduced,
     changed, resolved, reversed, completed}`, optional `stateLabel`/`aspect`, optional `entitySigs`
     (subset of the members' approved entities), and `evidenceSigs` (≥1, all drawn from THIS candidate's
     `members`). **Coverage is mandatory and complete**: every member sig MUST appear in some entry's
     `evidenceSigs`, or the period is rejected (`incomplete_coverage`). Coverage is a structural property
     of the evidence links — satisfy it by attaching sigs to the entry they belong to, never by bucketing
     everything into one entry per `changeKind`. Never invent sigs, periods, entities, dates, or entries.
     decision: `{report_id, decisions:[{periodId, summary, entries:[{slot, summary, changeKind, stateLabel?, aspect?, entitySigs?, evidenceSigs:[...]}]}]}`
     Apply is report-bound and **atomic per period**: a stale/missing `report_id` rejects the
     whole apply, while malformed/duplicate/uncovered submitted periods are rejected individually
     without blocking other valid periods. Omitted periods remain pending. Applied chronicles persist as
     `kind='chronicle'` nodes (with `chronicle_entries`/`chronicle_evidence`) that project to Tier 1 as
     `tier='chronicle'` temporal memories and recall through the `--timeline` axis; older fine periods
     archive only once coarser coverage exists. `doctor` reports
     `chronicle_vector_dispersion.mean_pairwise_cosine` — if it climbs toward 1.0 the summaries have
     collapsed into interchangeable bookkeeping and the temporal axis has stopped discriminating periods.

   Apply commands validate/sanitize the decision, mutate the db, and re-weave / `repairGraph` as needed.
   **`apply-merges` is the load-bearing stage**: it creates the `notes='gist'` survivor **born
   signature-first (`memory_id=''`)**, retains constituents as `notes='detail'`, stamps `vagueness`
   via `extractHardSpecifics`, and preserves `supersedes` lineage. Host adapters must project that
   db-native result rather than re-ingesting it as a fresh flat memory and losing provenance, tier,
   or vagueness. Run `budget` to inspect pressure and prioritize merge work.
