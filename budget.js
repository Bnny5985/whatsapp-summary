// Keeps every prompt inside the model's context window (LM Studio "Context Length").
// Hebrew costs roughly one token per 2 characters, so we count conservatively.
// Set LLM_CONTEXT_TOKENS in .env to the Context Length you set for the model in LM Studio.

const CONTEXT_TOKENS = Number(process.env.LLM_CONTEXT_TOKENS || 8192);
const CHARS_PER_TOKEN = 2;

const estTokens = (text) => Math.ceil(String(text || '').length / CHARS_PER_TOKEN);

// How many tokens are left for message history, after the answer, instructions and memory.
function historyBudget({ answerTokens = 600, fixedText = '', context = CONTEXT_TOKENS } = {}) {
  return Math.max(800, context - answerTokens - estTokens(fixedText) - 350);
}

// Newest lines first until the budget is full; returned in the original (chronological) order.
function fitNewest(rows, lineOf, maxTokens) {
  const out = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = estTokens(lineOf(rows[i])) + 1;
    if (used + t > maxTokens) break;
    used += t;
    out.push(rows[i]);
  }
  return out.reverse();
}

// For questions: the lines that match the question best, plus the newest ones, within the budget.
const PREFIX = /^[והשבלמכ]{1,2}(?=[֐-׿]{2,})/;
function words(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.replace(PREFIX, ''))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}
const STOP = new Set(['מה', 'מי', 'מתי', 'איפה', 'איך', 'למה', 'של', 'את', 'על', 'עם', 'זה', 'זו', 'היא', 'הוא', 'אני', 'יש', 'לא', 'כן', 'גם', 'רק', 'או', 'אם', 'כל', 'עוד', 'כבר', 'the', 'a', 'to']);

function fitRelevant(rows, question, lineOf, maxTokens, { boost = () => 0 } = {}) {
  const q = new Set(words(question));
  const scored = rows.map((r, i) => {
    const w = words(lineOf(r));
    let s = 0;
    for (const x of w) if (q.has(x)) s += 2;
    s += boost(r);
    s += (i / rows.length) * 1.5; // a little preference for newer lines
    return { r, i, s };
  });
  scored.sort((a, b) => b.s - a.s);
  const keep = new Set();
  let used = 0;
  for (const x of scored) {
    const t = estTokens(lineOf(x.r)) + 1;
    if (used + t > maxTokens) continue;
    used += t;
    keep.add(x.i);
  }
  return rows.filter((_, i) => keep.has(i));
}

const isContextError = (err) => /context (size|length)|n_ctx|exceed_context/i.test(String(err?.message || err));
const CONTEXT_ERROR_HE = `השאלה ארוכה מדי לזיכרון של המודל (${CONTEXT_TOKENS} טוקנים). אפשר לצמצם טווח זמן, או להגדיל ב-LM Studio את Context Length ולעדכן LLM_CONTEXT_TOKENS בקובץ .env.`;

module.exports = { CONTEXT_TOKENS, estTokens, historyBudget, fitNewest, fitRelevant, isContextError, CONTEXT_ERROR_HE };
