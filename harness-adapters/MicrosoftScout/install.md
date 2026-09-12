# Installing dreamweave into Microsoft Scout

> **This file is written for the AI assistant doing the install.** The expected flow is:
> the user unzips this package and says *"import this / set this up."* You (the assistant)
> follow this `harness-adapters/MicrosoftScout/install.md`, run the shared bootstrap,
> explicitly install the two Microsoft Scout skills, then
> **interview the user about the four behavioral knobs and persist their choices** before
> finishing. Do not skip the interview — shipping defaults silently is the exact failure this
> design fixes.

There is **no skill marketplace for Scout yet**, so installation is a manual unzip + one-time
setup (~5 minutes). The package ships a Node engine plus a native vector store.

> Heads-up: community/personal package, **not** a first-party feature. It runs a local Node
> process and downloads a small embedding model on first run. Review before using on sensitive
> machines.

---

## Step 0 — Prerequisites
- **Node.js ≥ 20** on PATH.
- A toolchain that can install `better-sqlite3` (prebuilt binaries cover most platforms; otherwise Python + a C/C++ compiler).
- Network access on first run (one-time embedding-model download, then cached offline).

## Step 1 — Bootstrap (mechanical)
Run **all commands in this guide from the repository/package root** (the folder containing
`package.json`, `config.js`, and `src/`), not from `harness-adapters/MicrosoftScout/`.
`<AGENT_MEMORY>` also means that repository root, never this adapter directory.

There are two separate setup stages: engine bootstrap, then Microsoft Scout host wiring.

```bash
npm install
npm run setup
npm run setup:scout
```

`npm install` installs/builds the dependencies. **`npm run setup` is host-neutral**: it verifies
dependencies, creates the data directory and initializes or opens `memory.db` without resetting
existing memories, warms the embedding model, and creates default `memory.config.json` only
when missing. It does not detect Scout or install any host skills.

**`npm run setup:scout` installs host skills only**; it does not run the engine bootstrap again.
Its direct equivalent, also from the repository root, is:

```bash
node harness-adapters/MicrosoftScout/scripts/install-skills.js
```

The explicit Scout installer copies `harness-adapters/MicrosoftScout/skills/dream/` and
`harness-adapters/MicrosoftScout/skills/graph-recall/` (including
supporting Markdown files) into Scout's skills directory and replaces `<AGENT_MEMORY>` with
the absolute repository root, using forward slashes. Discovery checks existing
`~/.copilot/m-skills/` then `~/.scout/m-skills/`; if neither exists, it creates `m-skills/`
under the first existing `~/.copilot/` or `~/.scout/`. No Scout directory means a clear failure,
not a silently skipped install. An explicit `SCOUT_SKILLS_DIR` always wins, is created if
missing, and never falls back to another target on error.

To pin the skills destination:

```bash
# POSIX shells, from the repository root
SCOUT_SKILLS_DIR="$HOME/.copilot/m-skills" npm run setup:scout
```

```powershell
# PowerShell, from the repository root
$env:SCOUT_SKILLS_DIR = "$HOME\.copilot\m-skills"
npm run setup:scout
```

**Existing `dream` or `graph-recall` directories are refused before either skill is changed.**
Review customized skills before choosing to replace them explicitly:

```bash
npm run setup:scout -- --force
```

With `--force`, complete existing skill directories are first moved into a unique
`.dreamweave-backup-*` directory inside the skills target; the installer prints that path.
The new skills are fresh copies. Review and merge customizations from the backup manually.
Do not delete backups until you have verified the replacement. On a failed forced install,
check the target for its backup directory before retrying.

The default engine data directory is `~/.dream-memory`. Override it with `AGENT_MEMORY_DIR`
(`DREAM_MEMORY_DIR` takes precedence); for Scout co-location, use the expanded absolute
path to `$HOME/.copilot/data`. Keep the same environment overrides available to the shared
bootstrap, config commands, installed skill shell commands, and nightly automation. The
installer substitutes the engine path, not data/model environment settings.

## Step 2 — INTERVIEW THE USER ABOUT THE KNOBS (required)

