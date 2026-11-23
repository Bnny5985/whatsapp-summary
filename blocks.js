// Time blocks: long conversations are never sent to a model in one piece.
//
// Every chat is cut into 6-hour blocks (00-06, 06-12, 12-18, 18-24, Israel winter time).
// A block that has ended is summarized ONCE and the summary is kept in the database
// (table chat_blocks). A summary of 3 days / a week is then built from those short block
// summaries + the raw messages of the block that is still open - "a summary of summaries".
// A very busy block that doesn't fit the model is itself split into parts first.
// If new messages land in an old block later (history loaded), only that block is redone.

const SIZE = 6 * 3600;
const ORIGIN = -2 * 3600;                 // blocks aligned to Israel standard time (UTC+2)
const blockStart = (ts) => ts - (((ts - ORIGIN) % SIZE) + SIZE) % SIZE;

function createBlocks({ db, budget, llmText, events, isPrivateChat, log, logError }) {
  const fmtTime = (ts) => new Date(ts * 1000).toLocaleString('he-IL', { timeZone: events.TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const lineOf = (r) => `[${new Date((r.timestamp || 0) * 1000).toLocaleTimeString('he-IL', { timeZone: events.TZ, hour: '2-digit', minute: '2-digit' })}] ${r.sender_name}: ${r.content}`;
  const label = (b) => `${fmtTime(b.start_ts)} - ${new Date(b.end_ts * 1000).toLocaleTimeString('he-IL', { timeZone: events.TZ, hour: '2-digit', minute: '2-digit' })}`;
  // What one part may hold so that even the local model (smallest window) can read it.
  const PART_TOKENS = budget.historyBudget({ answerTokens: 500, fixedText: '', context: budget.CONTEXT_TOKENS }) - 400;

  // Split rows (in order) into parts that each fit PART_TOKENS.
  function split(rows) {
    const parts = [];
    let cur = [];
    let used = 0;
    for (const r of rows) {
      const t = budget.estTokens(lineOf(r)) + 1;
      if (cur.length && used + t > PART_TOKENS) { parts.push(cur); cur = []; used = 0; }
      cur.push(r);
      used += t;
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  async function ask(chat, task, prompt, maxTokens = 450) {
    const { text } = await llmText({
      task,
      localOnly: Boolean(chat.local_only),
      sensitive: isPrivateChat(chat),
      maxTokens,
      temperature: 0.2,
      build: () => [
        { role: 'system', content: 'אתה מסכם קטעים משיחות וואטסאפ בעברית. רק עובדות שנכתבו, בלי להמציא. נקודות קצרות.' },
        { role: 'user', content: prompt },
      ],
    });
    return String(text || '').trim();
  }

  const BLOCK_RULES = 'סכם ב-2 עד 6 נקודות קצרות (כל נקודה מתחילה ב-"• "): החלטות, בקשות (מי ביקש ממי), מועדים ושעות, רשימות (העתק את כל הפריטים), מידע חשוב. שמור שמות של אנשים. דלג על חולין. "אני" = המשתמש.';

  // Summary of one block (from the database if nothing changed).
  async function blockSummary(chat, start) {
    const end = start + SIZE;
    const rows = await db.getMessagesBetween(chat.chat_id, start, end);
    if (!rows.length) return null;
    const lastTs = rows[rows.length - 1].timestamp;
    const cached = await db.getBlock(chat.chat_id, start);
    if (cached && cached.message_count === rows.length && cached.last_ts === lastTs && cached.content) return cached;

    const parts = split(rows);
    let content;
    if (parts.length === 1) {
      content = await ask(chat, 'block summary', `הודעות מ"${chat.name || ''}" בין ${label({ start_ts: start, end_ts: end })}:\n${rows.map(lineOf).join('\n')}\n\n${BLOCK_RULES}`);
    } else {
      // A very busy block: summarize each part, then join the part summaries.
      const partSums = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        partSums.push(`חלק ${i + 1} (${fmtTime(p[0].timestamp)}):\n${await ask(chat, 'block part', `חלק ${i + 1} מתוך ${parts.length} של הודעות מ"${chat.name || ''}":\n${p.map(lineOf).join('\n')}\n\n${BLOCK_RULES}`)}`);
      }
      content = await ask(chat, 'block merge', `אלה סיכומים של חלקים רצופים מאותו פרק זמן בשיחה "${chat.name || ''}" (${label({ start_ts: start, end_ts: end })}):\n\n${partSums.join('\n\n')}\n\nאחד אותם לסיכום אחד. ${BLOCK_RULES}`, 600);
    }
    if (!content) throw new Error('empty block summary');
    const row = { chat_id: chat.chat_id, start_ts: start, end_ts: end, message_count: rows.length, last_ts: lastTs, content };
    await db.saveBlock(row);
    return row;
  }

  // All closed blocks with messages between since and until (summarized if needed, oldest first).
  async function closedBlocks(chat, since, until = Math.floor(Date.now() / 1000), { max = 60 } = {}) {
    const openStart = blockStart(until);
    const stats = await db.blockStats(chat.chat_id, blockStart(since), openStart, ORIGIN, SIZE);
    const out = [];
    for (const s of stats.slice(-max)) {
      const start = ORIGIN + s.idx * SIZE;
      try {
        const b = await blockSummary(chat, start);
        if (b) out.push(b);
      } catch (err) {
        logError(`Block summary failed (${chat.name} ${fmtTime(start)}):`, err.message);
      }
    }
    return { blocks: out, openStart };
  }

  // Text for a final prompt: "[time range] summary" per block.
  const blocksText = (blocks) => blocks.map((b) => `[${label(b)}]\n${b.content}`).join('\n\n');

  // Only what is already saved (no model calls) - used as extra context for questions.
  async function savedText(chat, since, until, maxTokens) {
    const list = await db.listBlocks(chat.chat_id, blockStart(since), until);
    const fit = budget.fitNewest(list, (b) => `[${label(b)}] ${b.content}`, maxTokens);
    return fit.map((b) => `[${chat.name || ''} · ${label(b)}] ${b.content}`).join('\n');
  }

  // Background: summarize ended blocks of the last `days` days ahead of time, a few per run,
  // so asking for a week's summary is instant.
  let prefilling = false;
  async function prefill(chats, { days = 7, maxPerRun = 8 } = {}) {
    if (prefilling) return 0;
    prefilling = true;
    let done = 0;
    try {
      const now = Math.floor(Date.now() / 1000);
      for (const chat of chats) {
        const stats = await db.blockStats(chat.chat_id, blockStart(now - days * 86400), blockStart(now), ORIGIN, SIZE);
        for (const s of stats) {
          if (done >= maxPerRun) return done;
          if (s.n < 3) continue;
          const start = ORIGIN + s.idx * SIZE;
          const cached = await db.getBlock(chat.chat_id, start);
          if (cached && cached.message_count === s.n && cached.last_ts === s.last_ts) continue;
          await blockSummary(chat, start).then(() => { done += 1; }).catch((err) => logError('Block prefill failed:', err.message));
        }
      }
      if (done) log(`Summarized ${done} time block(s) ahead of time.`);
      return done;
    } finally { prefilling = false; }
  }

  return { SIZE, blockStart, split, blockSummary, closedBlocks, blocksText, savedText, prefill, lineOf };
}

module.exports = { createBlocks, blockStart, BLOCK_SIZE: SIZE };
