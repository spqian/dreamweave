# Installing the agent-memory skills into Microsoft Scout

There is **no skill marketplace / redistribution mechanism for Scout yet**, and Scout skills are
normally just markdown. This package is heavier — it ships a Node engine plus a native vector store —
so installation is a manual unzip + one-time setup. ~5 minutes.

> Heads-up: this is a community/personal package, **not** a first-party Scout feature. It runs a local
> Node process and downloads a small embedding model on first run (see the dependency note in
> `docs/memora-graph-memory-proposal.md`). Review before using on sensitive machines.

## Prerequisites

- **Node.js ≥ 18** on PATH.
- A toolchain that can install `better-sqlite3` (prebuilt binaries cover most Win/macOS/Linux; if not,
  you need Python + a C/C++ compiler).
- Network access on first run (one-time embedding-model download, then cached offline).

## Steps

1. **Unzip** this package somewhere stable, e.g.:
   - Windows: `C:\Users\<you>\agent-memory`
   - macOS/Linux: `~/agent-memory`

2. **Install + bootstrap** (from inside the unzipped folder):
   ```bash
   npm install
   npm run setup
   ```
   This builds the native deps, creates `~/.agent-memory/memory.db`, warms the embedding
   model, **and auto-installs the two skills** into your Scout skills dir (`~/.copilot/m-skills/`
   or `~/.scout/m-skills/`, whichever exists) with the engine path wired in. Override the target
   with `SCOUT_SKILLS_DIR` if your install uses a different location.

3. **Restart Scout** so it picks up the new `dream` and `graph-recall` skills.

That's it — `npm run setup` printed where it installed the skills. If it reported it could **not**
auto-install (no Scout dir found), do it manually:

   **Windows (PowerShell):**
   ```powershell
   $skills = "$HOME\.copilot\m-skills"   # or wherever your Scout loads skills
   Copy-Item -Recurse -Force ".\skills\dream"        "$skills\dream"
   Copy-Item -Recurse -Force ".\skills\graph-recall" "$skills\graph-recall"
   # then replace <AGENT_MEMORY> in the two SKILL.md files with the absolute path to THIS folder
   ```

   **macOS/Linux:**
   ```bash
   SKILLS="$HOME/.copilot/m-skills"
   cp -R ./skills/dream        "$SKILLS/dream"
   cp -R ./skills/graph-recall "$SKILLS/graph-recall"
   # then replace <AGENT_MEMORY> in the two SKILL.md files with the absolute path to THIS folder
   ```

> **Keep the unzipped folder where it is.** The installed skills reference the engine by absolute
> path. If you move the folder, re-run `npm run setup` to re-wire the path.

## Using it

- **Recall** (read path) is invoked automatically by the `graph-recall` skill when a query looks like
  it maps to memory.
- **The nightly dream** is the `dream` skill — run it on a schedule (Scout automation / cron). It pulls
  your agent's memories into the store, consolidates, and projects the curated set back. See
  `skills/dream/SKILL.md` for the full loop and `README.md` for the engine commands.

## Uninstall

Delete the two skill folders from your skills dir, delete the unzipped package, and remove
`~/.agent-memory` (the data dir) if you want to wipe the store.

## Known limitations (be honest with yourself)

- **Embedder is Hugging Face transformers.js** — downloads MiniLM once. Swap via `MEMORY_MODEL` /
  `MEMORY_MODEL_CACHE` or replace `lib/embed.js` if you need an offline/internal embedder.
- **Native deps** (`better-sqlite3`, `sqlite-vec`) must match your Node version/platform; re-run
  `npm install` after a Node upgrade.
- **Entity extraction** in `lib/entities.js` was tuned on one user's corpus; connectivity is still
  guaranteed (the vector layer rescues islands) but the person/org denylists are domain-flavored.
