# Installing dreamweave into an OpenClaw agent (Microsoft Scout / Clawpilot)

> **This file is written for the AI assistant doing the install.** The expected flow is:
> the user unzips this package and says *"import this / set this up."* You (the assistant)
> detect this `INSTALL.md`, run the bootstrap, import the two skills into the harness, then
> **interview the user about the five behavioral knobs and persist their choices** before
> finishing. Do not skip the interview — shipping defaults silently is the exact failure this
> design fixes.

There is **no skill marketplace for Scout yet**, so installation is a manual unzip + one-time
setup (~5 minutes). The package ships a Node engine plus a native vector store.

> Heads-up: community/personal package, **not** a first-party feature. It runs a local Node
> process and downloads a small embedding model on first run. Review before using on sensitive
> machines.

---

## Step 0 — Prerequisites
- **Node.js ≥ 18** on PATH.
- A toolchain that can install `better-sqlite3` (prebuilt binaries cover most platforms; otherwise Python + a C/C++ compiler).
- Network access on first run (one-time embedding-model download, then cached offline).

## Step 1 — Bootstrap (mechanical)
From inside the unzipped package folder:

```bash
npm install
npm run setup
```

`npm run setup` builds native deps, creates the data dir + a fresh `memory.db`, warms the
embedding model, **auto-installs the `dream` and `graph-recall` skills** into the Scout skills
dir (`~/.copilot/m-skills/` or `~/.scout/m-skills/`), wires the absolute engine path into them,
and writes a **default `memory.config.json`**. Override the skills target with `SCOUT_SKILLS_DIR`
and the data dir with `AGENT_MEMORY_DIR` (set it to `~/.copilot/data` to co-locate with Scout).

If setup reports it could not auto-install the skills, copy them manually:

```powershell
# Windows
$skills = "$HOME\.copilot\m-skills"
Copy-Item -Recurse -Force ".\skills\dream"        "$skills\dream"
Copy-Item -Recurse -Force ".\skills\graph-recall" "$skills\graph-recall"
# then replace <AGENT_MEMORY> in both SKILL.md files with the absolute path to THIS folder
```

## Step 2 — INTERVIEW THE USER ABOUT THE KNOBS (required)

dreamweave exposes exactly **five behavioral knobs**. Setup wrote sensible defaults, but you
**must** walk the user through all five and let them choose. For each knob, present the options
with the recommended default highlighted (use the host's structured choice UI if available, e.g.
Scout's `m_ask_user`), then persist their answer:

```bash
node <AGENT_MEMORY>/src/dream.js config set <knob> <value>
```

`<AGENT_MEMORY>` is this package's absolute path (the folder containing `src/` and `config.js`).
Run `node src/dream.js config list` to print the live spec, and `config show` to see the
resolved low-level effect of the current choices.

### The five knobs

| # | Knob | Options (recommended in **bold**) | What it controls |
|---|------|-----------------------------------|------------------|
| 1 | `retention` | **preserve** / prune | **preserve** = tiered: faded/overflow memories are *demoted to a Tier-3 archive, never deleted* — the long tail stays recoverable by recall. `prune` = legacy single-tier: faded + over-cap facts are deleted. **Recommend preserve** for a personal assistant that should never lose an insight. |
| 2 | `capacity` | compact / **standard** / expansive | Memory size: Tier-1 inject target / hard cap / Tier-2 recall cap. compact 150/300/1500, **standard 250/500/2500**, expansive 400/800/5000. Bigger = more recall, more injected context. |
| 3 | `forgetting` | slow / **natural** / fast | How fast ephemeral (episodic) memories fade. slow = half-lives ×2 (hold longer), **natural** = as designed, fast = ×0.5 (forget sooner). |
| 4 | `judgment` | **off** / `<provider>:<model>` | Optional engine-internal LLM judge for **headless** runs. **off** = the host LLM running the nightly skill is the judge (via `consolidate` + confirm), zero API keys. Set a spec (e.g. `azure:gpt-5.4-mini`) only for cron/no-agent deployments; needs the matching API-key env vars. |
| 5 | `connections` | **incremental** / thorough | Nightly weave scope. **incremental** = weave only new/changed facts (bounded cost, right for nightly runs). thorough = re-weave the whole graph each run. |

> Correction lineage (`supersedes` edges) is **always on** — it is not a knob, because a memory
> store that lets contradicting facts coexist untracked is simply broken. (`MEMORY_SUPERSEDE`
> remains a bench-only env override.)

> **Defaults already deliver the intended experience** (preserve + standard + natural + off +
> incremental). If the user just wants "the recommended setup," confirm the defaults and move
> on — but still show them what they're getting.

### Interview script (suggested)
1. "How should I handle old/faded memories — **never delete (archive them)** or prune to stay lean?" → `retention`
2. "How large should your memory be — compact, **standard**, or expansive?" → `capacity`
3. "How quickly should day-to-day details fade — slow, **natural**, or fast?" → `forgetting`
4. "An optional LLM judge only matters for headless/cron runs — since I run your nightly dream, I'm the judge. Leave **off**?" → `judgment`
5. "Nightly maintenance: **incremental** (fast) or thorough (slower, exhaustive)?" → `connections`

Persist each answer with `config set`, then run `config show` and read back the resolved
behavior to confirm.

## Step 3 — Schedule the nightly dream
The `dream` skill is the maintenance pass. Create a host automation (Scout automation / cron)
that runs it once nightly (e.g. 3 AM). The automation prompt should simply **load and follow the
`dream` skill** (`m_get_skill("dream")`), not hardcode the algorithm — the skill is the single
source of truth.

## Step 4 — Restart Scout
Restart so it picks up the new `dream` and `graph-recall` skills.

---

## Precedence & power-user overrides
Resolution order is **env override → persisted `memory.config.json` → built-in default**. Every
knob still has a raw env escape hatch (`MEMORY_TIER2_MAX`, `MEMORY_ENTRY_TARGET/MAX`,
`MEMORY_FORGET_MULT`, `MEMORY_INCREMENTAL_WEAVE`, `MEMORY_SUPERSEDE`,
`DREAM_LLM`) so benches / CI can pin exact low-level values without touching the config file.

## Uninstall
Delete the two skill folders from your skills dir, delete the unzipped package, and remove the
data dir (`memory.db` + `memory.config.json` + `model-cache`) if you want to wipe the store.

## Known limitations
- **Embedder** is Hugging Face transformers.js (MiniLM, downloaded once). Swap via `MEMORY_MODEL` / `MEMORY_MODEL_CACHE`.
- **Native deps** (`better-sqlite3`, `sqlite-vec`) must match your Node version/platform; re-run `npm install` after a Node upgrade.
- **Keep the unzipped folder where it is** — installed skills reference the engine by absolute path. If you move it, re-run `npm run setup`.
