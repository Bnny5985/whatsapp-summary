// "Memory" - what the bot knows about the people and the groups, and how it keeps learning.
//
//  1. Group character  - nightly, the model writes a short description of every marked group:
//     tone, typical topics, who does what, slang/abbreviations, how people write.
//  2. Daily questions  - every evening the bot asks the owner 3-5 short questions about things it
//     wasn't sure of today (who is X, what does a word mean, is this group work or family...).
//     Answers are stored and become facts.
//  3. People           - one memory per PERSON across all chats (keyed by phone number): what they
//     wrote in groups and in private, their profile, and every fact learned about them.
//  4. Context          - every summary / question / analysis gets the facts + group character +
//     the people in that chat, so the bot understands the context better every day.
//
// Everything stays in the local SQLite file. Nothing here sends anything anywhere except the
// local model (LM Studio) and, if configured, the owner's own Telegram chat.

const MAX_CONTEXT_CHARS = 2400;      // small local models: keep the memory block short
const QUESTIONS_PER_DAY = Number(process.env.DAILY_QUESTIONS || 4);
const QUESTIONS_HOUR = Number(process.env.DAILY_QUESTIONS_HOUR ?? 21);

function createMemory({ db, openai, model, events, sanitize, stop, log, logError, skipChat = () => false, budget = null, ownerId = () => null, knownAliases = () => ({}), llmRun = null }) {
  const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

  // One way to call a model: the hybrid runner (cloud -> local) when available, else the local model.
  async function gen({ task, sensitive = true, localOnly = false, maxTokens, temperature = 0.2, build }) {
    if (llmRun) return (await llmRun({ task, sensitive, localOnly, maxTokens, temperature, build })).text || '';
    const ctx = budget ? budget.CONTEXT_TOKENS : 8192;
    const res = await openai.chat.completions.create({ model, temperature, max_tokens: maxTokens, stop, messages: build(ctx) });
    return sanitize(res.choices?.[0]?.message?.content) || '';
  }

  const parseArr = (j) => { try { return JSON.parse(j || '[]'); } catch { return []; } };
  const digits = (id) => String(id || '').split('@')[0].replace(/\D/g, '');

  // One block per person: profile (learned from ALL chats) + facts about them.
  async function personBlock(person, { profileChars = 260, facts = 6 } = {}) {
    if (!person) return '';
    const f = await db.listPersonFacts(person.id, facts);
    const lines = [];
    if (person.profile) lines.push(clip(person.profile, profileChars));
    for (const x of f) lines.push(`• ${clip(x.answer, 160)}`);
    return lines.length ? `- ${person.name || person.id}:\n  ${lines.join('\n  ')}` : '';
  }

  // ---------- context block for prompts ----------
  async function contextFor(chat, { includeProfiles = true } = {}) {
    if (!chat) return '';
    const parts = [];
    const fresh = chat.group_profile === undefined ? await db.getChat(chat.chat_id) : chat;
    if (fresh?.group_profile) parts.push(`אופי השיחה "${fresh.name || ''}": ${clip(fresh.group_profile, 500)}`);
    if (fresh?.notes && fresh.notes.trim()) parts.push(`הערות שהמשתמש כתב: ${clip(fresh.notes.trim(), 300)}`);

    const facts = await db.listMemoryFacts({ chat_id: chat.chat_id, limit: 20, noPerson: true });
    const general = await db.listMemoryFacts({ chat_id: null, limit: 8, noPerson: true });
    const factLines = [...facts, ...general].map((f) => `- ${f.subject ? `${f.subject}: ` : ''}${f.answer}`);
    if (factLines.length) parts.push(`דברים שהמשתמש לימד אותי (אמת, עדיף על ניחוש):\n${factLines.join('\n')}`);

    if (includeProfiles) {
      // The people in this chat - what is known about each of them from every chat.
      const senders = await db.getSenderStats(chat.chat_id, 0, 8);
      const blocks = [];
      for (const s2 of senders) {
        const person = await db.getPerson(s2.sender_id);
        const b2 = person ? await personBlock(person, { profileChars: senders.length > 3 ? 160 : 320 }) : '';
        if (b2) blocks.push(b2);
      }
      if (!blocks.length) {
        const profiles = (await db.getPersonProfiles(chat.chat_id)).filter((p) => p.profile_text).slice(0, 6);
        for (const p of profiles) blocks.push(`- ${p.sender_name}: ${clip(p.profile_text, 160)}`);
      }
      if (blocks.length) parts.push(`האנשים בשיחה (מה שלמדתי עליהם מכל השיחות):\n${blocks.join('\n')}`);
    }
    const text = parts.join('\n\n');
    return text ? `\n\n--- מה שאני כבר יודע על השיחה הזו ---\n${clip(text, MAX_CONTEXT_CHARS)}\n` : '';
  }

  // People whose name / nickname / chat name appears in a free-text question.
  async function peopleNamedIn(text) {
    const q = String(text || '');
    const people = await db.listPeople(300);
    const out = [];
    for (const p of people) {
      const names = [p.name, ...parseArr(p.aliases)].map((n) => String(n || '').trim()).filter((n) => n.length >= 2);
      const firsts = names.map((n) => n.split(/\s+/)[0]).filter((n) => n.length >= 3);
      if ([...names, ...firsts].some((n) => q.includes(n))) {
        out.push({ id: p.id, person: p, names, ids: [p.id, ...parseArr(p.ids).map(digits)].filter(Boolean) });
      }
    }
    return out.slice(0, 4);
  }

  // For questions across all chats: general facts + the people the question is about.
  async function generalContext({ question = '' } = {}) {
    const parts = [];
    const facts = await db.listMemoryFacts({ limit: 20, noPerson: true });
    if (facts.length) parts.push(facts.map((f) => `- ${f.chat_name ? `[${f.chat_name}] ` : ''}${f.subject ? `${f.subject}: ` : ''}${f.answer}`).join('\n'));
    for (const n of await peopleNamedIn(question)) {
      const b2 = await personBlock(n.person, { profileChars: 400, facts: 12 });
      if (b2) parts.push(b2);
    }
    return parts.length ? `\n\n--- מה שאני כבר יודע ---\n${clip(parts.join('\n'), MAX_CONTEXT_CHARS)}\n` : '';
  }

  // ---------- people: learn each person from every chat ----------
  async function registerPeople({ days = 60 } = {}) {
    const chats = (await db.listListeningChats()).filter((c) => !skipChat(c));
    const top = await db.topSenders(chats.map((c) => c.chat_id), Math.floor(Date.now() / 1000) - days * 86400, 40);
    const me = digits(ownerId());
    for (const t of top) {
      if (me && digits(t.sender_id) === me) continue;
      const priv = chats.find((c) => !c.is_group && digits(c.chat_id) === digits(t.sender_id));
      await db.upsertPerson({ id: t.sender_id, name: t.sender_name, ids: [t.sender_id], aliases: [t.sender_name, priv?.name], message_count: t.count });
    }
    for (const [id, names] of Object.entries(knownAliases() || {})) {
      if (id) await db.upsertPerson({ id, aliases: names, ids: [`${id}@c.us`] });
    }
    return top;
  }

  async function learnPerson(id, { deep = false } = {}) {
    const person = await db.getPerson(id);
    if (!person) return null;
    const ids = parseArr(person.ids).length ? parseArr(person.ids) : [id];
    let rows = await db.getMessagesByPerson(ids, Math.floor(Date.now() / 1000) - 120 * 86400, 600);
    if (rows.length < 5) return null;
    const lineOf = (r) => `[${r.is_group ? `קבוצה: ${r.chat_name || ''}` : 'פרטי'}] ${clip(String(r.content).replace(/\n+/g, ' / '), 300)}`;
    const facts = (await db.listPersonFacts(person.id, 20)).map((f) => `- ${f.answer}`).join('\n');
    const allRows = rows;
    const name = person.name || person.id;
    const ask = deep
      ? `כתוב פרופיל של ${name} ב-8 עד 12 שורות קצרות, כל שורה מתחילה ב-"• ":
• מי היא בשבילי ומה הסגנון שלה בכתיבה (איך היא מבקשת דברים, מתי היא דחופה, אימוג׳ים/קיצורים שלה)
• מה היא אוהבת ומה חשוב לה
• שגרה קבועה (ילדים, גן, עבודה, שעות, חיות)
• אנשים שהיא מזכירה ומי הם
• בקשות שחוזרות על עצמן ומה היא מצפה שאעשה
• דברים שכדאי לי לזכור (תאריכים, העדפות, דברים שמרגיזים אותה)`
      : `כתוב פרופיל קצר של ${name} ב-3 עד 5 שורות, כל שורה מתחילה ב-"• ": מי זה כנראה ומה הקשר שלו אליי, על מה הוא מדבר, איך הוא כותב (רשמי/סלנג/קיצורים/הומור), ומה הוא בדרך כלל מבקש ממני או מהקבוצה.`;
    const text = await gen({
      task: `learn person ${name}`,
      sensitive: allRows.some((r) => !r.is_group),
      maxTokens: deep ? 700 : 420,
      build: (ctx) => {
        rows = budget ? budget.fitNewest(allRows, lineOf, budget.historyBudget({ answerTokens: deep ? 700 : 420, fixedText: facts, context: ctx }) - 400) : allRows;
        return [
          { role: 'system', content: 'אתה מכיר אנשים לפי ההודעות שלהם בוואטסאפ. כותב בעברית, עובדתי, בלי להמציא, בגוף שלישי.' },
          { role: 'user', content: `אלה ${rows.length} הודעות ש"${name}" כתב/ה בכל השיחות שלי (קבוצות ופרטי).${facts ? `\nמה שכבר ידוע עליו/ה (אמת):\n${facts}` : ''}\n\n${rows.map(lineOf).join('\n')}\n\n${ask}` },
        ];
      },
    });
    if (text) await db.setPersonProfile(person.id, text);
    return text;
  }

  // Nightly: learn the most active people + always the people that matter most (deep).
  async function learnPeople({ important = [], max = 12 } = {}) {
    const top = await registerPeople();
    const done = new Set();
    for (const id of important.filter(Boolean)) {
      if (!(await db.getPerson(id))) await db.upsertPerson({ id, ids: [`${digits(id)}@c.us`] });
      await learnPerson(id, { deep: true }).catch((err) => logError('learnPerson failed:', err.message));
      done.add(digits(id));
    }
    let n = 0;
    for (const t of top) {
      if (n >= max || done.has(digits(t.sender_id)) || t.count < 8) continue;
      await learnPerson(t.sender_id).catch((err) => logError('learnPerson failed:', err.message));
      done.add(digits(t.sender_id));
      n += 1;
    }
    log(`Learned ${done.size} people across all chats`);
    return done.size;
  }

  // Short facts learned along the way (e.g. from the Partner analysis) -> that person's memory, no duplicates.
  async function rememberAboutPerson(id, items, { chat = null, names = [] } = {}) {
    if (!id || !items || !items.length) return 0;
    const cur = await db.getPerson(id);
    const key = await db.upsertPerson({ id, name: cur?.name ? null : names.find((x) => x && !/love|אהובתי/i.test(x)) || names[0] || null, aliases: names, ids: [String(id).includes('@') ? id : `${digits(id)}@c.us`] });
    const person = await db.getPerson(key);
    const norm = (t) => String(t || '').replace(/[^\p{L}\p{N}]/gu, '');
    const existing = (await db.listPersonFacts(key, 200)).map((f) => norm(f.answer));
    let added = 0;
    for (const raw of items.slice(0, 6)) {
      const t = String(raw || '').trim();
      const n = norm(t);
      if (n.length < 5 || existing.some((e) => e === n || e.includes(n) || (n.includes(e) && e.length > 12))) continue;
      const qid = await db.addQuestion({ day: events.israelParts().date, chat_id: chat?.chat_id || null, chat_name: chat?.name || null, about: 'learned', subject: person?.name || names[0] || null, question: null, person_id: key });
      await db.updateQuestion(qid, { answer: clip(t, 300), status: 'answered', answered_at: Math.floor(Date.now() / 1000) });
      existing.push(n);
      added += 1;
    }
    if (added) log(`Remembered ${added} new thing(s) about ${person?.name || key}`);
    return added;
  }

  // ---------- 1. group character ----------
  async function learnGroup(chat) {
    let rows = await db.getRecentMessages(chat.chat_id, 200);
    if (rows.length < 15) return null;
    const known = await contextFor(chat, { includeProfiles: true });
    const allRows = rows;
    const raw = await gen({
      task: `learn chat ${chat.name || ''}`,
      sensitive: !chat.is_group,
      localOnly: Boolean(chat.local_only),
      maxTokens: 380,
      build: (ctx) => {
      rows = budget ? budget.fitNewest(allRows, (r) => `${r.sender_name}: ${clip(r.content, 220)}`, budget.historyBudget({ answerTokens: 380, fixedText: known, context: ctx }) - 300) : allRows;
      const history = rows.map((r) => `${r.from_me ? 'אני' : r.sender_name}: ${clip(r.content, 220)}`).join('\n');
      return [
        { role: 'system', content: 'אתה מנתח שיחות וואטסאפ. כותב בעברית, קצר ועובדתי, בלי להמציא.' },
        {
          role: 'user',
          content: `להלן ${rows.length} ההודעות האחרונות מהשיחה "${chat.name || chat.chat_id}" ("אני" = המשתמש).${known}

${history}

תאר את אופי השיחה ב-4 עד 6 שורות קצרות, כל שורה מתחילה ב-"• ":
• מה סוג השיחה (משפחה / עבודה / חברים / ועד / קניות...) ומה המטרה שלה
• הנושאים שחוזרים
• מי האנשים המרכזיים ומה התפקיד של כל אחד
• איך כותבים (רשמי / סלנג / קיצורים / אימוג׳ים / הודעות קוליות) ומילים או קיצורים מיוחדים ומה הם אומרים
• מה בדרך כלל דורש ממני פעולה בשיחה הזו`,
        },
      ];
      },
    });
    const text = sanitize(raw);
    if (!text) return null;
    await db.setGroupProfile(chat.chat_id, text);
    return text;
  }

  // ---------- 2. daily questions ----------
  async function generateDailyQuestions({ force = false } = {}) {
    const today = events.israelParts().date;
    if (!force && (await db.getSetting('last_questions_date')) === today) return db.listQuestions({ status: 'open' });

    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const active = (await db.getActiveChatsSince(since, 3))
      .filter((c) => !c.is_unknown && !skipChat(c))
      .slice(0, 5);
    if (!active.length) { await db.setSetting('last_questions_date', today); return []; }

    const asked = (await db.listQuestions({ status: null, limit: 60 })).map((q) => `- ${q.question}`).join('\n');
    const perChatRows = [];
    for (const c of active) {
      const rows = (await db.getMessagesSince(c.chat_id, since, 200)).slice(-150);
      if (rows.length) perChatRows.push({ c, rows, ctx: clip(await contextFor(c, { includeProfiles: false }), 300) });
    }
    if (!perChatRows.length) return [];
    const makeBlocks = (ctxTokens) => {
      const perChat = budget ? Math.floor((budget.historyBudget({ answerTokens: 700, fixedText: asked, context: ctxTokens }) - 600) / perChatRows.length) : 1e9;
      return perChatRows.map(({ c, rows, ctx }) => {
        const fit = budget ? budget.fitNewest(rows, (r) => `${r.sender_name}: ${clip(r.content, 200)}`, perChat - 150) : rows;
        return `=== שיחה: "${c.name || c.chat_id}" ===${ctx}\n${fit.map((r) => `${r.from_me ? 'אני' : r.sender_name}: ${clip(r.content, 200)}`).join('\n')}`;
      });
    };

    const raw = await gen({
      task: 'daily questions',
      sensitive: active.some((c) => !c.is_group),
      localOnly: active.some((c) => c.local_only),
      maxTokens: 700,
      temperature: 0.3,
      build: (ctxTokens) => [
        { role: 'system', content: 'אתה עוזר אישי שלומד להכיר את האנשים והקבוצות של המשתמש. כותב בעברית, JSON תקין בלבד.' },
        {
          role: 'user',
          content: `אלה ההודעות של היום מהשיחות של המשתמש ("אני" = המשתמש):

${makeBlocks(ctxTokens).join('\n\n')}

נסח עד ${QUESTIONS_PER_DAY} שאלות קצרות למשתמש, שהתשובות עליהן יעזרו לך להבין טוב יותר את הקונטקסט בפעם הבאה:
מי זה אדם מסוים ומה הקשר שלו למשתמש, מה פירוש מילה/קיצור/כינוי, האם משהו שנאמר דורש ממנו פעולה, מה האופי של קבוצה, איך מישהו מתבטא (צוחק? רציני?).
שאלות ספציפיות לדברים שבאמת עלו היום, שאפשר לענות עליהן במשפט אחד. אל תשאל על דברים שכבר ידועים לך.
אל תחזור על שאלות שכבר נשאלו:
${asked || '(אין)'}

החזר JSON בלבד:
{"questions":[{"chat":"שם השיחה בדיוק כמו למעלה","about":"person|group|word|action","subject":"על מי / על מה (שם קצר)","question":"השאלה"}]}`,
        },
      ],
    });
    const parsed = events.parseJsonLoose(raw || '');
    const list = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const created = [];
    const norm = (t) => String(t || '').replace(/[^\p{L}\p{N}]/gu, '');
    const seen = new Set((await db.listQuestions({ status: null, limit: 300 })).map((x) => norm(x.question)));
    for (const q of list.slice(0, QUESTIONS_PER_DAY)) {
      const question = String(q?.question || '').trim();
      if (question.length < 6 || seen.has(norm(question))) continue; // never ask the same thing twice
      seen.add(norm(question));
      const chatName = String(q.chat || '').replace(/["״]/g, '').trim();
      let chat = active.find((c) => (c.name || c.chat_id) === chatName) || active.find((c) => chatName && String(c.name || '').includes(chatName));
      if (!chat && chatName.length > 2) chat = await db.findAnyChatByName(chatName);
      if (chat && skipChat(chat)) continue;
      const about = ['person', 'group', 'word', 'action'].includes(q.about) ? q.about : 'group';
      const who = about === 'person' && q.subject ? (await peopleNamedIn(String(q.subject)))[0] : null;
      const id = await db.addQuestion({
        day: today,
        chat_id: chat?.chat_id || null,
        chat_name: chat?.name || null,
        about,
        person_id: who?.id || null,
        subject: clip(String(q.subject || '').trim(), 60) || null,
        question: clip(question, 300),
      });
      if (id) created.push(id);
    }
    await db.setSetting('last_questions_date', today);
    log(`Daily questions: ${created.length} new`);
    return db.listQuestions({ status: 'open' });
  }

  async function answerQuestion(id, answer) {
    const text = String(answer || '').trim();
    if (!text) throw new Error('אין תשובה');
    await db.updateQuestion(id, { answer: clip(text, 600), status: 'answered', answered_at: Math.floor(Date.now() / 1000) });
    return db.getQuestion(id);
  }

  // A fact the owner adds by hand ("דני = האח של רותי", "קבוצת X היא העבודה").
  async function addFact({ chat_id = null, chat_name = null, subject = null, text, person_id = null }) {
    const t = String(text || '').trim();
    if (!t) throw new Error('אין טקסט');
    const id = await db.addQuestion({
      day: events.israelParts().date, chat_id, chat_name, about: 'fact', subject: clip(subject || '', 60) || null, question: null, person_id,
    });
    await db.updateQuestion(id, { answer: clip(t, 600), status: 'answered', answered_at: Math.floor(Date.now() / 1000) });
    return db.getQuestion(id);
  }

  // ---------- schedulers ----------
  // Evening: questions (after the digest hour, once a day). Telegram gets them too, when configured.
  function startQuestionScheduler({ notify } = {}) {
    let lastTry = 0;
    setInterval(async () => {
      try {
        const now = events.israelParts();
        if (now.hour < QUESTIONS_HOUR) return;
        if ((await db.getSetting('last_questions_date')) === now.date) return;
        if (Date.now() - lastTry < 30 * 60 * 1000) return; // model was down - try again in 30 min
        lastTry = Date.now();
        const open = await generateDailyQuestions();
        if (open.length && notify) await notify(open);
      } catch (err) {
        logError('Daily questions failed:', err.message);
      }
    }, 60 * 1000);
  }

  return { contextFor, generalContext, peopleNamedIn, registerPeople, learnPerson, learnPeople, rememberAboutPerson, learnGroup, generateDailyQuestions, answerQuestion, addFact, startQuestionScheduler, QUESTIONS_HOUR };
}

module.exports = { createMemory };