dreamweave exposes exactly **four behavioral knobs**. Setup wrote sensible defaults, but you
**must** walk the user through all four and let them choose. For each knob, present the options
with the recommended default highlighted (use the host's structured choice UI if available, e.g.
Scout's `m_ask_user`), then persist their answer:

```bash
node "<AGENT_MEMORY>/src/dream.js" config set <knob> <value>
```

`<AGENT_MEMORY>` is this package's absolute path (the folder containing `src/` and `config.js`).
Run `node src/dream.js config list` to print the live spec, and `config show` to see the
resolved low-level effect of the current choices.

The authoritative knob names, options, and defaults live in [`src/tuning.js`](../../src/tuning.js).

### The four knobs

| # | Knob | Options (recommended in **bold**) | What it controls |
|---|------|-----------------------------------|------------------|
| 1 | `retention` | **preserve** / prune | **preserve** = tiered: faded/overflow memories are *demoted to a Tier-3 archive, never deleted* — the long tail stays recoverable by recall. `prune` = legacy single-tier: faded + over-cap facts are deleted. **Recommend preserve** for a personal assistant that should never lose an insight. |
| 2 | `capacity` | compact / **standard** / expansive | Memory size: Tier-1 inject target / hard cap / Tier-2 recall cap. compact 150/300/1500, **standard 250/500/2500**, expansive 400/800/5000. Bigger = more recall, more injected context. |
| 3 | `forgetting` | slow / **natural** / fast | How fast ephemeral (episodic) memories fade. slow = half-lives ×2 (hold longer), **natural** = as designed, fast = ×0.5 (forget sooner). |
| 4 | `connections` | **incremental** / thorough | Nightly weave scope. **incremental** = weave only new/changed facts (bounded cost, right for nightly runs). thorough = re-weave the whole graph each run. |

> Correction lineage (`supersedes` edges) is **always on** — it is not a knob, because a memory
> store that lets contradicting facts coexist untracked is simply broken. (`MEMORY_SUPERSEDE`
> remains a bench-only env override.)

> **Defaults already deliver the intended experience** (preserve + standard + natural +
> incremental). If the user just wants "the recommended setup," confirm the defaults and move
> on — but still show them what they're getting.

### Interview script (suggested)
1. "How should I handle old/faded memories — **never delete (archive them)** or prune to stay lean?" → `retention`
2. "How large should your memory be — compact, **standard**, or expansive?" → `capacity`
3. "How quickly should day-to-day details fade — slow, **natural**, or fast?" → `forgetting`
4. "Nightly maintenance: **incremental** (fast) or thorough (slower, exhaustive)?" → `connections`

Persist each answer with `config set`, then run `config show` and read back the resolved
behavior to confirm.

## Step 3 — Schedule the nightly dream
The `dream` skill is the maintenance pass. Create a host automation (Scout automation / cron)
that runs it once nightly (e.g. 3 AM). The automation prompt should simply **load and follow the
`dream` skill** (`m_get_skill("dream")`), not hardcode the algorithm — the skill is the single
source of truth.

## Step 4 — Restart Scout
Restart so it picks up the new `dream` and `graph-recall` skills.

## Step 5 — (Recommended) Auto-approve the recall command
The `graph-recall` skill works by running a single shell command,
`node "<AGENT_MEMORY>/src/recall.js" …`. By default the host asks for shell
approval every time it fires, which makes recall prompt on each use. To let it run
friction-free, add a **scoped allow-list entry** that matches only the recall
command — least privilege, and independent of any global shell toggle:

```
node "<AGENT_MEMORY>/src/recall.js" *
```

Add this to the host's command allow-list (in Copilot CLI / Scout this is the
inline "Allow list — add" card, or the `permissions`/`autoApprove` allow patterns
in the host config). Replace `<AGENT_MEMORY>` with this package's absolute path,
and **match the exact form the skill emits** — the installed `graph-recall`
SKILL.md always calls the engine with a *quoted, forward-slash* path
(`node "Q:/src/dream-memory/src/recall.js" …`), so the allow pattern must use the
same quoting and slashes. A backslash path (`Q:\src\…`) will not match.

Notes:
- If the host already has a blanket shell auto-approve (`servers.shell.autoApprove: true`),
  recall is *already* auto-approved — but the scoped entry is safer: it keeps recall
  friction-free even after you turn the broad toggle off.
- The nightly `dream` skill runs several engine subcommands
  (`ingest-harness`, `export-harness`, `dream`, `doctor`, …). If you also want the
  nightly automation to run unattended, either rely on the automation runner's own
  approval settings or add a broader scoped entry such as
  `node "<AGENT_MEMORY>/src/dream.js" *`.

---

## Precedence & power-user overrides
Resolution order is **env override → persisted `memory.config.json` → built-in default**. Every
knob still has a raw env escape hatch (`MEMORY_TIER2_MAX`, `MEMORY_ENTRY_TARGET/MAX`,
`MEMORY_FORGET_MULT`, `MEMORY_INCREMENTAL_WEAVE`). `MEMORY_SUPERSEDE` is a bench/CI
escape hatch for the always-on correction-lineage invariant, not a user-facing knob.

## Uninstall
Delete the two skill folders from your skills dir, delete the unzipped package, and remove the
data dir (`memory.db` + `memory.config.json` + `model-cache`) if you want to wipe the store.

## Known limitations
- **Embedder** is Hugging Face transformers.js (MiniLM, downloaded once). Swap via `MEMORY_MODEL` / `MEMORY_MODEL_CACHE`.
- **Native deps** (`better-sqlite3`, `sqlite-vec`) must match your Node version/platform; re-run `npm install` after a Node upgrade.
- **Keep the unzipped folder where it is** — installed skills reference the engine by absolute path. If you move it, run `npm run setup` from the new root, then `npm run setup:scout -- --force` to rewire the skills (after reviewing customizations). Update any scoped command allow-list paths too.