// Cloud + local models working together ("hybrid").
//
// Heavy, occasional jobs (free questions, full summaries, the daily digest, nightly learning,
// the Partner analysis) try the cloud providers in order; everything that touches every single
// message (sorting, event extraction, images) stays on the local model.
// If a provider is down, out of credits or rate-limited, the next one is used, and finally the
// local LM Studio model - nothing ever fails just because a cloud API did.
//
// Configure in .env (keys are pasted there by you, never in chat):
//   CLOUD_1_NAME=NVIDIA
//   CLOUD_1_URL=https://integrate.api.nvidia.com/v1
//   CLOUD_1_KEY=nvapi-...
//   CLOUD_1_MODEL=meta/llama-3.3-70b-instruct
//   CLOUD_1_CONTEXT=32000          (tokens the model accepts)
//   CLOUD_1_RPM=30                 (requests per minute we allow ourselves)
//   CLOUD_1_PRIVATE=1              (1 = may receive PRIVATE chats; 0 = groups only)
//   CLOUD_2_... the same for a second provider (e.g. Gemini, PRIVATE=0 on the free tier).
// Per chat, "local only" in the dashboard keeps that chat away from every cloud provider.

const OpenAI = require('openai');

function readProviders(env = process.env) {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    const url = (env[`CLOUD_${i}_URL`] || '').trim();
    const key = (env[`CLOUD_${i}_KEY`] || '').trim();
    const model = (env[`CLOUD_${i}_MODEL`] || '').trim();
    if (!url || !key || !model) continue;
    list.push({
      n: i,
      name: (env[`CLOUD_${i}_NAME`] || `cloud${i}`).trim(),
      url, model,
      context: Number(env[`CLOUD_${i}_CONTEXT`] || 32000),
      rpm: Number(env[`CLOUD_${i}_RPM`] || 30),
      private: String(env[`CLOUD_${i}_PRIVATE`] ?? '0') === '1',
      client: new OpenAI({ baseURL: url, apiKey: key, timeout: 60 * 1000, maxRetries: 0 }),
      calls: [],            // timestamps of recent calls (rate limit)
      downUntil: 0,         // cooling down after errors / no credits
      stats: { ok: 0, failed: 0, last_error: null, last_used: null },
    });
  }
  return list;
}

