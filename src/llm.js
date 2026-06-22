"use strict";

// Optional LLM client for the dream JUDGMENT layer (entity typing, canonicalization,
// merge, salience). Zero-dependency: uses Node's global fetch, so the engine stays
// portable. Disabled by default — the whole engine runs without it (pure mechanics +
// local embeddings). Enable by setting DREAM_LLM to a model spec:
//
//   DREAM_LLM=azure:gpt-5.4-mini        (needs AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY)
//   DREAM_LLM=openai:gpt-4o-mini        (needs OPENAI_API_KEY)
//   DREAM_LLM=anthropic:claude-...      (needs ANTHROPIC_API_KEY)
//
// The dream maintainer is a JUDGE, not an author — a small/cheap model is the right
// tool (the live system uses a mini model). It never invents facts; it only decides
// merges, types, aliases, and importance over content the engine already holds.

const DEFAULT_AZURE_API_VERSION = "2024-10-21";

function parseSpec(spec) {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`bad DREAM_LLM spec "${spec}"`);
  const provider = spec.slice(0, i).trim().toLowerCase();
  const rest = spec.slice(i + 1);
  const j = rest.indexOf(";");
  const model = (j === -1 ? rest : rest.slice(0, j)).trim();
  const endpoint = j === -1 ? undefined : rest.slice(j + 1).trim() || undefined;
  return { provider, model, endpoint };
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// One chat call with retry on 429/5xx. Returns the assistant text.
async function chat(spec, env, system, user, opts = {}) {
  const maxTokens = opts.maxTokens || 3000;
  const maxRetries = opts.maxRetries == null ? 6 : opts.maxRetries;
  let url, headers, body;
  if (spec.provider === "azure") {
    const ep = (spec.endpoint || env.AZURE_OPENAI_ENDPOINT || "").replace(/\/+$/, "");
    const ver = env.AZURE_OPENAI_API_VERSION || DEFAULT_AZURE_API_VERSION;
    if (!ep) throw new Error("azure: AZURE_OPENAI_ENDPOINT not set");
    const key = env.AZURE_OPENAI_API_KEY || env.OPENAI_API_KEY;
    if (!key) throw new Error("azure: AZURE_OPENAI_API_KEY not set");
    url = `${ep}/openai/deployments/${spec.model}/chat/completions?api-version=${ver}`;
    headers = { "content-type": "application/json", "api-key": key };
    body = { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: maxTokens };
  } else if (spec.provider === "openai") {
    const base = (spec.endpoint || env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
    const key = env.OPENAI_API_KEY;
    if (!key) throw new Error("openai: OPENAI_API_KEY not set");
    url = `${base}/chat/completions`;
    headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
    body = { model: spec.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_completion_tokens: maxTokens };
  } else if (spec.provider === "anthropic") {
    const base = (spec.endpoint || "https://api.anthropic.com").replace(/\/+$/, "");
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("anthropic: ANTHROPIC_API_KEY not set");
    url = `${base}/v1/messages`;
    headers = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" };
    body = { model: spec.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
  } else {
    throw new Error(`unknown provider "${spec.provider}"`);
  }

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
        await sleep(Math.min(30000, 800 * Math.pow(2, attempt)));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
      const j = await res.json();
      if (spec.provider === "anthropic") {
        return (j.content || []).map((c) => c.text || "").join("").trim();
      }
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || "").trim();
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(30000, 800 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new Error("llm chat failed");
}

// Strip ```json fences / prose and parse the first JSON value found.
function parseJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  // find first { or [ and matching last } or ]
  const s = t.search(/[[{]/);
  if (s >= 0) {
    const open = t[s], close = open === "[" ? "]" : "}";
    const e = t.lastIndexOf(close);
    if (e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch { /* noop */ } }
  }
  return null;
}

function getLLM(env = process.env) {
  const raw = (env.DREAM_LLM || "").trim();
  if (!raw || raw.toLowerCase() === "none" || raw.toLowerCase() === "off") {
    return { available: false, label: "none",
      async complete() { throw new Error("LLM disabled"); },
      async json() { return null; } };
  }
  const spec = parseSpec(raw);
  return {
    available: true,
    label: `${spec.provider}:${spec.model}`,
    async complete(system, user, opts) { return chat(spec, env, system, user, opts); },
    async json(system, user, opts) { return parseJson(await chat(spec, env, system, user, opts)); },
  };
}

module.exports = { getLLM, parseJson };
