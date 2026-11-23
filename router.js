// Model routing: small, fast models do the sorting; the big model only gets what matters.
//
//   FAST_MODEL     a small model (3-4B) - yes/no gates and "which lines matter?" filtering.
//                  Suggested: google/gemma-3-4b (good Hebrew for its size) or qwen/qwen3-4b.
//   LLM_MODEL      the big model - summaries, answers, analysis (e.g. google/gemma-3-27b).
//   EXTRACT_MODEL  events/tasks JSON (defaults to LLM_MODEL).
//   VISION_MODEL   images (e.g. qwen/qwen2.5-vl-7b).
//
// Leave FAST_MODEL empty and everything goes straight to the big model, exactly as before.
// Every step here "fails open": if the small model is down, slow or answers nonsense, the
// message/lines are passed on unfiltered - the filter can save time, never lose information.

const FAST_MODEL = (process.env.FAST_MODEL || '').trim();
// The built-in engine runs the agent model in its own server (localai.js); LM Studio serves both from one address.
const FAST_BASE_URL = (process.env.FAST_BASE_URL || '').trim();
const { agentJobs } = require('./appsettings');
const JOBS = new Set(agentJobs());
const FILTER_MIN_ROWS = Number(process.env.FILTER_MIN_ROWS || 60);   // filter only long conversations
const BATCH = 40;
const SLOW_MS = 25000;            // a gate slower than this is not worth it
const PAUSE_MS = 30 * 60 * 1000;  // after repeated trouble: pause the small model for 30 minutes

function createRouter({ openai: mainClient, log, logError }) {
  const openai = FAST_BASE_URL ? new (require('openai'))({ baseURL: FAST_BASE_URL, apiKey: 'local', maxRetries: 1 }) : mainClient;
  let failures = 0;
  let pausedUntil = 0;
  const stats = { gates: 0, gated_out: 0, filtered_in: 0, filtered_out: 0, errors: 0 };

  const enabled = () => Boolean(FAST_MODEL) && Date.now() > pausedUntil;

  function trouble(err) {
    stats.errors += 1;
    failures += 1;
    if (failures >= 3) {
      pausedUntil = Date.now() + PAUSE_MS;
      failures = 0;
      logError(`Small model "${FAST_MODEL}" keeps failing (${err.message}) - using only the big model for 30 minutes.`);
    }
  }

  // Qwen3 "thinks" out loud unless told not to; strip any thinking that slips through.
  const noThink = /qwen3/i.test(FAST_MODEL);
  async function ask(messages, maxTokens) {
    if (noThink) messages = messages.map((m) => (m.role === 'user' ? { ...m, content: `${m.content} /no_think` } : m));
    const started = Date.now();
    const res = await Promise.race([
      openai.chat.completions.create({ model: FAST_MODEL, temperature: 0, max_tokens: maxTokens, messages }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SLOW_MS)),
    ]);
    if (Date.now() - started > SLOW_MS * 0.8) trouble(new Error('slow'));
    else failures = 0;
    return String(res.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  }

  // Yes/no question about one message. true = "pass it on to the big model".
  async function gate(question, text) {
    if (!enabled() || !JOBS.has('gate')) return true;
    stats.gates += 1;
    try {
      const out = await ask([
        { role: 'system', content: 'אתה מסנן הודעות. ענה במילה אחת בלבד: כן או לא.' },
        { role: 'user', content: `${question}\n\nההודעה:\n"""${String(text).slice(0, 1200)}"""\n\nענה: כן / לא` },
      ], 3);
      // (\b doesn't work after Hebrew letters in JS regex - use an explicit end-of-word check)
      const no = /^\s*["'*]*(לא|no)(?=$|[\s.,!"'*])/i.test(out);
      const yes = /^\s*["'*]*(כן|yes)(?=$|[\s.,!"'*])/i.test(out);
      if (!yes && !no) return true; // unclear -> let the big model decide
      if (no) stats.gated_out += 1;
      return yes;
    } catch (err) {
      trouble(err);
      return true;
    }
  }

  // Keep only the lines that matter for `purpose`. Lines from "me", with numbers/times, or with a
  // question mark are always kept (cheap safety net), the rest is judged by the small model.
  async function filterRows(rows, purpose, lineOf) {
    if (!enabled() || !JOBS.has('filter') || rows.length < FILTER_MIN_ROWS) return rows;
    const keep = new Set();
    const always = (r) => r.from_me || /\d|\?/.test(String(r.content || ''));
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      batch.forEach((r, j) => { if (always(r)) keep.add(i + j); });
      const listing = batch.map((r, j) => `${j + 1}. ${lineOf(r).slice(0, 220)}`).join('\n');
      try {
        const out = await ask([
          { role: 'system', content: 'אתה מסנן הודעות וואטסאפ. מחזיר רק מספרים מופרדים בפסיקים, בלי טקסט נוסף.' },
          { role: 'user', content: `${purpose}\nאילו מההודעות הבאות חשובות לזה? התעלם מברכות, תודה, אימוג׳ים, "😂", "אוקיי", מדבקות ושיחות חולין.\n\n${listing}\n\nהחזר את המספרים של ההודעות החשובות בלבד (למשל: 2,5,9). אם אף אחת - החזר 0.` },
        ], 160);
        const nums = (out.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= batch.length);
        if (!nums.length && !/^\s*0\s*$/.test(out)) { batch.forEach((_, j) => keep.add(i + j)); continue; } // unclear -> keep all
        nums.forEach((n) => keep.add(i + n - 1));
      } catch (err) {
        trouble(err);
        batch.forEach((_, j) => keep.add(i + j));
      }
    }
    const kept = rows.filter((_, i) => keep.has(i));
    stats.filtered_in += kept.length;
    stats.filtered_out += rows.length - kept.length;
    if (kept.length < rows.length) log(`Small model kept ${kept.length}/${rows.length} messages (${purpose.slice(0, 40)}...)`);
    // Never hand the big model an empty conversation because of the filter.
    return kept.length >= Math.min(5, rows.length) ? kept : rows;
  }

  /** For other simple jobs (link gist, extraction): the agent's client + model when that job is given to the agent. */
  const forJob = (job) => (FAST_MODEL && enabled() && JOBS.has(job) ? { client: openai, model: FAST_MODEL } : null);
  return { gate, filterRows, forJob, stats, jobs: [...JOBS], get model() { return FAST_MODEL || null; }, get active() { return enabled(); } };
}

module.exports = { createRouter };