// Models to try (in this order) when the configured one was retired by the provider.
const FALLBACK_MODELS = {
  nvidia: ['google/gemma-4-31b-it', 'deepseek-ai/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'mistralai/mistral-large-2-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct'],
  googleapis: ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-2.5-flash'],
};
const fallbackListFor = (p) => (process.env[`CLOUD_${p.n}_FALLBACK_MODELS`] || '').split(',').map((x) => x.trim()).filter(Boolean)
  .concat(Object.entries(FALLBACK_MODELS).find(([k]) => p.url.includes(k))?.[1] || []);

// Gemini 3 always "thinks" and the thinking uses the output budget -> keep it low and give it room.
const wellFormed = (t) => (typeof t === 'string' ? (t.toWellFormed ? t.toWellFormed() : t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')) : t);
function requestFor(p, { maxTokens, temperature, messages }) {
  messages = messages.map((m) => ({ ...m, content: wellFormed(m.content) }));
  const req = { model: p.model, temperature, max_tokens: maxTokens, messages };
  if (p.url.includes('googleapis')) { req.reasoning_effort = 'low'; req.max_tokens = maxTokens + 2048; }
  return req;
}

function createLLM({ openai, localModel, localContext, log, logError, localIsLocal = true, localAllowsPrivate = true }) {
  const providers = readProviders();
  if (providers.length) log(`Cloud models: ${providers.map((p) => `${p.name} (${p.model}${p.private ? '' : ', groups only'})`).join(' -> ')} -> local ${localModel}`);

  const available = (p) => {
    const now = Date.now();
    p.calls = p.calls.filter((t) => now - t < 60000);
    return now > p.downUntil && p.calls.length < p.rpm;
  };

  function coolDown(p, err) {
    const status = err?.status || err?.response?.status;
    const msg = String(err?.message || err);
    // 402 / quota = credits are finished -> don't try again for 6 hours. 429 = slow down for a minute.
    const ms = status === 402 || /quota|credit|billing/i.test(msg) ? 6 * 3600e3
      : status === 429 ? 60e3
      : status === 401 || status === 403 || status === 404 || status === 410 ? 12 * 3600e3
      // timeouts / server errors: 5 min, and doubling while it keeps failing (up to 2 hours)
      : Math.min(5 * 60e3 * 2 ** Math.min(p.streak || 0, 5), 2 * 3600e3);
    p.streak = (p.streak || 0) + 1;
    p.downUntil = Date.now() + ms;
    p.stats.failed += 1;
    p.stats.last_error = `${status || ''} ${msg}`.trim().slice(0, 200);
    logError(`Cloud model ${p.name} failed (${p.stats.last_error}) - using the next one for ${Math.round(ms / 60000)} min.`);
  }

  // job: { task, sensitive: bool (private chat), localOnly: bool, maxTokens, temperature,
  //        build: (contextTokens) => messages }   -> { text, provider }
  async function run(job) {
    const { sensitive = false, maxTokens = 800, temperature = 0.2, build, stop } = job;
    // Privacy mode (settings): local = never use the cloud; manual = only for things the user asked for right now.
    const mode = process.env.PRIVACY_MODE || 'hybrid';
    const localOnly = Boolean(job.localOnly) || mode === 'local' || (mode === 'manual' && !job.interactive);
    if (!localOnly) {
      for (const p of providers) {
        if (sensitive && !p.private) continue;
        if (!available(p)) continue;
        p.calls.push(Date.now());
        try {
          const res = await p.client.chat.completions.create(requestFor(p, { maxTokens, temperature, messages: build(p.context) }));
          const text = res.choices?.[0]?.message?.content;
          if (!text || !String(text).trim()) throw new Error('empty answer');
          p.stats.ok += 1;
          p.streak = 0;
          p.stats.last_used = Math.floor(Date.now() / 1000);
          return { text: String(text).replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim(), provider: p.name };
        } catch (err) {
          coolDown(p, err);
        }
      }
    }
    // The "local" model may really be a cloud service (engine set to "cloud only"). Text that must stay on this
    // computer (a chat marked local-only, the privacy mode) or a private chat that provider may not see never goes there.
    if (!localIsLocal) {
      const mustStay = Boolean(job.privateLocal) || mode === 'local' || (mode === 'manual' && !job.interactive);
      if (mustStay) throw new Error('לפי הגדרות הפרטיות הטקסט הזה נשאר במחשב, ואין מודל מקומי');
      if (sensitive && !localAllowsPrivate) throw new Error('שיחה פרטית: ספק הענן הראשי לא מורשה לקבל שיחות פרטיות');
    }
    // Local model. Hebrew sometimes needs more tokens than our estimate - if LM Studio says the
    // context is full, try once more with half the history instead of failing.
    const local = (ctx) => openai.chat.completions.create({
      model: localModel, temperature, max_tokens: maxTokens, messages: build(ctx), ...(stop ? { stop } : {}), _interactive: Boolean(job.interactive),
    });
    let res;
    try {
      res = await local(localContext);
    } catch (err) {
      if (!/context (size|length)|n_ctx|exceed/i.test(String(err?.message || err))) throw err;
      log(`Local model context was full (${job.task || 'job'}) - retrying with less history.`);
      res = await local(Math.floor(localContext / 2));
    }
    return { text: res.choices?.[0]?.message?.content || '', provider: 'מקומי' };
  }

  const status = () => providers.map((p) => ({
    name: p.name, model: p.model, private: p.private, context: p.context,
    ready: Date.now() > p.downUntil, cooling_until: p.downUntil > Date.now() ? Math.floor(p.downUntil / 1000) : null, ...p.stats,
  }));

  // On start: one tiny request per provider, result written to logs/cloud-status.json (and the log).
  async function selfTest(file) {
    const out = [];
    for (const p of providers) {
      const t0 = Date.now();
      try {
        const ask = async () => {
          const res = await p.client.chat.completions.create(requestFor(p, { maxTokens: 300, temperature: 0, messages: [{ role: 'user', content: 'ענה במילה אחת בלבד: מה בירת צרפת?' }] }));
          const t = String(res.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim().slice(0, 60);
          if (!t) throw Object.assign(new Error('empty answer'), { status: 'empty' });
          return t;
        };
        let text;
        try {
          text = await ask();
        } catch (err) {
          const st = err?.status || err?.response?.status;
          if (![404, 410].includes(st) && !/not found|end of life|no longer available|does not exist|timed out|timeout/i.test(String(err?.message))) throw err;
          // The configured model was retired -> pick the first available model from the fallback list.
          const was = p.model;
          let ids = [];
          try { ids = (await p.client.models.list()).data.map((m) => m.id); } catch { /* some providers don't list */ }
          p.availableModels = ids;
          const candidates = fallbackListFor(p).filter((m) => m !== was && (!ids.length || ids.includes(m) || ids.includes(`models/${m}`)));
          p.tried = [];
          for (const m of candidates) {
            p.model = m;
            try { text = await ask(); break; } catch (e2) { text = null; p.tried.push({ model: m, error: `${e2?.status || ''} ${String(e2?.message || e2)}`.slice(0, 200) }); }
          }
          if (!text) { p.model = was; throw err; }
          log(`Cloud ${p.name}: model "${was}" did not work (${String(err?.message).slice(0, 60)}) - using "${p.model}" instead. (Update CLOUD_${p.n}_MODEL in .env to keep it.)`);
        }
        out.push({ name: p.name, model: p.model, configured_model: (process.env[`CLOUD_${p.n}_MODEL`] || '').trim(), ok: true, ms: Date.now() - t0, answer: text });
        log(`Cloud check ${p.name}: OK (${Date.now() - t0} ms) "${text}"`);
      } catch (err) {
        const status = err?.status || err?.response?.status || null;
        out.push({ name: p.name, model: p.model, ok: false, status, error: String(err?.message || err).slice(0, 300), available_models: (p.availableModels || []).slice(0, 400), tried: p.tried || [] });
        logError(`Cloud check ${p.name} FAILED: ${status || ''} ${String(err?.message || err).slice(0, 200)}`);
        if (status === 401 || status === 403 || status === 404) coolDown(p, err);
      }
    }
    try { require('fs').mkdirSync(require('path').dirname(file), { recursive: true }); require('fs').writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), results: out }, null, 2)); } catch { /* ignore */ }
    return out;
  }

  return { run, status, selfTest, hasCloud: providers.length > 0 };
}

module.exports = { createLLM, readProviders };
