# Install Dreamweave into your agent harness

This is the entry point for an assistant asked to **“import this”** or **“set this up.”**
Dreamweave's engine is host-independent; installation, memory transport, skills and
scheduling are specific to the target harness.

## 1. Select the target harness

The assistant running this installer normally already knows its harness from the
current live runtime and tool contract. When that runtime clearly identifies one
of the supported harnesses, select its adapter directly without asking:

- **Microsoft Scout** → [Microsoft Scout installation](harness-adapters/MicrosoftScout/install.md)
- **Hermes Agent** → [Hermes Agent installation](harness-adapters/hermes-agent/install.md)

An explicit user-specified target overrides the current runtime. Ask the user only
when the target is genuinely uncertain—for example, the runtime identity is absent
or ambiguous, the user is preparing an installation for another machine, or their
request conflicts with the current harness. The presence of an existing `.copilot`,
`.scout` or `.hermes` directory is not sufficient evidence by itself.

If neither adapter matches after resolving genuine uncertainty, stop and explain
the [host integration contract](README.md#integrating-with-a-host-agent) rather than
applying another harness's instructions.

## 2. Read and follow the selected guide

Read its complete `install.md` before running commands. Use the repository root
as the working directory unless that guide states otherwise. Install only the
chosen adapter, into the explicitly selected profile/workspace.

Run `npm install` first to install/build dependencies. Shared engine bootstrap
(`npm run setup`) verifies them and prepares the database, local embedding model
and behavioral configuration; it does **not** select a host
or install Microsoft Scout skills implicitly.

## 3. Confirm policy and verify the installation

The selected guide owns the required interview about retention, capacity,
forgetting and connections, plus host-specific memory limits, model and schedule.
Show recommended settings; do not silently impose a large injected-memory budget,
a paid model, or an unattended schedule.

Verify the target paths, memory round trip, recall, and an actual judged nightly
cycle. A healthy database or a green scheduler status alone is not proof that the
LLM judgment stages completed. Preserve existing user memories and configuration;
never replace them with example data.
