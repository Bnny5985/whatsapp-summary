// The bot always runs on Israel time (Asia/Jerusalem), whatever the computer's own time zone is.
process.env.TZ = 'Asia/Jerusalem';
const { dataPath } = require('./paths');
require('dotenv').config({ path: dataPath('.env'), quiet: true });
// Built-in local AI (llama.cpp): when chosen in the settings, point the engine at its servers before anything reads the settings.
const localaiMod = require('./localai');
const LOCAL_AI_DIR = dataPath('ai');
const localAiEnv = localaiMod.applyEnv(process.env, LOCAL_AI_DIR);
const fs = require('fs');
const path = require('path');
// WhatsApp runs on the read-only Baileys layer in ./wa (no browser). decryptMedia is set once it is connected.
let decryptMedia = null;
const OpenAI = require('openai');
const { toFile } = require('openai');
const db = require('./db');

const tg = require('./telegram');
const events = require('./events');
const links = require('./links');
const calendar = require('./calendar');
const feeding = require('./feeding');
const care = require('./care');
// Chats linked to a care tracker (kept fresh by careStatusAll), so other parts can skip them synchronously.
const careChatIds = new Set();
const budget = require('./budget');

const LM_STUDIO_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';
const LLM_MODEL = process.env.LLM_MODEL || 'local-model';
const VISION_MODEL = process.env.VISION_MODEL || LLM_MODEL;
const HISTORY_LIMIT = 50;
const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 20);
const PROFILE_LEARN_HOUR = Number(process.env.PROFILE_LEARN_HOUR ?? 3);
const EVENT_MIN_CONFIDENCE = Number(process.env.EVENT_MIN_CONFIDENCE ?? 0.5);

// Any OpenAI-compatible server works: LM Studio (default) or a cloud API such as NVIDIA
// (LLM_BASE_URL=https://integrate.api.nvidia.com/v1 + LLM_API_KEY=nvapi-...).
const LLM_BASE_URL = process.env.LLM_BASE_URL || LM_STUDIO_URL;
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || LLM_MODEL;

// Some local models (chat-template mismatches are common) don't reliably stop after answering and
// drift into fabricated "next turn" dialogue. These sequences cut generation off before that happens,
// but the model doesn't always use the exact same marker spelling/formatting (e.g. "Human:" vs
// "[Human]:"), so DRIFT_MARKER_RE below is a second, format-agnostic net applied after the fact.
const STOP_SEQUENCES = [
  '\nInstruct:', '\nInstruction:', '\nHuman:', '\nUser:', '\nAI:', '\n###',
  '\n[Instruct]', '\n[Instruction]', '\n[Human]', '\n[User]', '\n[AI]',
];
const DRIFT_MARKER_RE = /\n\s*\[?(?:Human|User|Instruct(?:ion)?|AI|Assistant)\]?\s*:/i;

// Cuts generated text off at the first sign of the model drifting into a fabricated "next turn" of
// dialogue (see STOP_SEQUENCES above) — a backstop for whatever marker spelling slipped past `stop`.
function sanitizeModelOutput(text) {
  if (!text) return text;
  const match = text.match(DRIFT_MARKER_RE);
  return (match ? text.slice(0, match.index) : text).trim();
}

const openai = new OpenAI({
  baseURL: LLM_BASE_URL,
  apiKey: process.env.LLM_API_KEY || 'lm-studio', // LM Studio ignores the key but the SDK requires one
});

// Shortening text can cut an emoji in half (a "lone surrogate"), and LM Studio then rejects the whole
// request as invalid JSON. Every text sent to any model is made well-formed first.
const wellFormed = (t) => (typeof t === 'string' ? (t.toWellFormed ? t.toWellFormed() : t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')) : t);
function cleanRequest(req) {
  if (!req || !Array.isArray(req.messages)) return req;
  // Qwen3 is a reasoning model: with max_tokens set, its hidden thinking can eat the whole budget and the
  // answer comes back empty (finish_reason "length"). LM Studio turns thinking off with reasoning_effort "none".
  const noThink = /qwen3/i.test(req.model || '') && req.reasoning_effort === undefined ? { reasoning_effort: 'none' } : {};
  return {
    ...req,
    ...noThink,
    messages: req.messages.map((m) => ({
      ...m,
      content: Array.isArray(m.content) ? m.content.map((c) => (c.type === 'text' ? { ...c, text: wellFormed(c.text) } : c)) : wellFormed(m.content),
    })),
  };
}
// True when the "local" model really runs on this computer (built-in engine, LM Studio, Ollama...).
const MAIN_IS_LOCAL = (() => { try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(LLM_BASE_URL).hostname); } catch { return false; } })();
{
  const create = openai.chat.completions.create.bind(openai.chat.completions);
  openai.chat.completions.create = (req, ...rest) => {
    // Privacy mode "local only" is a promise: when the main model is a cloud service, nothing goes to it.
    // "Manual": background work (events, pictures, links) does not go to a cloud main model; what the user asked for now may.
    const { _interactive, ...clean } = req || {};
    if (!MAIN_IS_LOCAL && process.env.PRIVACY_MODE === 'local') return Promise.reject(new Error('מצב פרטיות "מקומי בלבד": אין מודל מקומי, אז שום טקסט לא נשלח לענן'));
    if (!MAIN_IS_LOCAL && process.env.PRIVACY_MODE === 'manual' && !_interactive) return Promise.reject(new Error('מצב פרטיות "ידני": עבודה ברקע לא נשלחת לענן'));
    return create(cleanRequest(clean), ...rest);
  };
}

// Log timestamps in Israel time, e.g. 2026-09-27 21:05:13
function israelStamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date());
}

// Everything printed is also kept in logs\bot-YYYY-MM-DD.log (last 7 days) - for remote troubleshooting.
const LOG_DIR = dataPath('logs');
let logDay = '';
let logStream = null;
function writeLog(line) {
  try {
    const day = israelStamp().slice(0, 10);
    if (day !== logDay) {
      logDay = day;
      if (logStream) logStream.end();
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, `bot-${day}.log`), { flags: 'a' });
      logStream.on('error', () => { logStream = null; });
      for (const f of fs.readdirSync(LOG_DIR)) {          // keep a week
        const m = f.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/);
        if (m && Date.now() - Date.parse(m[1]) > 8 * 86400e3) fs.unlink(path.join(LOG_DIR, f), () => {});
      }
    }
    if (logStream) logStream.write(line + '\n');
  } catch { /* logging must never break the bot */ }
}
const fmtArg = (a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a));

function log(...args) {
  console.log(israelStamp(), '-', ...args);
  writeLog(`${israelStamp()} - ${args.map(fmtArg).join(' ')}`);
}

function logError(...args) {
  console.error(israelStamp(), '- ERROR -', ...args);
  writeLog(`${israelStamp()} - ERROR - ${args.map(fmtArg).join(' ')}`);
}

function getSenderInfo(message) {
  const sender_id = message.sender?.id || message.author || message.from;
  const sender_name =
    message.sender?.pushname || message.sender?.formattedName || message.sender?.name || sender_id;
  return { sender_id, sender_name };
}

// ---------- media, voice and link helpers ----------

const MEDIA_DIR = dataPath('media');
const TRANSCRIBE_URL = (process.env.TRANSCRIBE_URL || '').trim();
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'whisper-1';
const transcriber = TRANSCRIBE_URL
  ? new OpenAI({ baseURL: TRANSCRIBE_URL, apiKey: process.env.TRANSCRIBE_API_KEY || 'local' })
  : null;

// Local Hebrew speech-to-text (voice-server.py, installed by scriptsinstall-voice.ps1): the bot starts it if it
// isn't running, and transcribes voice messages that were saved before it was available.
const VOICE_DIR = path.join(__dirname, 'voice');
function voiceHealthy() {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(TRANSCRIBE_URL); } catch { return resolve(false); }
    const req = require('http').get({ host: u.hostname, port: u.port || 80, path: '/health', timeout: 2500 }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(Boolean(JSON.parse(b).ok)); } catch { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
let voiceStartedAt = 0;
async function ensureVoiceServer() {
  if (!TRANSCRIBE_URL || !/127\.0\.0\.1|localhost/.test(TRANSCRIBE_URL)) return;
  const py = [path.join(VOICE_DIR, 'venv', 'Scripts', 'pythonw.exe'), path.join(VOICE_DIR, 'venv', 'Scripts', 'python.exe'), path.join(VOICE_DIR, 'venv', 'bin', 'python')].find((p) => fs.existsSync(p));
  if (!py || (await voiceHealthy())) return;
  if (Date.now() - voiceStartedAt < 10 * 60 * 1000) return; // it may still be loading the model
  voiceStartedAt = Date.now();
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const out = fs.openSync(path.join(LOG_DIR, 'voice.log'), 'a');
    require('child_process').spawn(py, [path.join(__dirname, 'voice-server.py')], { cwd: __dirname, detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
    log('Started the local voice-transcription server (the model loads in the background).');
  } catch (err) {
    logError('Could not start the voice server:', err.message);
  }
}
async function transcribePending() {
  if (!transcriber || !(await voiceHealthy())) return;
  const rows = await db.listUntranscribedVoices(Math.floor(Date.now() / 1000) - 7 * 86400, 30);
  let done = 0;
  for (const r of rows) {
    const file = path.join(MEDIA_DIR, r.media_path);
    if (!fs.existsSync(file)) continue;
    try {
      const text = await transcribeAudio(fs.readFileSync(file), 'audio/ogg');
      if (!text) continue;
      await db.updateMessageContent(r.id, `🎙️ ${text}`);
      done += 1;
      scheduleEventExtraction({ message_id: r.id, chat_id: r.chat_id, chat_name: r.chat_name, sender_name: r.sender_name, content: `🎙️ ${text}`, timestamp: r.timestamp });
    } catch (err) {
      logError('Transcribing an older voice message failed:', err.message);
      break;
    }
  }
  if (done) log(`Transcribed ${done} older voice message(s).`);
}

// What the bot reads in a chat: a comma list of text,voice,images,links (empty = not listening).
// Older single-value modes are still understood.
const LEGACY_MODES = {
  off: '', text_voice: 'text,voice', text_images_voice: 'text,voice,images', all: 'text,voice,images,links',
};
function parseListenFlags(mode) {
  const raw = mode in LEGACY_MODES ? LEGACY_MODES[mode] : String(mode || '');
  const set = new Set(raw.split(',').map((x) => x.trim()).filter(Boolean));
  return { text: set.has('text'), voice: set.has('voice'), images: set.has('images'), links: set.has('links'), any: set.size > 0 };
}

function safeName(s) {
  return String(s || 'x').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

function mediaToBuffer(media) {
  if (!media) return null;
  if (Buffer.isBuffer(media)) return media;
  return Buffer.from(String(media).split(',').pop(), 'base64');
}

function saveMediaFile(chat_id, message_id, buffer, ext) {
  try {
    const dir = path.join(MEDIA_DIR, safeName(chat_id));
    fs.mkdirSync(dir, { recursive: true });
    const file = `${safeName(message_id)}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buffer);
    return `${safeName(chat_id)}/${file}`;
  } catch (err) {
    logError('Could not save media file:', err.message);
    return null;
  }
}

async function transcribeAudio(buffer, mimetype) {
  if (!transcriber) return null;
  // Voice notes go to a cloud transcriber only in the "combined" privacy mode.
  if (!/127\.0\.0\.1|localhost/.test(TRANSCRIBE_URL) && ['local', 'manual'].includes(process.env.PRIVACY_MODE)) return null;
  const ext = /mpeg|mp3/.test(mimetype || '') ? 'mp3' : /mp4|m4a|aac/.test(mimetype || '') ? 'm4a' : 'ogg';
  const file = await toFile(buffer, `voice.${ext}`, { type: mimetype || 'audio/ogg' });
  const res = await transcriber.audio.transcriptions.create({ file, model: TRANSCRIBE_MODEL, language: 'he' });
  return (res?.text || '').trim() || null;
}

async function handleIncomingMessage(client, message, { catchUp = false } = {}) {
  try {
    const chat_id = message.chatId || message.from;
    if (!chat_id || chat_id === 'status@broadcast') return;
    const from_me = Boolean(message.fromMe);
    let { sender_id, sender_name } = getSenderInfo(message);
    if (from_me) sender_name = 'אני';
    const timestamp = message.timestamp || Math.floor(Date.now() / 1000);
    const chat_name =
      message.chat?.name || message.chat?.formattedTitle || message.chat?.contact?.name ||
      message.chat?.contact?.formattedName || (from_me ? null : sender_name);
    const is_group = Boolean(message.isGroupMsg);
    // Private chat with a number that isn't saved in your phone -> listened to automatically.
    const contact = from_me ? message.chat?.contact : message.sender;
    const is_unknown = !is_group && contact && typeof contact.isMyContact === 'boolean' ? !contact.isMyContact : null;
    await db
      .upsertChat({ chat_id, name: chat_name, is_group, last_message_at: timestamp, is_unknown })
      .catch((err) => logError('upsertChat failed:', err.message));

    const chatRow = await db.getChat(chat_id).catch(() => null);
    const mode = parseListenFlags(chatRow?.listen_mode);
    if (!mode.any) return; // chat is set to "don't listen"
    // A chat marked local-only never reaches the main model when that model is a cloud service.
    const aiOk = MAIN_IS_LOCAL || !chatRow?.local_only;

    const base = { id: message.id, chat_id, sender_name, sender_id, timestamp, from_me };
    if (message.type === 'revoked') {
      for (const l of await db.careLogByMessage(message.id).catch(() => [])) await db.deleteCareLog(l.id);
      return;
    }
    const caption = (message.caption || '').trim();

    if (message.type === 'chat' || message.type === 'text') {
      const content = message.body || '';
      if (!mode.text) return;

      await db.saveMessage({ ...base, content, type: 'text' });
      log(`Saved text message from ${sender_name} in ${chat_id}`);
      // A chat linked to a care tracker (e.g. the baby's meals group): its messages are records, not events or tasks.
      if (await processCareMessage({ id: message.id, chat_id, content, timestamp, sender_name, from_me }).catch((e) => { logError('Care parse failed:', e.message); return false; })) return;
      if (chatRow?.event_prefix) scheduleWorkAnalysis(chatRow);
      aiOk && scheduleEventExtraction({ message_id: message.id, chat_id, chat_name, sender_name, content, timestamp });
      if (mode.links) aiOk && scheduleLinkReading({ message_id: message.id, content });
    } else if (message.type === 'image') {
      if (!mode.images) {
        if (caption) await db.saveMessage({ ...base, content: `[תמונה] ${caption}`, type: 'text' });
        return;
      }
      let description = '[לא ניתן היה לפענח את התמונה]';
      let media_path = null;
      let image_kind = null;
      try {
        const buffer = mediaToBuffer(await decryptMedia(message));
        if (buffer) {
          const mimetype = message.mimetype || 'image/jpeg';
          const analysis = aiOk ? await analyzeImage(buffer.toString('base64'), mimetype) : { description: '[תמונה]', kind: 'other' };
          description = analysis.description;
          image_kind = analysis.kind;
          // Ads come from groups. A photo in a private chat or one I sent is never thrown away as an "ad".
          if (image_kind === 'ad' && (!is_group || from_me)) image_kind = 'other';
          // Ads are not kept on disk (and don't reach the gallery or the event finder).
          if (image_kind !== 'ad') media_path = saveMediaFile(chat_id, message.id, buffer, /png/.test(mimetype) ? 'png' : 'jpg');
        } else {
          logError('decryptMedia returned empty result for message', message.id);
        }
      } catch (mediaErr) {
        logError('Failed to decrypt/process image media:', mediaErr.message);
      }
      const content = image_kind === 'ad'
        ? `[פרסומת] ${caption ? `${caption} - ` : ''}${description.slice(0, 150)}`
        : caption ? `${caption}\n[תיאור התמונה: ${description}]` : description;

      await db.saveMessage({ ...base, content, type: 'image', media_path, image_kind });
      log(`Saved image (${image_kind || 'unknown'}) from ${sender_name} in ${chat_id}`);
      if (image_kind !== 'ad' && (!description.startsWith('[') || caption)) {
        aiOk && scheduleEventExtraction({ message_id: message.id, chat_id, chat_name, sender_name, content, timestamp });
      }
      if (mode.links && caption) aiOk && scheduleLinkReading({ message_id: message.id, content });
    } else if (message.type === 'ptt' || message.type === 'audio') {
      if (!mode.voice) return;
      let content = '🎙️ [הקלטה קולית - לא תומללה]';
      let media_path = null;
      try {
        const buffer = mediaToBuffer(await decryptMedia(message));
        if (buffer) {
          media_path = saveMediaFile(chat_id, message.id, buffer, 'ogg');
          if (transcriber) {
            const text = aiOk ? await transcribeAudio(buffer, message.mimetype) : null;
            if (text) content = `🎙️ ${text}`;
          } else {
            content = '🎙️ [הקלטה קולית - תמלול לא מוגדר (TRANSCRIBE_URL)]';
          }
        }
      } catch (err) {
        logError('Voice message processing failed:', err.message);
      }
      await db.saveMessage({ ...base, content, type: 'voice', media_path });
      log(`Saved voice message from ${sender_name} in ${chat_id}`);
      if (!content.includes('[')) {
        aiOk && scheduleEventExtraction({ message_id: message.id, chat_id, chat_name, sender_name, content, timestamp });
      }
    } else if (caption) {
      // video / document / other media: keep the caption text only (files are not opened)
      await db.saveMessage({ ...base, content: `[${message.type}] ${caption}`, type: 'text' });
      aiOk && scheduleEventExtraction({ message_id: message.id, chat_id, chat_name, sender_name, content: caption, timestamp });
      if (mode.links) aiOk && scheduleLinkReading({ message_id: message.id, content: caption });
    }
  } catch (err) {
    logError('Failed to handle incoming message:', err.message);
  }
}

// Reads links (text only, on the server - never opened in a browser) and appends a one-line
// explanation of each to the stored message, so summaries understand what was shared.
function scheduleLinkReading({ message_id, content }) {
  const urls = links.extractUrls(content, 3);
  if (!urls.length) return;
  extractionQueue = extractionQueue
    .then(async () => {
      const notes = [];
      for (const url of urls) {
        try {
          const page = await links.readLink(url);
          const agent = router.forJob('links'); // a simple job: the small agent model when there is one
          const response = await (agent?.client || openai).chat.completions.create({
            model: agent?.model || EXTRACT_MODEL,
            messages: [
              { role: 'system', content: 'אתה מסביר בקצרה בעברית מה יש בדף אינטרנט, במשפט אחד או שניים, בלי להמציא.' },
              {
                role: 'user',
                content: `כתובת: ${page.url}\nכותרת: ${page.title || '-'}\nתיאור: ${page.description || '-'}\nטקסט מהדף:\n${page.text.slice(0, 2500)}\n\nמה הקישור הזה? (1-2 משפטים)`,
              },
            ],
            max_tokens: 150,
            stop: STOP_SEQUENCES,
          });
          const gist = sanitizeModelOutput(response.choices?.[0]?.message?.content) || page.title || '';
          notes.push(`🔗 ${url} — ${gist}`);
        } catch (err) {
          notes.push(`🔗 ${url} — [לא נקרא: ${err.message}]`);
        }
      }
      const msg = await db.getMessageById(message_id);
      if (msg && notes.length) await db.updateMessageContent(message_id, `${msg.content}\n${notes.join('\n')}`);
      log(`Read ${urls.length} link(s) for message ${message_id}`);
    })
    .catch((err) => logError('Link reading failed:', err.message));
}

function formatHistoryForPrompt(rows) {
  return rows
    .map((row) => {
      const date = new Date((row.timestamp || 0) * 1000).toLocaleString('he-IL', { timeZone: events.TZ });
      return `[${date}] ${row.sender_name}: ${row.content}`;
    })
    .join('\n');
}

function start(client) {
  log('WhatsApp client ready. Listening for messages...');
  waClient = client;
  startWatchdog(client);
  setTimeout(startupSync, 10 * 1000);
  setInterval(() => syncAllChats().catch((e) => logError('Chat sync failed:', e.message)), 30 * 60 * 1000);
  // Safety net: every 10 minutes check for anything that slipped by (e.g. short disconnects).
  setInterval(() => catchUpMissed('periodic'), 10 * 60 * 1000);
  // Every hour: summarize ended 6-hour blocks of the dashboard chats ahead of time.
  const prefillBlocks = () => db.getSelectedChats()
    .then((cs) => blocks.prefill(cs.filter((c) => parseListenFlags(c.listen_mode).text)))
    .catch((err) => logError('Block prefill failed:', err.message));
  setTimeout(prefillBlocks, 5 * 60 * 1000);
  setInterval(prefillBlocks, 60 * 60 * 1000);

  // onAnyMessage also delivers your own messages, so the bot knows what you already answered.
  client.onAnyMessage(async (message) => {
    await handleIncomingMessage(client, message);
  });

  startTelegram();
  startDigestScheduler();
  startProfileLearningScheduler();
  memory.startQuestionScheduler({ notify: sendQuestionsToTelegram });
  setTimeout(() => memory.registerPeople().catch((err) => logError('registerPeople failed:', err.message)), 5 * 1000);
  setInterval(() => memory.registerPeople().catch((err) => logError('registerPeople failed:', err.message)), 3 * 3600 * 1000);
  ensureVoiceServer();
  setInterval(() => ensureVoiceServer().catch(() => {}), 10 * 60 * 1000);
  setTimeout(() => transcribePending().catch((err) => logError('transcribePending:', err.message)), Number(process.env.VOICE_PENDING_DELAY_SEC || 180) * 1000);
  setInterval(() => transcribePending().catch(() => {}), 30 * 60 * 1000);
  if (llm.hasCloud) setTimeout(() => llm.selfTest(dataPath('logs', 'cloud-status.json')).catch(() => {}), 3000);
  notifyOwner('✅ בוט הוואטסאפ מחובר ומאזין להודעות.');

  client.onStateChanged((state) => {
    log('Connection state changed:', state);
    if (state === 'CONNECTED') setTimeout(() => catchUpMissed('reconnected'), 15 * 1000);
    if (state !== 'CONNECTED') {
      notifyOwner(`⚠️ מצב החיבור לוואטסאפ השתנה: ${state}. ייתכן שצריך לבדוק את המחשב / לסרוק QR מחדש.`);
    }
    if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
      client.forceRefocus();
    }
  });

  client.onIncomingCall(async (call) => {
    log('Incoming call ignored from', call.peerJid);
  });
}

// =====================================================================
// Memory: group character, daily questions, facts the owner taught (memory.js)
// =====================================================================
// Small model sorts, big model thinks (router.js). FAST_MODEL empty = big model only, as before.
const router = require('./router').createRouter({ openai, log, logError });
const localai = localaiMod.createLocalAI({ dir: LOCAL_AI_DIR, log, logError });
if (localAiEnv.active) log(`Built-in local AI: main model ${localAiEnv.main ? 'set' : 'not chosen yet'}, agent model ${localAiEnv.agent ? 'set' : 'not chosen yet'}`);
localai.startConfigured().catch((e) => logError('Local AI start failed:', e.message));
process.on('exit', () => localai.stopAll());
// macOS/Linux: the desktop shell stops the engine with SIGTERM; exit normally so the local model servers stop too.
if (process.platform !== 'win32') process.once('SIGTERM', () => process.exit(0));
if (router.model) log(`Model routing: small "${router.model}" filters -> big "${LLM_MODEL}" works on what's left`);

const memory = require('./memory').createMemory({
  db, openai, model: LLM_MODEL, events, sanitize: sanitizeModelOutput, stop: STOP_SEQUENCES, log, logError,
  skipChat: (c) => careChatIds.has(c.chat_id), // a tracker's chat (e.g. baby meals) is records, not people to learn about
  budget, ownerId: () => process.env.OWNER_PHONE || '', llmRun: (job) => llmText(job),
  knownAliases: () => (process.env.LOVE_PHONE ? { [String(process.env.LOVE_PHONE).replace(/\D/g, '')]: (process.env.LOVE_CHAT_NAMES || '').split(',').map((x) => x.trim()).filter(Boolean) } : {}),
});

// Hybrid models: heavy occasional jobs try the cloud providers (providers.js), then the local model.
const llm = require('./providers').createLLM({ openai, localModel: LLM_MODEL, localContext: budget.CONTEXT_TOKENS, log, logError, localIsLocal: MAIN_IS_LOCAL, localAllowsPrivate: MAIN_IS_LOCAL || process.env.CLOUD_1_PRIVATE === '1' });
async function llmText(job) {
  const r = await llm.run({ stop: STOP_SEQUENCES, ...job });
  if (r.provider !== 'מקומי') log(`${job.task || 'job'} answered by ${r.provider}`);
  return { text: sanitizeModelOutput(r.text), provider: r.provider };
}
const isPrivateChat = (c) => Boolean(c) && !c.is_group;
// Long chats are read in 6-hour blocks that are summarized once and kept (blocks.js).
const blocks = require('./blocks').createBlocks({ db, budget, llmText, events, isPrivateChat, log, logError });

// =====================================================================
// Shared summarizer
// =====================================================================

async function summarizeRows(rows, { chatName, short = false, chat = null } = {}) {
  rows = await router.filterRows(rows, 'אני מסכם את השיחה: צריך החלטות, בקשות, מועדים, מידע חשוב ודברים שדורשים פעולה.', (r) => `${r.sender_name}: ${r.content}`);
  const known = chat ? await memory.contextFor(chat).catch(() => '') : '';
  const style = short
    ? 'סכם ב-2 עד 3 נקודות קצרות בלבד (שורה אחת לכל נקודה, מתחילה ב-"• "): רק הדברים החשובים באמת - החלטות, בקשות, מועדים ודברים שדורשים פעולה. בלי כותרות ובלי הקדמה. דלג על שיחות חולין. הודעות של "אני" הן של המשתמש עצמו.'
    : 'סכם אותן בעברית, מאורגן לפי נושאים, בצורה ברורה ותמציתית עם כותרות ונקודות. בסוף הוסף "דורש פעולה:" עם דברים שמישהו התבקש לעשות (אם יש).';
  const lineOf = (r) => `[00.00.0000, 00:00] ${r.sender_name}: ${r.content}`;
  const { text } = await llmText({
    task: short ? 'short summary' : 'full summary',
    interactive: !short,
    // Short summaries run all day for every chat -> local. Full ones may use the cloud.
    localOnly: short || Boolean(chat?.local_only),
    privateLocal: Boolean(chat?.local_only),
    sensitive: isPrivateChat(chat),
    maxTokens: 900,
    temperature: 0.3,
    build: (ctx) => {
      const fit = budget.fitNewest(rows, lineOf, budget.historyBudget({ answerTokens: 900, fixedText: known, context: ctx }));
      return [
        { role: 'system', content: 'אתה עוזר שמסכם שיחות וואטסאפ בעברית בצורה מאורגנת ומדויקת.' },
        { role: 'user', content: `להלן ${fit.length} הודעות משיחת וואטסאפ${chatName ? ` "${chatName}"` : ''}. ${style}${known}\n\n${formatHistoryForPrompt(fit)}` },
      ];
    },
  });
  return text || 'לא התקבל סיכום מהמודל.';
}

// Long range / busy chat: never one huge request. Ended 6-hour blocks are summarized once and
// kept; the final summary reads those short block summaries + the messages of the open block.
async function summarizeLong(chat, rows, { since, short, hours }) {
  const known = await memory.contextFor(chat).catch(() => '');
  const { blocks: done, openStart } = await blocks.closedBlocks(chat, since);
  const openRows = rows.filter((r) => r.timestamp >= openStart);
  const style = short
    ? 'כתוב 2 עד 3 נקודות קצרות בלבד (מתחילות ב-"• "): רק הדברים החשובים באמת מכל התקופה - החלטות, בקשות, מועדים ודברים שדורשים פעולה. בלי כותרות.'
    : 'כתוב סיכום מאורגן לפי נושאים עם כותרות ונקודות, לכל התקופה. בסוף "דורש פעולה:" עם מה שמישהו התבקש לעשות.';
  const { text } = await llmText({
    task: short ? 'short summary (blocks)' : 'full summary (blocks)',
    interactive: !short,
    localOnly: short || Boolean(chat.local_only),
    privateLocal: Boolean(chat.local_only),
    sensitive: isPrivateChat(chat),
    maxTokens: 900,
    temperature: 0.3,
    build: (ctx) => {
      const room = budget.historyBudget({ answerTokens: 900, fixedText: known, context: ctx });
      const recent = budget.fitNewest(openRows, blocks.lineOf, Math.floor(room * 0.4));
      const sums = budget.fitNewest(done, (b) => b.content + ' [00.00 00:00 - 00:00]', room - recent.reduce((n, r) => n + budget.estTokens(blocks.lineOf(r)) + 1, 0));
      return [
        { role: 'system', content: 'אתה עוזר שמסכם שיחות וואטסאפ בעברית בצורה מאורגנת ומדויקת.' },
        { role: 'user', content: `שיחת וואטסאפ "${chat.name || ''}" - ${hours} השעות האחרונות (${rows.length} הודעות).${known}

סיכומים של פרקי הזמן (לפי הסדר):
${blocks.blocksText(sums) || '(אין)'}
${recent.length ? `\nההודעות האחרונות (עוד לא סוכמו):\n${recent.map(blocks.lineOf).join('\n')}` : ''}

${style}` },
      ];
    },
  });
  return text || 'לא התקבל סיכום מהמודל.';
}

// Summarize one chat over the last `hours` hours and store the result (used by Telegram, digest and web UI).
// detail: 'short' (2-3 bullets, the default everywhere) or 'full' (organized by topic).
async function summarizeChat(chat, { hours = 24, detail, short, fallbackToRecent = true } = {}) {
  if (!detail) detail = short === false ? 'full' : 'short';
  short = detail !== 'full';
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  let rows = await db.getMessagesSince(chat.chat_id, since, 20000);
  let label = hours === 24 ? '24 השעות האחרונות' : `${hours} השעות האחרונות`;
  if (rows.length < 5 && fallbackToRecent) {
    rows = await db.getRecentMessages(chat.chat_id, HISTORY_LIMIT);
    label = `${rows.length} ההודעות האחרונות`;
  }
  if (!rows.length) return null;
  if (chat.event_prefix) scheduleWorkAnalysis(chat, 1000);
  // Too much for one request -> summary of the saved time-block summaries + the open block.
  const rawTokens = rows.reduce((n, r) => n + budget.estTokens(`${r.sender_name}: ${r.content}`) + 8, 0);
  const content = rawTokens > budget.historyBudget({ answerTokens: 900, fixedText: '', context: budget.CONTEXT_TOKENS }) - 600
    ? await summarizeLong(chat, rows, { since, short, hours })
    : await summarizeRows(rows, { chatName: chat.name, short, chat });
  await db
    .saveSummary({ chat_id: chat.chat_id, hours, message_count: rows.length, content, detail })
    .catch((err) => logError('saveSummary failed:', err.message));
  return { content, label, count: rows.length };
}

// Answer a free-form question grounded in saved message history.
// chat: a row from db.getChatByRowid, or null to search across all chats marked "selected" in the UI.
async function askQuestion(question, { chat = null, hours = 72 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  let rows = [];
  let scopeLabel;

  if (chat) {
    rows = (await db.getMessagesSince(chat.chat_id, since, 600)).map((r) => ({ ...r, chat_name: null }));
    if (rows.length < 5) rows = await db.getRecentMessages(chat.chat_id, HISTORY_LIMIT);
    scopeLabel = chat.name || chat.chat_id;
  } else {
    const selected = await db.getSelectedChats();
    if (!selected.length) {
      return { answer: 'לא נבחרו שיחות. סמן שיחות בסרגל הצד כדי לשאול עליהן שאלות.', scope: null, count: 0 };
    }
    for (const c of selected) {
      const chatRows = await db.getMessagesSince(c.chat_id, since, 200);
      rows.push(...chatRows.map((r) => ({ ...r, chat_name: c.name || c.chat_id, is_group: c.is_group, local_only: c.local_only })));
    }
    rows.sort((a, b) => a.timestamp - b.timestamp);
    if (rows.length > 1500) rows = rows.slice(-1500); // the token budget below picks the relevant ones
    scopeLabel = `${selected.length} שיחות מסומנות`;
  }

  if (!rows.length) {
    return { answer: 'לא נמצאו הודעות רלוונטיות בטווח הזמן שנבחר.', scope: scopeLabel, count: 0 };
  }
  const totalRows = rows.length;
  rows = await router.filterRows(rows, `אני עונה על השאלה: "${question}". צריך רק הודעות שיכולות לעזור לענות עליה.`, (r) => `${r.chat_name ? `[${r.chat_name}] ` : ''}${r.sender_name}: ${r.content}`);

  const lineOf = (r) => {
    const date = new Date((r.timestamp || 0) * 1000).toLocaleString('he-IL', { timeZone: events.TZ });
    const chatTag = r.chat_name ? `[${r.chat_name}] ` : '';
    return `${chatTag}[${date}] ${r.sender_name}: ${r.content}`;
  };
  // People named in the question ("אמא", "דני") -> their messages and chats count more.
  const named = await memory.peopleNamedIn(question).catch(() => []);
  if (LOVE_PHONE && LOVE_NAME_PATTERNS.some((n) => question.includes(n)) && !named.some((p) => p.id === LOVE_PHONE)) {
    named.push({ id: LOVE_PHONE, ids: [LOVE_PHONE], names: LOVE_NAME_PATTERNS });
  }
  const namedIds = new Set(named.flatMap((p) => p.ids));
  const namedWords = named.flatMap((p) => p.names).filter((n) => n && n.length >= 2);
  const wantsList = /רשימ|ציוד|קניות|מה צריך|list/i.test(question);
  const boost = (r) => {
    let b = 0;
    const fromNamed = namedIds.has(String(r.sender_id || '').split('@')[0].replace(/\D/g, ''));
    if (fromNamed) b += r.is_group ? 2 : 8;                       // their own private chat with me counts most
    if (namedWords.some((n) => String(r.chat_name || '').includes(n))) b += 4;
    if (wantsList && (String(r.content || '').match(/\n/g) || []).length >= 3) b += 6; // multi-line = a list
    return b;
  };
  const knownPeek = chat ? '' : await memory.generalContext({ question }).catch(() => '');
  const knownBase = chat ? await memory.contextFor(chat).catch(() => '') : knownPeek;
  // Saved time-block summaries of the same period give the model the bigger picture (no extra model calls).
  const scopeChats = chat ? [chat] : (await db.getSelectedChats()).filter((c) => !c.local_only);
  let periodText = '';
  for (const c of scopeChats) {
    periodText += await blocks.savedText(c, since, Math.floor(Date.now() / 1000), Math.floor(1400 / Math.max(1, scopeChats.length))).then((t) => (t ? `${t}\n` : '')).catch(() => '');
  }
  const known = knownBase + (periodText ? `\n\nסיכומי פרקי זמן מהתקופה (להקשר; פרטים מדויקים - מההודעות עצמן):\n${periodText}` : '');
  const pick = (ctx) => budget.fitRelevant(rows, question, lineOf, budget.historyBudget({ answerTokens: 500, fixedText: known + question, context: ctx }) - 300, { boost });
  // What would be used locally decides where it may go: private chats / "local only" chats stay home.
  const localPick = pick(budget.CONTEXT_TOKENS);
  const chatOf = (r) => (chat ? chat : { is_group: r.is_group, local_only: r.local_only });
  const { text, provider } = await llmText({
    task: 'question',
    interactive: true, // asked by the user right now (privacy mode "manual" allows the cloud only for these)
    localOnly: localPick.some((r) => chatOf(r).local_only),
    privateLocal: localPick.some((r) => chatOf(r).local_only),
    sensitive: localPick.some((r) => isPrivateChat(chatOf(r))),
    maxTokens: 600,
    build: (ctx) => [
      { role: 'system', content: 'אתה עוזר שעונה על שאלות בהתבסס על היסטוריית הודעות וואטסאפ. תשובות קצרות, מדויקות, בעברית.' },
      { role: 'user', content: `להלן היסטוריית הודעות מוואטסאפ (${scopeLabel}):${known}\n\n${pick(ctx).map(lineOf).join('\n')}\n\nענה בעברית על השאלה הבאה בהתבסס אך ורק על ההודעות שלמעלה. אם התשובה לא נמצאת בהודעות, ציין זאת בבירור ואל תמציא מידע.\n\nשאלה: ${question}` },
    ],
  });
  const answer = text || 'לא התקבלה תשובה מהמודל.';
  return { answer, scope: scopeLabel, count: totalRows, provider };
}

// Build a per-person profile of who's active in a chat, grounded in each person's own quoted
// messages (avoids dumping the whole mixed chat log at once, which small local models tend to
// hallucinate over). hours = 0 means "all time".
async function profileChatMembers(chat, { hours = 0, maxMembers = 8 } = {}) {
  const since = hours ? Math.floor(Date.now() / 1000) - hours * 3600 : 0;
  const rangeLabel = hours ? `${hours} השעות האחרונות` : 'כל הזמן';
  const senders = await db.getSenderStats(chat.chat_id, since, maxMembers);
  if (!senders.length) {
    return { chat_name: chat.name || chat.chat_id, range_label: rangeLabel, members: [] };
  }

  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString('he-IL', { timeZone: events.TZ });
  const members = [];
  for (const s of senders) {
    let profile = null;
    if (s.count >= 3) {
      const msgs = await db.getMessagesBySender(chat.chat_id, s.sender_id, since, 40);
      const quotes = msgs.map((m) => `- ${m.content}`).join('\n');
      try {
        const response = await openai.chat.completions.create({
          model: LLM_MODEL,
          messages: [
            {
              role: 'system',
              content: 'אתה עוזר שכותב פרופיל קצר של אדם בהתבסס על הודעות אמיתיות שהוא כתב בקבוצת וואטסאפ. תשובה של 2-3 משפטים בלבד, בעברית, בגוף שלישי, בלי להמציא מידע שלא מופיע בהודעות.',
            },
            {
              role: 'user',
              content: `להלן ${msgs.length} הודעות אמיתיות שכתב/ה "${s.sender_name}" בקבוצה "${chat.name || chat.chat_id}":\n\n${quotes}\n\nכתוב פרופיל קצר: על מה האדם מדבר בדרך כלל, מה הסגנון שלו, ומה אפשר ללמוד עליו מההודעות.`,
            },
          ],
          max_tokens: 200,
          stop: STOP_SEQUENCES,
        });
        profile = sanitizeModelOutput(response.choices?.[0]?.message?.content) || null;
      } catch (err) {
        logError(`Profile generation failed for ${s.sender_name}:`, err.message);
      }
    }
    if (profile) {
      await db
        .upsertPersonProfile({
          chat_id: chat.chat_id,
          sender_id: s.sender_id,
          sender_name: s.sender_name || s.sender_id,
          profile_text: profile,
          message_count: s.count,
          first_seen: s.first_seen,
          last_seen: s.last_seen,
        })
        .catch((err) => logError(`upsertPersonProfile failed for ${s.sender_name}:`, err.message));
    }
    members.push({
      sender_name: s.sender_name || s.sender_id,
      count: s.count,
      first_seen: fmtDate(s.first_seen),
      last_seen: fmtDate(s.last_seen),
      profile,
    });
  }

  return { chat_name: chat.name || chat.chat_id, range_label: rangeLabel, members };
}

// Per-chat chat box with memory: grounds each answer in recent messages, the user's own notes
// about the chat, and previously-learned person profiles, and keeps a running conversation
// history (in chat_qa) so follow-up questions have context instead of starting from scratch.
async function chatWithMemory(chat, question, { hours = 168 } = {}) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  let rows = await db.getMessagesSince(chat.chat_id, since, 1200);
  if (rows.length < 5) rows = await db.getRecentMessages(chat.chat_id, HISTORY_LIMIT);
  const memText = await memory.contextFor(chat).catch(() => '');
  const prior = await db.getChatQa(chat.chat_id, 16);
  const priorTurns = prior.map((t) => ({ role: t.role, content: String(t.content).slice(0, 600) }));
  const lineOf = (r) => `[00.00.0000, 00:00] ${r.sender_name}: ${r.content}`;
  let used = 0;
  const { text } = await llmText({
    task: 'chat box',
    localOnly: Boolean(chat.local_only),
    privateLocal: Boolean(chat.local_only),
    sensitive: isPrivateChat(chat),
    maxTokens: 600,
    build: (ctx) => {
      const fit = budget.fitRelevant(rows, question, lineOf,
        budget.historyBudget({ answerTokens: 600, fixedText: memText + priorTurns.map((t) => t.content).join(' ') + question, context: ctx }));
      used = fit.length;
      return [
        { role: 'system', content: [`אתה עוזר אישי שמכיר את קבוצת הוואטסאפ "${chat.name || chat.chat_id}" ועונה בעברית, בקצרה ובדיוק, בהתבסס על ההודעות, ההערות והפרופילים שסופקו לך. אם אין לך תשובה מהמידע הזה, אמור זאת בבירור ואל תמציא.`, memText.trim()].filter(Boolean).join('\n\n') },
        { role: 'user', content: `להלן ${fit.length} הודעות מהקבוצה:\n\n${fit.length ? formatHistoryForPrompt(fit) : '(אין הודעות שמורות)'}` },
        { role: 'assistant', content: 'קיבלתי, ראיתי את ההודעות. מה תרצה לדעת?' },
        ...priorTurns,
        { role: 'user', content: question },
      ];
    },
  });
  const answer = text || 'לא התקבלה תשובה מהמודל.';

  await db.addChatQa(chat.chat_id, 'user', question).catch((err) => logError('addChatQa (user) failed:', err.message));
  await db.addChatQa(chat.chat_id, 'assistant', answer).catch((err) => logError('addChatQa (assistant) failed:', err.message));

  return { answer, count: used };
}

// =====================================================================
// Partner panel: what the partner wants from me, open tasks, and whether I owe her a reply.
// =====================================================================

const LOVE_NAME_PATTERNS = (process.env.LOVE_CHAT_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean);

const LOVE_PHONE = String(process.env.LOVE_PHONE || '').replace(/\D/g, '');

async function getLoveChat() {
  if (LOVE_PHONE) {
    const byPhone = await db.getChat(`${LOVE_PHONE}@c.us`);
    if (byPhone && (await db.getSetting('love_chat_id')) !== byPhone.chat_id && !(await db.getSetting('love_chat_id'))) {
      await db.setSetting('love_chat_id', byPhone.chat_id);
    }
  }
  const saved = await db.getSetting('love_chat_id');
  if (saved) {
    const chat = await db.getChat(saved);
    if (chat) return ensureListening(chat);
  }
  const found = await db.findChatByNamePattern(LOVE_NAME_PATTERNS);
  if (found) await db.setSetting('love_chat_id', found.chat_id);
  return ensureListening(found);
}

// Her chat must always be read, otherwise the panel has nothing to work with.
async function ensureListening(chat) {
  if (chat && !String(chat.listen_mode || '').trim()) {
    await db.setChatListenMode(chat.rowid, 'text,voice,images');
    chat.listen_mode = 'text,voice,images';
  }
  return chat;
}

// Things I marked as done in her card ("seen and done") disappear and stay hidden for 7 days.
const normLove = (t) => String(t || '').replace(/[^\p{L}\p{N}]/gu, '');
async function loveDoneList() {
  const cut = Math.floor(Date.now() / 1000) - 7 * 86400;
  return JSON.parse((await db.getSetting('love_done')) || '[]').filter((d) => d.at > cut);
}
const isLoveDone = (text, done) => {
  const n = normLove(text);
  return Boolean(n) && done.some((d) => d.n === n || (n.length > 8 && d.n.length > 8 && (d.n.includes(n) || n.includes(d.n))));
};
async function applyLoveDone(result) {
  if (!result || !result.configured) return result;
  const done = await loveDoneList();
  return {
    ...result,
    wants: (result.wants || []).filter((w) => !isLoveDone(w, done)),
    tasks: (result.tasks || []).filter((t) => !isLoveDone(t.text, done)),
    lists: (result.lists || []).filter((l) => !isLoveDone(`רשימה: ${l.title}`, done)),
  };
}
async function markLoveDone(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('מה סומן?');
  const list = await loveDoneList();
  list.push({ n: normLove(t), text: t.slice(0, 200), at: Math.floor(Date.now() / 1000) });
  await db.setSetting('love_done', JSON.stringify(list.slice(-200)));
  return applyLoveDone(JSON.parse((await db.getSetting('love_analysis')) || 'null'));
}

// Her card must never disappear: one analysis at a time, and if it fails the last saved result
// is returned with a small note instead of an error.
let loveRunning = null;
async function analyzeLove(opts = {}) {
  if (!loveRunning) loveRunning = analyzeLoveNow(opts).finally(() => { loveRunning = null; });
  try {
    return await loveRunning;
  } catch (err) {
    logError('Partner analysis failed:', err.message);
    const cached = JSON.parse((await db.getSetting('love_analysis')) || 'null');
    if (cached && cached.configured) return { ...(await applyLoveDone(cached)), stale_error: budget.isContextError(err) ? 'השיחה ארוכה מדי למודל - מוצג המידע האחרון' : 'הבדיקה האחרונה נכשלה - מוצג המידע האחרון' };
    throw err;
  }
}

// Her card is a saved STATE (what she wants, tasks, lists, waiting for a reply) that is updated
// with only the messages that arrived since the last check - so the request to the model stays
// small no matter how long the chat gets, and an open request is never forgotten just because
// it's old. A big backlog (bot was off) is read in parts, oldest first.
const LOVE_V = 4;
const LOVE_KEEP_DAYS = 21;            // an open request nobody mentioned for 3 weeks drops off
// How to speak about the partner (the user picks בן זוג / בת זוג in the settings).
async function partnerWords() {
  const male = (await db.getSetting('partner_gender')) === 'male';
  const name = (await db.getSetting('partner_name')) || '';
  return male
    ? { male, name, title: 'בן הזוג שלי', pron: 'הוא', needs: 'צריך', wants: 'מבקש או רוצה', asked: 'ביקש', wrote: 'כתב', about: 'עליו', to: 'לו', from: 'ממנו' }
    : { male, name, title: 'בת הזוג שלי', pron: 'היא', needs: 'צריכה', wants: 'מבקשת או רוצה', asked: 'ביקשה', wrote: 'כתבה', about: 'עליה', to: 'לה', from: 'ממנה' };
}

async function analyzeLoveNow({ force = false } = {}) {
  const chat = await getLoveChat();
  if (!chat) return { configured: false };
  const w = await partnerWords();
  const nowS = Math.floor(Date.now() / 1000);
  let state = JSON.parse((await db.getSetting('love_analysis')) || 'null');
  // The older card format (v3) becomes the starting state - nothing open is lost.
  if (state && state.v === 3 && state.chat_rowid === chat.rowid) state = { ...state, v: LOVE_V, since: {} };
  if (!state || state.v !== LOVE_V || state.chat_rowid !== chat.rowid) state = null;

  const lastRows = await db.getMessagesSince(chat.chat_id, 0, 1);
  const lastPrivate = lastRows[lastRows.length - 1] || null;
  const newestTs = lastPrivate?.timestamp || 0;
  if (state && !force && state.newest_ts === newestTs) return applyLoveDone(state);

  // Which messages to read: new ones since the last check; first time - the last 72 hours;
  // "check again" with nothing new - the last 40 messages again.
  let fresh;
  if (!state) fresh = await db.getMessagesSince(chat.chat_id, nowS - 72 * 3600, 3000);
  else if (newestTs > state.newest_ts) fresh = await db.getMessagesBetween(chat.chat_id, state.newest_ts + 1, nowS + 60, 3000);
  else fresh = (await db.getRecentMessages(chat.chat_id, 40)) || [];

  const base = {
    v: LOVE_V, configured: true, chat_rowid: chat.rowid, chat_name: chat.name,
    wants: [], tasks: [], lists: [], learned: [], since: {}, needs_reply: false, reply_about: null, suggested_reply: null,
    ...(state || {}),
  };
  if (!fresh.length) {
    const empty = { ...base, newest_ts: newestTs, computed_at: nowS, last_message: null };
    await db.setSetting('love_analysis', JSON.stringify(empty));
    return applyLoveDone(empty);
  }

  const fmt = (r) => {
    const date = new Date(r.timestamp * 1000).toLocaleString('he-IL', { timeZone: events.TZ });
    const text = String(r.content || '').replace(/‏/g, '').trim();
    return `[${date}] ${r.from_me ? 'אני' : w.pron}: ${text.includes('\n') ? `\n${text}\n` : text}`;
  };
  const known = await memory.contextFor(chat).catch(() => '');
  const doneBefore = await loveDoneList();
  const doneText = doneBefore.length
    ? `\n\nדברים שכבר סימנתי שביצעתי (אל תחזיר אותם, אלא אם ${w.pron} ${w.asked} שוב אחרי הסימון):\n${doneBefore.slice(-25).map((d) => `- ${d.text} (סומן ${new Date(d.at * 1000).toLocaleString('he-IL', { timeZone: events.TZ })})`).join('\n')}`
    : '';
  const clean = (x) => String(x || '').replace(/‏/g, '').trim();
  const norm = normLove;

  // Parts that fit even the local model, oldest first (at most 6 per check; the rest next time).
  const fixed = known + doneText + JSON.stringify(base).slice(0, 3000);
  const room = budget.historyBudget({ answerTokens: 1100, fixedText: fixed, context: budget.CONTEXT_TOKENS }) - 900;
  const parts = [];
  let cur = []; let used = 0;
  for (const r of fresh) {
    const t = budget.estTokens(fmt(r)) + 1;
    if (cur.length && used + t > room) { parts.push(cur); cur = []; used = 0; }
    cur.push(r); used += t;
  }
  if (cur.length) parts.push(cur);

  let st = base;
  let parseError;
  for (const part of parts.slice(0, 6)) {
    const before = await db.getMessagesBetween(chat.chat_id, part[0].timestamp - 3 * 86400, part[0].timestamp, 3000).then((x) => x.slice(-8)).catch(() => []);
    const stateNow = { wants: st.wants, tasks: st.tasks.map((t) => ({ text: t.text, due: t.due || null, due_date: t.due_date || null, due_time: t.due_time || null })), lists: st.lists, needs_reply: st.needs_reply, reply_about: st.reply_about };
    const prompt = `אני מנהל רשימה של מה ש${w.title} "${w.name || chat.name}" ${w.needs} ממני, מתוך השיחה הפרטית בינינו. "אני" = אני, "${w.pron}" = ${w.pron}.${known}

המצב הנוכחי (מה שנשאר פתוח עד עכשיו):
${JSON.stringify(stateNow, null, 1)}
${before.length ? `\nכמה הודעות קודמות להקשר (כבר טופלו):\n${before.map(fmt).join('\n')}\n` : ''}
הודעות חדשות:
${part.map(fmt).join('\n')}${doneText}

עדכן את המצב לפי ההודעות החדשות והחזר JSON בלבד, את המצב המלא אחרי העדכון:
{"wants":["מה ${w.pron} ${w.wants} ממני - משפט קצר"],
 "tasks":[{"text":"משימה שאני צריך לבצע","due":"מתי במילים או null","due_date":"YYYY-MM-DD או null","due_time":"HH:MM או null"}],
 "lists":[{"title":"שם הרשימה","items":["פריט","פריט"]}],
 "learned":["רק דבר קבוע וחדש שלמדתי ${w.about} מההודעות החדשות - משפט קצר, רק עובדות שנאמרו"],
 "needs_reply":true/false,"reply_about":"על מה אני צריך לענות ${w.to}, או null","suggested_reply":"הצעה קצרה וחמה לתשובה, או null"}

כללים:
- שמור כל דבר פתוח מהמצב הנוכחי. הסר רק מה שבוצע או בוטל לפי ההודעות (למשל כתבתי "קניתי", ${w.pron} ${w.wrote} "עזוב, לא צריך").
- הוסף בקשות ומשימות חדשות. אל תכפיל דבר שכבר קיים.
- רשימות (פריטים בשורות נפרדות, ציוד, קניות) - העתק את כל הפריטים כפי שנכתבו. רשימה חדשה באותו שם מחליפה את הישנה. אם יש רשימת ציוד/קניות - הוסף גם משימה להכין לפיה.
- needs_reply לפי סוף השיחה: אם ההודעה האחרונה שלי וסגרה את העניין - false.
- אל תמציא דברים שלא נאמרו.`;
    const { text } = await llmText({
      task: 'Partner update',
      localOnly: Boolean(chat.local_only),
      privateLocal: Boolean(chat.local_only),
      sensitive: true,
      maxTokens: 1100,
      build: () => [
        { role: 'system', content: `אתה עוזר אישי שמכיר היטב את ${w.title} ועוזר לי לא לפספס שום דבר ${w.from}. מדויק, בעברית, JSON תקין בלבד.` },
        { role: 'user', content: prompt },
      ],
    });
    const parsed = events.parseJsonLoose(text || '');
    if (!parsed) { parseError = 'המודל לא החזיר תשובה תקינה'; break; }
    const since = { ...(st.since || {}) };
    const stamp = (t) => { const n = norm(t); if (n && !since[n]) since[n] = part[part.length - 1].timestamp; return t; };
    const wants = (Array.isArray(parsed.wants) ? parsed.wants : []).map(clean).filter(Boolean).slice(0, 10).map(stamp);
    const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : [])
      .map((t) => (typeof t === 'string' ? { text: t, due: null } : t)).filter((t) => t && t.text)
      .map((t) => ({ text: clean(t.text), due: t.due && t.due !== 'null' ? clean(t.due) : null, due_date: t.due_date && t.due_date !== 'null' ? t.due_date : null, due_time: t.due_time && t.due_time !== 'null' ? t.due_time : null }))
      .slice(0, 10).map((t) => { stamp(t.text); return t; });
    const lists = (Array.isArray(parsed.lists) ? parsed.lists : [])
      .map((l) => ({ title: clean(l?.title) || 'רשימה', items: (Array.isArray(l?.items) ? l.items : []).map(clean).filter(Boolean).slice(0, 40) }))
      .filter((l) => l.items.length).slice(0, 4);
    lists.forEach((l) => stamp(`רשימה: ${l.title}`));
    const learnedNew = (Array.isArray(parsed.learned) ? parsed.learned : []).map(clean).filter((x) => x.length > 4).slice(0, 6);
    st = {
      ...st, wants, tasks, lists, since,
      learned: [...learnedNew, ...(st.learned || [])].filter((x, i, a) => a.findIndex((y) => norm(y) === norm(x)) === i).slice(0, 8),
      needs_reply: parsed.needs_reply === true || parsed.needs_reply === 'true',
      reply_about: parsed.reply_about && parsed.reply_about !== 'null' ? clean(parsed.reply_about) : null,
      suggested_reply: parsed.suggested_reply && parsed.suggested_reply !== 'null' ? clean(parsed.suggested_reply) : null,
      newest_ts: part[part.length - 1].timestamp,
    };
    if (learnedNew.length) {
      await memory.rememberAboutPerson(LOVE_PHONE || part.find((r) => !r.from_me)?.sender_id, learnedNew, { chat, names: [...LOVE_NAME_PATTERNS, chat.name].filter(Boolean) })
        .catch((err) => logError('Saving what was learned about her failed:', err.message));
    }
  }

  // Old open items nobody mentioned for 3 weeks drop off.
  const tooOld = (t) => (st.since?.[norm(t)] || nowS) < nowS - LOVE_KEEP_DAYS * 86400;
  st.wants = st.wants.filter((w) => !tooOld(w));
  st.tasks = st.tasks.filter((t) => !tooOld(t.text));
  st.lists = st.lists.filter((l) => !tooOld(`רשימה: ${l.title}`));
  const keep = new Set([...st.wants, ...st.tasks.map((t) => t.text), ...st.lists.map((l) => `רשימה: ${l.title}`)].map(norm));
  st.since = Object.fromEntries(Object.entries(st.since || {}).filter(([k]) => keep.has(k)));

  const lastMsg = lastPrivate ? { from_me: Boolean(lastPrivate.from_me), timestamp: lastPrivate.timestamp, text: String(lastPrivate.content).slice(0, 200) } : null;
  const result = {
    ...st,
    // a failed part keeps the old state but still moves on next time only after a good answer
    newest_ts: parseError ? (state?.newest_ts || 0) : (parts.length > 6 ? st.newest_ts : newestTs),
    computed_at: nowS,
    last_message: lastMsg,
    parse_error: parseError,
  };
  await db.setSetting('love_analysis', JSON.stringify(result));
  await suggestTasks(
    events.normalizeTasks({ tasks: result.tasks.map((t) => ({ ...t, confidence: 1 })) }),
    { origin: 'love', chat_id: chat.chat_id, chat_name: chat.name }
  );
  return applyLoveDone(result);
}

async function setLoveChat(rowid) {
  const chat = await db.getChatByRowid(rowid);
  if (!chat) throw new Error('chat not found');
  await db.setSetting('love_chat_id', chat.chat_id);
  await db.setSetting('love_analysis', 'null');
  return chat;
}

// =====================================================================
// Tasks + numbers that aren't saved in your phone
// =====================================================================

function taskKey(scope, text) {
  return `${scope}|${String(text).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40)}`;
}

// Tasks found by the bot go to "suggested" - you add them to your list with one click.
async function suggestTasks(tasks, { origin, chat_id = null, chat_name = null, message_id = null }) {
  for (const t of tasks || []) {
    if (!t?.text) continue;
    await db
      .addTask({ text: t.text, due_at: t.due_at || null, status: 'suggested', origin, chat_id, chat_name, message_id, dedup_key: taskKey(chat_id || origin, t.text) })
      .catch((err) => logError('addTask failed:', err.message));
  }
}

async function analyzeUnknown({ force = false, hours = 168 } = {}) {
  const list = await db.listUnknownChats();
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const people = [];
  let newest = 0;
  for (const c of list) {
    if (people.length >= 10) break; // most recent 10 conversations
    const rows = await db.getMessagesSince(c.chat_id, since, 25);
    if (!rows.length) continue;
    newest = Math.max(newest, rows[rows.length - 1].timestamp);
    people.push({ chat: c, rows });
  }
  const cached = JSON.parse((await db.getSetting('unknown_analysis')) || 'null');
  if (!force && cached && cached.newest_ts === newest && Date.now() / 1000 - cached.computed_at < 6 * 3600) return cached;

  const base = { newest_ts: newest, computed_at: Math.floor(Date.now() / 1000), count: people.length, people: [] };
  if (!people.length) {
    await db.setSetting('unknown_analysis', JSON.stringify(base));
    return base;
  }
  const today = events.israelParts();
  const lineOf = (r) => {
    const date = new Date(r.timestamp * 1000).toLocaleString('he-IL', { timeZone: events.TZ });
    return `[${date}] ${r.from_me ? 'אני' : 'הוא/היא'}: ${String(r.content).slice(0, 400)}`;
  };
  const { text: unkText } = await llmText({
    task: 'unknown numbers',
    sensitive: true,
    maxTokens: 900,
    temperature: 0.1,
    build: (ctx) => {
      const per = Math.floor((budget.historyBudget({ answerTokens: 900, context: ctx }) - 600) / people.length);
      const blocks = people.map((p, i) => `### איש קשר ${i + 1}: ${p.chat.name || p.chat.chat_id}\n${budget.fitNewest(p.rows, lineOf, per).map(lineOf).join('\n')}`);
      return [
        { role: 'system', content: 'אתה עוזר אישי שמסכם פניות ממספרים לא מוכרים. קצר, מדויק, בעברית, JSON תקין בלבד.' },
        { role: 'user', content: `היום ${today.date}. אלה שיחות פרטיות עם מספרים שלא שמורים אצלי בטלפון (${hours / 24} ימים אחרונים). "אני" = אני.

${blocks.join('\n\n')}

לכל איש קשר, החזר JSON בלבד:
{"people":[{"index":1,"who":"מי זה כנראה (לפי מה שכתוב, בלי להמציא) או null","wants":"מה הוא רוצה ממני - משפט אחד","needs_reply":true/false,"tasks":[{"text":"מה אני צריך לעשות","due_date":"YYYY-MM-DD או null","due_time":"HH:MM או null"}]}]}` },
      ];
    },
  });
  const parsed = events.parseJsonLoose(unkText || '');
  const out = [];
  for (const [i, p] of people.entries()) {
    const r = (parsed?.people || []).find((x) => Number(x.index) === i + 1) || {};
    const last = p.rows[p.rows.length - 1];
    const tasks = events.normalizeTasks({ tasks: (r.tasks || []).map((t) => ({ ...t, confidence: 1 })) });
    await suggestTasks(tasks, { origin: 'unknown', chat_id: p.chat.chat_id, chat_name: p.chat.name });
    out.push({
      rowid: p.chat.rowid,
      name: p.chat.name || p.chat.chat_id,
      who: r.who && r.who !== 'null' ? r.who : null,
      wants: r.wants && r.wants !== 'null' ? r.wants : null,
      needs_reply: typeof r.needs_reply === 'boolean' ? r.needs_reply : r.needs_reply === 'true' ? true : r.needs_reply === 'false' ? false : !last.from_me,
      tasks: tasks.map((t) => t.text),
      last_at: last.timestamp,
      count: p.rows.length,
    });
  }
  const result = { ...base, people: out, parse_error: parsed ? undefined : 'המודל לא החזיר תשובה תקינה' };
  await db.setSetting('unknown_analysis', JSON.stringify(result));
  return result;
}

// =====================================================================
// All chats list, history backfill, and work chats (e.g. "שמשון")
// =====================================================================

let waClient = null;
const chatIdOf = (c) => (typeof c.id === 'string' ? c.id : c.id?._serialized) || null;

// Brings every chat/group from WhatsApp into the list (not listened to until you choose),
// so groups without new messages since the bot started still show up.
// Baileys only: re-reads the phone's saved contact names (set in launchBaileys).
let refreshWaContacts = null;
async function syncAllChats({ refreshContacts = false } = {}) {
  if (!waClient) return 0;
  if (refreshWaContacts) {
    // WhatsApp sends the address book once, while linking. Ask again when we have none, or when the user pressed "sync".
    const haveBook = (await db.listContacts().catch(() => [])).some((c) => c.saved);
    if (refreshContacts || !haveBook) {
      await refreshWaContacts()
        .then(() => new Promise((r) => setTimeout(r, 1500))) // names arrive as events and are stored asynchronously
        .then(async () => log(`Contacts refreshed: ${(await db.listContacts()).filter((c) => c.saved).length} saved names known.`))
        .catch((e) => logError('Contacts refresh failed:', e.message));
    }
    await db.nameChatsFromContacts().catch((e) => logError('nameChatsFromContacts failed:', e.message));
  }
  const all = await waClient.getAllChats();
  let n = 0;
  for (const c of all) {
    const chat_id = chatIdOf(c);
    if (!chat_id || chat_id === 'status@broadcast' || chat_id.endsWith('@newsletter') || chat_id.endsWith('@broadcast')) continue;
    const is_group = Boolean(c.isGroup);
    const name = c.name || c.formattedTitle || c.contact?.name || c.contact?.formattedName || null;
    const is_unknown = !is_group && c.contact && typeof c.contact.isMyContact === 'boolean' ? !c.contact.isMyContact : null;
    await db.upsertChat({ chat_id, name, is_group, last_message_at: Number(c.t) || 0, is_unknown }).catch(() => {});
    n += 1;
  }
  log(`Synced ${n} chats from WhatsApp`);
  return n;
}

// Pulls recent history of one chat from WhatsApp (text + captions only) so the bot has context.
async function backfillChat(chat_id, { max = 400 } = {}) {
  if (!waClient) throw new Error('WhatsApp לא מחובר');
  let msgs = await waClient.getAllMessagesInChat(chat_id, true, false).catch(() => []);
  for (let i = 0; i < 3 && msgs.length < max; i++) {
    const before = msgs.length;
    await waClient.loadEarlierMessages(chat_id).catch(() => null);
    msgs = await waClient.getAllMessagesInChat(chat_id, true, false).catch(() => msgs);
    if (msgs.length === before) break;
  }
  msgs = msgs.slice(-max);
  let saved = 0;
  for (const m of msgs) {
    const text = m.type === 'chat' ? m.body : m.caption ? `[${m.type}] ${m.caption}` : null;
    if (!text) continue;
    const from_me = Boolean(m.fromMe);
    const { sender_id, sender_name } = getSenderInfo(m);
    await db
      .saveMessage({ id: m.id, chat_id, sender_name: from_me ? 'אני' : sender_name, sender_id, content: text, type: 'text', timestamp: m.timestamp || m.t, from_me })
      .then((r) => { if (r?.changes) saved += 1; })
      .catch(() => {});
  }
  log(`Backfilled ${saved} message(s) for ${chat_id}`);
  return saved;
}

function withPrefix(prefix, title) {
  if (!prefix) return title;
  const t = String(title || '').trim();
  return t.includes(prefix) ? t : `${prefix} – ${t}`;
}

// Reads the whole recent work conversation and keeps its events up to date:
// later messages override earlier ones (time changes, cancellations), relative dates are
// resolved from each message's own date, and every title carries the chat's prefix.
const workTimers = new Map();
function scheduleWorkAnalysis(chat, delayMs = 90 * 1000) {
  clearTimeout(workTimers.get(chat.chat_id));
  workTimers.set(chat.chat_id, setTimeout(() => {
    workTimers.delete(chat.chat_id);
    extractionQueue = extractionQueue
      .then(() => analyzeWorkChat(chat))
      .catch((err) => logError('Work analysis failed:', err.message));
  }, delayMs));
}

async function analyzeWorkChat(chat, { days = 21 } = {}) {
  const prefix = chat.event_prefix || (await db.getChat(chat.chat_id))?.event_prefix;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = await db.getMessagesSince(chat.chat_id, since, 350);
  if (!rows.length) return { jobs: [], added: 0, updated: 0, cancelled: 0 };
  const today = events.israelParts();
  const lineOf = (r) => {
    const p = events.israelParts(new Date(r.timestamp * 1000));
    return `[${p.date} ${p.time}] ${r.from_me ? 'אני' : r.sender_name}: ${String(r.content).slice(0, 500)}`;
  };
  const known = await memory.contextFor(chat).catch(() => '');
  const { text: workText } = await llmText({
    task: 'work schedule',
    localOnly: Boolean(chat.local_only),
    privateLocal: Boolean(chat.local_only),
    sensitive: isPrivateChat(chat),
    maxTokens: 1200,
    temperature: 0,
    build: (ctx) => {
      const fit = budget.fitNewest(rows, lineOf, budget.historyBudget({ answerTokens: 1200, fixedText: known, context: ctx }) - 500);
      return [
        { role: 'system', content: 'אתה עוזר שמנהל לי את לוח העבודות מתוך שיחת וואטסאפ. מדויק, בעברית, JSON תקין בלבד.' },
        { role: 'user', content: `זו שיחת עבודה שלי ("אני") עם "${chat.name}". היום ${today.date} (שעון ישראל).
כל הודעה מתחילה בתאריך ובשעה שבהם נשלחה - חשב "מחר", "ביום רביעי", "בשבוע הבא" ביחס לתאריך של אותה הודעה.
${known}
${fit.map(lineOf).join('\n')}

הבן מההקשר של כל השיחה אילו עבודות / הפקות / משמרות / פגישות עבודה מתוכננות מהיום והלאה.
הודעה מאוחרת גוברת על מוקדמת (שינוי שעה, מקום, ביטול). אם עבודה בוטלה - status="cancelled". אם לא סגור סופית - "tentative".
אם שעה לא נאמרה במפורש אבל ברורה מההקשר (למשל "כמו אתמול") - השתמש בה. אל תמציא עבודות.

החזר JSON בלבד:
{"jobs":[{"title":"תיאור קצר של העבודה","date":"YYYY-MM-DD","start_time":"HH:MM או null","end_time":"HH:MM או null","location":"מקום או null","notes":"פרטים חשובים (ציוד, איש קשר, כתובת) או null","status":"confirmed|tentative|cancelled"}]}` },
      ];
    },
  });
  const parsed = events.parseJsonLoose(workText || '');
  const jobsRaw = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  const jobs = [];
  for (const j of jobsRaw) {
    const n = events.normalizeEvents({ events: [{ ...j, confidence: 1 }] })[0];
    if (n) jobs.push({ ...n, status: String(j.status || 'confirmed').toLowerCase() });
  }

  const existing = await db.getEventsForChatFrom(chat.chat_id, today.date);
  const used = new Set();
  let added = 0, updated = 0, cancelled = 0;
  const norm = (t) => String(t || '').replace(/[^\p{L}\p{N}]/gu, '');
  for (const job of jobs) {
    const title = withPrefix(prefix, job.title);
    const sameDay = existing.filter((e) => e.date === job.date && !used.has(e.id));
    const match =
      sameDay.find((e) => job.start_time && e.start_time === job.start_time) ||
      sameDay.find((e) => norm(e.title).includes(norm(job.title).slice(0, 8)) || norm(job.title).includes(norm(e.title).replace(norm(prefix), '').slice(0, 8))) ||
      (sameDay.length === 1 ? sameDay[0] : null);
    if (job.status === 'cancelled') {
      if (match && match.status !== 'ignored') { await db.setEventStatus(match.id, 'ignored'); used.add(match.id); cancelled += 1; }
      continue;
    }
    const notes = [job.status === 'tentative' ? '(לא סופי)' : null, job.notes].filter(Boolean).join(' ') || null;
    if (match) {
      used.add(match.id);
      const fields = {};
      if (match.title !== title) fields.title = title;
      if (job.start_time && match.start_time !== job.start_time) fields.start_time = job.start_time;
      if (job.end_time && match.end_time !== job.end_time) fields.end_time = job.end_time;
      if (job.location && match.location !== job.location) fields.location = job.location;
      if (notes && match.notes !== notes) fields.notes = notes;
      if (Object.keys(fields).length) {
        await db.updateEvent(match.id, fields);
        updated += 1;
        if (match.status === 'ignored') await db.setEventStatus(match.id, 'pending');
      }
    } else {
      const saved = await db.insertEvent({
        ...job, title, notes, chat_id: chat.chat_id, chat_name: chat.name, message_id: null,
        source_text: `ניתוח שיחת העבודה עם ${chat.name}`, confidence: 1,
        dedup_key: `work|${chat.chat_id}|${job.date}|${job.start_time || ''}|${norm(job.title).slice(0, 25)}`,
      });
      if (saved) { added += 1; await sendEventCard(saved).catch(() => {}); }
    }
  }
  await db.setSetting(`work_analysis_${chat.chat_id}`, JSON.stringify({ at: Math.floor(Date.now() / 1000), jobs: jobs.length, added, updated, cancelled }));
  log(`Work chat "${chat.name}": ${jobs.length} job(s), +${added} new, ${updated} updated, ${cancelled} cancelled`);
  return { jobs: jobs.length, added, updated, cancelled };
}

// WORK_CHATS="שמשון=שמשון" -> chat whose name contains the left side becomes a work chat with that prefix.
async function applyWorkChatConfig() {
  const spec = process.env.WORK_CHATS || 'שמשון=שמשון';
  for (const pair of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [pattern, prefix] = pair.split('=').map((s) => s.trim());
    const chat = await db.findAnyChatByName(pattern);
    if (!chat) continue;
    if (!chat.event_prefix) await db.setChatEventPrefix(chat.rowid, prefix || pattern);
    if (!String(chat.listen_mode || '').includes('text')) {
      const flags = new Set(String(chat.listen_mode || '').split(',').filter(Boolean));
      flags.add('text');
      await db.setChatListenMode(chat.rowid, [...flags].join(','));
    }
    if (!chat.selected) await db.setChatSelected(chat.rowid, true);
    // Existing events from this chat get the prefix too.
    for (const ev of await db.getEventsForChatFrom(chat.chat_id, '0000-00-00')) {
      const t = withPrefix(prefix || pattern, ev.title);
      if (t !== ev.title) await db.updateEvent(ev.id, { title: t });
    }
  }
}

// Catch-up: messages that arrived while the bot was off / disconnected are read from WhatsApp
// and processed exactly like live ones (summaries, events, tasks, images, voice, links).
let catchUpRunning = false;
async function catchUpMissed(reason = '') {
  if (!waClient || catchUpRunning) return 0;
  catchUpRunning = true;
  let total = 0;
  try {
    for (const chat of await db.listListeningChats()) {
      const lastTs = await db.getLastMessageTs(chat.chat_id);
      if (!lastTs) continue; // never read before -> history backfill handles it
      let msgs = await waClient.getAllMessagesInChat(chat.chat_id, true, false).catch(() => []);
      // If everything WhatsApp has loaded is newer than what we saw, load a bit more history.
      for (let i = 0; i < 3 && msgs.length && Math.min(...msgs.map((m) => m.timestamp || m.t || 0)) > lastTs; i++) {
        await waClient.loadEarlierMessages(chat.chat_id).catch(() => null);
        msgs = await waClient.getAllMessagesInChat(chat.chat_id, true, false).catch(() => msgs);
      }
      const missed = msgs
        .filter((m) => (m.timestamp || m.t || 0) >= lastTs)
        .sort((a, b) => (a.timestamp || a.t) - (b.timestamp || b.t))
        .slice(-150);
      for (const m of missed) {
        if (await db.getMessageById(m.id)) continue;
        await handleIncomingMessage(waClient, m, { catchUp: true });
        if (await db.getMessageById(m.id)) total += 1;
      }
    }
    if (total) log(`Caught up on ${total} missed message(s)${reason ? ` (${reason})` : ''}`);
  } catch (err) {
    logError('Catch-up failed:', err.message);
  } finally {
    catchUpRunning = false;
  }
  return total;
}

async function startupSync() {
  try {
    await syncAllChats();
    await applyWorkChatConfig();
    extractionQueue = extractionQueue.then(classifyExistingImages).catch((e) => logError('Image classify failed:', e.message));
    const missed = await catchUpMissed('startup');
    if (missed) notifyOwner(`🔄 הבוט השלים ${missed} הודעות שהגיעו בזמן שהיה כבוי.`);
    const db2 = await db.listChatsWithStats(0);
    for (const c of db2.filter((x) => x.event_prefix)) {
      if ((await db.countMessages(c.chat_id)) < 50) await backfillChat(c.chat_id).catch((e) => logError('Backfill failed:', e.message));
      scheduleWorkAnalysis(await db.getChatByRowid(c.rowid), 5000);
    }
  } catch (err) {
    logError('Startup sync failed:', err.message);
  }
}

// Name for the tracker made from the old single baby-feeding module (one-time migration below).
const FEED_NAME = process.env.FEED_NAME || 'האכלה';

// =====================================================================
// Care trackers (care.js): baby meals, medicines with a schedule, pets, plants - as many as the user adds.
// =====================================================================

async function careStatusAll() {
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  const trackers = await db.listTrackers();
  careChatIds.clear();
  for (const t of trackers) if (t.chat_id) careChatIds.add(t.chat_id);
  for (const t of trackers) {
    // Medicine courses need their whole course; everything else a week is plenty.
    const starts = t.config.items.map((i) => (i.start ? care.localTs(i.start, '00:00') : now)).concat(now - 8 * 86400);
    const logs = await db.listCareLog(t.id, Math.min(...starts) - 86400);
    out.push(care.trackerStatus(t, logs, now));
  }
  return out;
}

/** Record that something was done. A second report of the same event is merged, never counted twice. */
async function careRecord({ tracker_id, item, at, amount = null, by = null, note = null, source = 'manual', message_id = null }) {
  const t = await db.getTracker(tracker_id);
  if (!t || !t.active) throw new Error('המעקב לא נמצא');
  if (!t.config.items.some((i) => i.id === item)) throw new Error('הפריט לא נמצא במעקב');
  const when = Number(at) || Math.floor(Date.now() / 1000);
  const near = (await db.listCareLog(t.id, when - 7 * 3600)).filter((l) => l.item === item && l.at <= when + 7 * 3600);
  const dup = care.findDuplicate(t.kind, near, when);
  if (dup) { await db.mergeCareLog(dup.id, { amount, by }); return { id: dup.id, merged: true }; }
  return { id: await db.addCareLog({ tracker_id: t.id, item, at: when, amount: amount ? String(amount).slice(0, 20) : null, by: by ? String(by).slice(0, 40) : null, note, source, message_id }), merged: false };
}

// Messages in a chat linked to a feeding tracker: every meal line becomes a record (the baby-feeding parser).
async function processCareMessage({ id, chat_id, content, timestamp, sender_name, from_me }) {
  if (!careChatIds.has(chat_id)) return false;
  const linked = (await db.listTrackers()).filter((t) => t.chat_id === chat_id);
  if (!linked.length) return false;
  const already = await db.careLogByMessage(id);
  if (already.length) return true; // read before (catch-up / replay)
  const entries = feeding.parseFeedLines(content, timestamp).filter((e) => (e.kind || 'feed') === 'feed');
  for (const t of linked) {
    const item = t.config.items[0]?.id;
    if (!item) continue;
    for (let i = 0; i < entries.length; i++) {
      await careRecord({ tracker_id: t.id, item, at: entries[i].fed_at, amount: entries[i].amount || null, by: from_me ? 'אני' : sender_name, source: 'chat', message_id: `${id}#${i}` });
    }
  }
  if (entries.length) log(`Care: ${entries.length} record(s) from a linked chat`);
  return true;
}

// One-time: the old single baby-feeding module becomes a tracker, with its history.
async function migrateFeedingToCare() {
  if ((await db.getSetting('care_migrated')) === '1') return;
  const chatId = await db.getSetting('feed_chat_id');
  if (chatId && !(await db.listTrackers({ all: true })).length) {
    const t = care.normalizeTracker({ kind: 'feeding', name: FEED_NAME, per_day: feeding.CFG.perDay, items: [{ id: 'meal', name: 'ארוחה', every_hours: feeding.CFG.minGapHours }] });
    const id = await db.saveTracker({ ...t, chat_id: chatId });
    for (const f of await db.listFeeds(Math.floor(Date.now() / 1000) - 14 * 86400)) {
      if ((f.kind || 'feed') !== 'feed' || f.deleted) continue;
      await db.addCareLog({ tracker_id: id, item: 'meal', at: f.fed_at, amount: f.amount, source: f.source === 'manual' ? 'manual' : 'chat', message_id: f.message_id });
    }
    log('Care: the baby-feeding log became a tracker');
  }
  await db.setSetting('care_migrated', '1');
}

// Every minute: a dose/meal/watering that just became due is announced once (Telegram, when connected).
const careSent = new Set();
let careSentLoaded = false;
async function careReminderTick() {
  if (!careSentLoaded) { for (const k of JSON.parse((await db.getSetting('care_sent')) || '[]')) careSent.add(k); careSentLoaded = true; }
  const due = care.dueReminders(await careStatusAll(), careSent);
  if (!due.length) return;
  for (const d of due) {
    careSent.add(d.key);
    await notifyOwner(care.reminderText(d)).catch(() => {});
  }
  await db.setSetting('care_sent', JSON.stringify([...careSent].slice(-300)));
}

// ---------- images: people / other / ad ----------

function parseImageAnalysis(raw) {
  const j = events.parseJsonLoose(raw || '');
  if (j && typeof j.description === 'string') {
    const kind = j.ad === true || j.ad === 'true' ? 'ad' : j.people === true || j.people === 'true' ? 'people' : 'other';
    return { description: j.description.trim() || '[ללא תיאור]', kind };
  }
  return { description: sanitizeModelOutput(raw) || '[לא התקבל תיאור מהמודל]', kind: 'other' };
}

async function analyzeImage(base64Data, mimetype) {
  try {
    const response = await openai.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'נתח את התמונה והחזר JSON בלבד:\n{"description":"תיאור קצר בעברית, ואם יש טקסט בתמונה - כתוב אותו (OCR)","people":true/false,"ad":true/false}\npeople = האם רואים בתמונה בני אדם אמיתיים (צילום, לא ציור ולא דמות בפרסומת).\nad = true רק אם זו מודעה שיווקית מעוצבת (פלייר, באנר, מבצע עם מחירים/לוגו/טקסט פרסומי). צילום רגיל שאדם צילם (אוכל, ירקות, מוצרים, בית, ילדים, צילום מסך של שיחה) הוא לא פרסומת - ad=false.' },
          { type: 'image_url', image_url: { url: `data:${mimetype};base64,${base64Data}` } },
        ],
      }],
      max_tokens: 350,
      stop: STOP_SEQUENCES,
    });
    return parseImageAnalysis(response.choices?.[0]?.message?.content);
  } catch (err) {
    logError('Vision API call failed:', err.message);
    return { description: '[שגיאה בזיהוי תמונה - שרת LM Studio לא הגיב]', kind: null };
  }
}

// Sort older images into the gallery (and drop ads from disk) - runs in the background queue.
async function classifyExistingImages() {
  const list = await db.listUnclassifiedImages(100);
  if (!list.length) return;
  log(`Classifying ${list.length} older image(s) for the gallery...`);
  for (const m of list) {
    const file = path.join(MEDIA_DIR, m.media_path);
    if (!fs.existsSync(file)) { await db.setImageKind(m.id, 'other', { dropMedia: true }); continue; }
    const mimetype = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const r = await analyzeImage(fs.readFileSync(file).toString('base64'), mimetype);
    if (!r.kind) break; // model not available - try again next start
    if (r.kind === 'ad') {
      const c = await db.getChat(m.chat_id);
      if (!c?.is_group || m.from_me) r.kind = 'other';
    }
    if (r.kind === 'ad') {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      await db.setImageKind(m.id, 'ad', { dropMedia: true });
    } else {
      await db.setImageKind(m.id, r.kind);
    }
  }
}

// =====================================================================
// Watchdog: if WhatsApp stays disconnected, restart the bot automatically
// =====================================================================

const WATCHDOG_GRACE_MIN = Number(process.env.WATCHDOG_GRACE_MIN || 3);   // disconnected this long -> restart
const WATCHDOG_MAX_RESTARTS = 3;                                           // ...but at most 3 times
const WATCHDOG_WINDOW_MIN = 30;                                            // ...per 30 minutes
const RESTART_LOG = dataPath('restart-log.json');
const NEEDS_QR = ['UNPAIRED', 'UNPAIRED_IDLE'];

let badSince = null;
let lastState = null;
let qrNotified = false;
let restarting = false;
let backoffNotified = false;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function checkWhatsAppHealth(client) {
  let state;
  try {
    state = String(await withTimeout(client.getConnectionState(), 20000));
  } catch (err) {
    state = `NO_RESPONSE (${err.message})`; // browser crashed / page stuck
  }
  lastState = state;
  if (state === 'CONNECTED') {
    if (badSince) log('Watchdog: WhatsApp connection is back.');
    badSince = null;
    qrNotified = false;
    backoffNotified = false;
    return;
  }
  if (NEEDS_QR.includes(state)) {
    // Signed out on the phone - a restart won't help, a QR scan is needed.
    if (!qrNotified) {
      qrNotified = true;
      logError('Watchdog: WhatsApp is signed out - scan the QR code in the bot window.');
      notifyOwner('⚠️ הוואטסאפ של הבוט התנתק מהחשבון. צריך לסרוק מחדש את קוד ה-QR בחלון הבוט במחשב.');
    }
    return;
  }
  if (!badSince) {
    badSince = Date.now();
    log(`Watchdog: WhatsApp state is ${state} - waiting ${WATCHDOG_GRACE_MIN} min before restarting.`);
    return;
  }
  if (Date.now() - badSince >= WATCHDOG_GRACE_MIN * 60 * 1000) await restartBot(client, `WhatsApp ${state} for ${WATCHDOG_GRACE_MIN}+ min`);
}

function recentRestarts() {
  try {
    const list = JSON.parse(fs.readFileSync(RESTART_LOG, 'utf8'));
    return list.filter((t) => Date.now() - t < WATCHDOG_WINDOW_MIN * 60 * 1000);
  } catch {
    return [];
  }
}

async function restartBot(client, reason) {
  if (restarting) return;
  const recent = recentRestarts();
  if (recent.length >= WATCHDOG_MAX_RESTARTS) {
    // Don't loop forever (e.g. no internet) - try again later.
    if (!backoffNotified) {
      backoffNotified = true;
      logError(`Watchdog: ${recent.length} restarts in the last ${WATCHDOG_WINDOW_MIN} min - pausing automatic restarts.`);
      notifyOwner(`⚠️ הבוט ניסה ${recent.length} פעמים להתחבר מחדש לוואטסאפ ולא הצליח. אולי אין אינטרנט במחשב. אנסה שוב בעוד כחצי שעה.`);
    }
    return;
  }
  restarting = true;
  logError(`Watchdog: restarting the bot (${reason}).`);
  try { fs.writeFileSync(RESTART_LOG, JSON.stringify([...recent, Date.now()])); } catch { /* ignore */ }
  await withTimeout(Promise.resolve(notifyOwner('🔄 אין חיבור לוואטסאפ - הבוט מופעל מחדש אוטומטית.')), 5000).catch(() => {});
  await withTimeout(client.kill('watchdog restart'), 15000).catch(() => {});
  // The desktop app's supervisor starts the engine again (exit code 3). Run by hand (node index.js), it just stops.
  if (process.env.BOT_SUPERVISED !== '1') logError('Not running under the desktop app: start the bot again by hand.');
  setTimeout(() => process.exit(3), 1000);
}

function startWatchdog(client) {
  const everySec = Number(process.env.WATCHDOG_INTERVAL_SEC || 60);
  setInterval(() => checkWhatsAppHealth(client).catch((e) => logError('Watchdog error:', e.message)), everySec * 1000);
  log(`Watchdog on: restarts the bot if WhatsApp is disconnected for ${WATCHDOG_GRACE_MIN}+ minutes.`);
}

// =====================================================================
// Event extraction (runs in a serial queue so LM Studio isn't flooded)
// =====================================================================

let extractionQueue = Promise.resolve();

function scheduleEventExtraction(info) {
  if (!events.looksLikeItMayHaveEvent(info.content)) return;
  extractionQueue = extractionQueue
    .then(async () => {
      // Small model first: most messages with a number in them are not events - don't wake the big model.
      const pass = await router.gate('האם בהודעה יש אירוע, פגישה, תאריך, שעה, מועד, תשלום, או משימה שמישהו צריך לעשות?', info.content);
      if (pass) await extractAndStoreEvents(info);
    })
    .catch((err) => logError('Event extraction failed:', err.message));
}

async function extractAndStoreEvents({ message_id, chat_id, chat_name, sender_name, content, timestamp }) {
  const previous = await db.getRecentMessages(chat_id, 5);
  const context = previous
    .filter((r) => r.id !== message_id)
    .slice(-4)
    .map((r) => `${r.sender_name}: ${String(r.content).slice(0, 300)}`);

  const agent = router.forJob('extract');
  const found = await events.extractEvents(agent?.client || openai, agent?.model || EXTRACT_MODEL, {
    text: content,
    messageDate: new Date(timestamp * 1000),
    chatName: chat_name,
    senderName: sender_name,
    context,
  });

  const chatInfo = await db.getChat(chat_id);
  if (chatInfo?.event_prefix) {
    // Work chat: the full-conversation analysis owns its events (context, updates, cancellations).
    scheduleWorkAnalysis(chatInfo);
    if (found.tasks?.length) await suggestTasks(found.tasks, { origin: 'chat', chat_id, chat_name, message_id });
    return;
  }
  for (const ev of found) {
    if (ev.confidence < EVENT_MIN_CONFIDENCE) continue;
    const similar = await db.findSimilarEvent(chat_id, ev.date, ev.start_time);
    if (similar) {
      log(`Skipping duplicate event "${ev.title}" (${ev.date})`);
      continue;
    }
    const saved = await db.insertEvent({
      ...ev,
      chat_id,
      chat_name,
      message_id,
      source_text: String(content).slice(0, 1000),
      dedup_key: events.dedupKey(chat_id, ev),
    });
    if (!saved) continue;
    log(`New event #${saved.id}: ${saved.title} @ ${saved.date} ${saved.start_time || ''}`);
    const chat = await db.getChat(chat_id);
    if (!chat?.muted) await sendEventCard(saved);
  }
  if (found.tasks?.length) {
    await suggestTasks(found.tasks, { origin: 'chat', chat_id, chat_name, message_id });
    log(`Suggested ${found.tasks.length} task(s) from ${chat_name || chat_id}`);
  }
}

// =====================================================================
// Telegram
// =====================================================================

let ownerId = null;

async function getOwnerId() {
  if (ownerId) return ownerId;
  ownerId = process.env.TELEGRAM_OWNER_ID || (await db.getSetting('telegram_owner_id'));
  return ownerId || null;
}

async function notifyOwner(text, extra) {
  if (!tg.isConfigured()) return;
  const id = await getOwnerId();
  if (!id) return;
  try {
    await tg.sendMessage(id, text, extra);
  } catch (err) {
    logError('Telegram notify failed:', err.message);
  }
}

function eventCardText(ev) {
  const e = tg.escapeHtml;
  const lines = [`📅 <b>${e(ev.title)}</b>`, `🗓 ${e(events.formatEventWhen(ev))}`];
  if (ev.location) lines.push(`📍 ${e(ev.location)}`);
  if (ev.notes) lines.push(`📝 ${e(ev.notes)}`);
  if (ev.chat_name) lines.push(`💬 ${e(ev.chat_name)}`);
  const missing = [!ev.start_time && 'שעה', !ev.location && 'מיקום'].filter(Boolean);
  if (missing.length) lines.push(`✏️ חסר: ${missing.join(', ')} - אפשר להשלים בדשבורד`);
  for (const c of ev.conflicts || []) {
    lines.push(c.kind === 'overlap'
      ? `⛔ מתנגש ביומן: ${e(c.title)} (${c.start}–${c.end})`
      : `⚠️ ביומן באותו יום: ${e(c.title)}${c.all_day ? '' : ` (${c.start}–${c.end})`}`);
  }
  if (ev.source_text) lines.push('', `<i>${e(ev.source_text.slice(0, 300))}</i>`);
  if (ev.status === 'added') lines.push('', '✅ סומן כנוסף ליומן');
  if (ev.status === 'ignored') lines.push('', '❌ סומן כלא רלוונטי');
  return lines.join('\n');
}

function eventKeyboard(ev, { withStatusButtons = true } = {}) {
  const rows = [
    [
      { text: '➕ Google Calendar', url: events.googleCalendarLink(ev) },
      { text: '📎 קובץ ליומן (.ics)', callback_data: `ics:${ev.id}` },
    ],
  ];
  if (withStatusButtons) {
    rows.push([
      { text: '✅ הוספתי', callback_data: `done:${ev.id}` },
      { text: '❌ לא רלוונטי', callback_data: `ign:${ev.id}` },
    ]);
  }
  return { inline_keyboard: rows };
}

async function sendEventCard(ev) {
  ev.conflicts = await calendar.conflictsFor(ev).catch(() => []);
  await notifyOwner(eventCardText(ev), { parse_mode: 'HTML', reply_markup: eventKeyboard(ev) });
}

async function sendEventList(chatId, fromDate, toDate, title) {
  const list = await db.getEventsBetween(fromDate, toDate);
  if (!list.length) {
    await tg.sendMessage(chatId, `${title}\n\nאין אירועים.`);
    return;
  }
  const e = tg.escapeHtml;
  let currentDate = null;
  const lines = [`<b>${e(title)}</b>`];
  for (const ev of list) {
    if (ev.date !== currentDate) {
      currentDate = ev.date;
      lines.push('', `<b>${e(events.formatDateHe(ev.date))}</b>`);
    }
    const time = ev.start_time ? `${ev.start_time} ` : '';
    const mark = ev.status === 'added' ? '✅ ' : '';
    lines.push(
      `• ${mark}${time}${e(ev.title)}${ev.chat_name ? ` <i>(${e(ev.chat_name)})</i>` : ''} — <a href="${e(
        events.googleCalendarLink(ev)
      )}">➕ ליומן</a>`
    );
  }
  await tg.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

async function sendChatPicker(chatId, prefix, title) {
  const chats = await db.listRecentChats(16);
  if (!chats.length) {
    await tg.sendMessage(chatId, 'עדיין אין שיחות שמורות.');
    return;
  }
  const buttons = chats.map((c) => [
    {
      text: `${prefix === 'mute' ? (c.muted ? '🔕 ' : '🔔 ') : c.is_group ? '👥 ' : '👤 '}${(c.name || c.chat_id).slice(0, 40)}`,
      callback_data: `${prefix}:${c.rowid}`,
    },
  ]);
  await tg.sendMessage(chatId, title, { reply_markup: { inline_keyboard: buttons } });
}

async function sendChatSummary(chatId, chatRowid) {
  const chat = await db.getChatByRowid(chatRowid);
  if (!chat) return tg.sendMessage(chatId, 'השיחה לא נמצאה.');
  await tg.sendMessage(chatId, `⏳ מסכם את "${chat.name}"...`);
  try {
    const result = await summarizeChat(chat, { detail: 'full' });
    if (!result) return tg.sendMessage(chatId, 'אין הודעות שמורות בשיחה הזו.');
    await tg.sendMessage(chatId, `📋 סיכום "${chat.name}" (${result.label}):\n\n${result.content}`);
  } catch (err) {
    logError('Telegram summary failed:', err.message);
    await tg.sendMessage(chatId, 'שגיאה ביצירת הסיכום - ייתכן ש-LM Studio לא זמין כרגע.');
  }
}

async function sendDailyDigest(chatId) {
  const today = events.todayIsrael();
  await sendEventList(chatId, today, events.addDays(today, 7), '🗓 אירועים ב-7 הימים הקרובים');

  const openTasks = (await db.listTasks(['open'])).slice(0, 15);
  if (openTasks.length) {
    const fmtDue = (t) => (t.due_at ? ` (עד ${new Date(t.due_at * 1000).toLocaleString('he-IL', { timeZone: events.TZ, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })})` : '');
    await tg.sendMessage(chatId, `✅ משימות פתוחות:\n${openTasks.map((t) => `• ${t.text}${fmtDue(t)}`).join('\n')}`);
  }

  const pending = await db.getPendingEvents(today);
  if (pending.length) {
    await tg.sendMessage(chatId, `יש ${pending.length} אירועים שממתינים לאישור - שלח /events כדי לראות אותם.`);
  }

  // If chats were selected in the web UI, the digest covers only those; otherwise the most active ones.
  const since = Math.floor(Date.now() / 1000) - 24 * 3600;
  const activeAll = await db.getActiveChatsSince(since, 1);
  const selected = await db.getSelectedChats();
  const active = selected.length
    ? activeAll.filter((c) => selected.some((s) => s.chat_id === c.chat_id))
    : activeAll.filter((c) => !c.muted && c.count >= 3).slice(0, 10);
  if (!active.length) {
    await tg.sendMessage(chatId, '💤 לא היו הודעות חדשות בשיחות שלך ב-24 השעות האחרונות.');
    return;
  }
  await tg.sendMessage(chatId, `📬 סיכום יומי ל-${active.length} שיחות:`);
  for (const c of active) {
    try {
      const result = await summarizeChat(c, { detail: 'full', fallbackToRecent: false });
      if (result) await tg.sendMessage(chatId, `💬 ${c.name || c.chat_id} (${c.count} הודעות)\n\n${result.content}`);
    } catch (err) {
      logError('Digest summary failed for', c.chat_id, err.message);
    }
  }
}

function startDigestScheduler() {
  if (!tg.isConfigured()) return;
  setInterval(async () => {
    try {
      const now = events.israelParts();
      if (now.hour < DIGEST_HOUR) return; // sent at DIGEST_HOUR, or later that evening if the PC was asleep
      if ((await db.getSetting('last_digest_date')) === now.date) return;
      const id = await getOwnerId();
      if (!id) return;
      await db.setSetting('last_digest_date', now.date);
      log('Sending daily digest');
      await sendDailyDigest(id);
    } catch (err) {
      logError('Digest scheduler error:', err.message);
    }
  }, 60 * 1000);
}

// Nightly: relearn each selected chat's active-member profiles from their full message history.
function startProfileLearningScheduler() {
  setInterval(async () => {
    try {
      const now = events.israelParts();
      if (now.hour !== PROFILE_LEARN_HOUR) return;
      if ((await db.getSetting('last_profile_learn_date')) === now.date) return;
      await db.setSetting('last_profile_learn_date', now.date);

      const selected = await db.getSelectedChats();
      if (!selected.length) return;
      log(`Starting nightly member-profile learning for ${selected.length} chat(s)...`);
      for (const chat of selected) {
        try {
          const result = await profileChatMembers(chat, { hours: 0 });
          log(`Learned ${result.members.length} member profile(s) for "${result.chat_name}"`);
          if (await memory.learnGroup(chat)) log(`Learned the character of "${result.chat_name}"`);
        } catch (err) {
          logError(`Profile learning failed for chat ${chat.chat_id}:`, err.message);
        }
      }
      // People across ALL chats (the partner always, in depth).
      await memory.learnPeople({ important: [LOVE_PHONE] }).catch((err) => logError('People learning failed:', err.message));
      log('Nightly member-profile learning complete.');
      await notifyOwner(`🌙 למידת אופי לילית הושלמה עבור ${selected.length} קבוצות מסומנות.`);
    } catch (err) {
      logError('Profile learning scheduler error:', err.message);
    }
  }, 60 * 1000);
}

// Evening questions also go to Telegram: reply to a question message to answer it.
async function sendQuestionsToTelegram(list) {
  if (!tg.isConfigured() || !list.length) return;
  const chatId = await getOwnerId();
  if (!chatId) return;
  await tg.sendMessage(chatId, `🧠 יש לי ${list.length} שאלות קצרות כדי להכיר טוב יותר את האנשים והקבוצות שלך.\nענה בתגובה (Reply) על כל שאלה, או בדשבורד בסוף העמוד. אפשר לדלג.`);
  for (const q of list.slice().reverse()) {
    const sent = await tg.sendMessage(chatId, `❓ ${q.chat_name ? `${q.chat_name} · ` : ''}${q.question}`).catch(() => null);
    if (sent?.message_id) await db.updateQuestion(q.id, { tg_message_id: sent.message_id });
  }
}

const HELP_TEXT = `פקודות:
/summary - סיכום של שיחה (בחירה מרשימה)
/today - האירועים של היום
/week - האירועים ב-7 הימים הקרובים
/events - אירועים שממתינים לאישור
/digest - שלח עכשיו את הסיכום היומי
/mute - השתק/בטל השתקה של התראות אירועים לשיחה
/questions - השאלות הפתוחות שלי אליך (ענה בתגובה על שאלה)
/help - העזרה הזו

סיכום יומי נשלח אוטומטית בשעה ${DIGEST_HOUR}:00.`;

async function handleTelegramUpdate(update) {
  const fromId = String(update.message?.from?.id || update.callback_query?.from?.id || '');
  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  if (!fromId || !chatId) return;

  let owner = await getOwnerId();
  if (!owner && update.message?.text?.startsWith('/start')) {
    // When the bot was connected from the settings screen, only the person who sends the one-time code shown there
    // becomes the owner (otherwise anyone who found the bot first could read the summaries).
    const expected = await db.getSetting('telegram_link_code');
    if (expected && (update.message.text.trim().split(/\s+/)[1] || '') !== expected) {
      await tg.sendMessage(chatId, 'כדי לחבר את הבוט שלח: /start ואחריו הקוד שמופיע בהגדרות התוכנה. למשל: /start 123456');
      return;
    }
    if (expected) await db.setSetting('telegram_link_code', '');
    owner = fromId;
    ownerId = fromId;
    await db.setSetting('telegram_owner_id', fromId);
    log(`Telegram owner registered: ${fromId}`);
    await tg.sendMessage(chatId, `שלום! נרשמת כבעלים של הבוט ✅\n\n${HELP_TEXT}`);
    return;
  }
  if (String(owner) !== fromId) {
    if (update.message) await tg.sendMessage(chatId, 'זה בוט פרטי.');
    return;
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const [action, rawId] = String(q.data || '').split(':');
    const id = Number(rawId);
    if (action === 'sum') {
      await tg.answerCallback(q.id, 'מסכם...');
      await sendChatSummary(chatId, id);
    } else if (action === 'ics') {
      const ev = await db.getEvent(id);
      await tg.answerCallback(q.id);
      if (ev) await tg.sendDocument(chatId, `event-${ev.id}.ics`, events.buildIcs(ev), `📅 ${ev.title} - פתח את הקובץ כדי להוסיף ליומן`);
    } else if (action === 'done' || action === 'ign') {
      await db.setEventStatus(id, action === 'done' ? 'added' : 'ignored');
      const ev = await db.getEvent(id);
      await tg.answerCallback(q.id, action === 'done' ? 'סומן כנוסף ✅' : 'סומן כלא רלוונטי');
      if (ev) {
        await tg
          .call('editMessageText', {
            chat_id: chatId,
            message_id: q.message.message_id,
            text: eventCardText(ev),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: action === 'done' ? eventKeyboard(ev, { withStatusButtons: false }) : { inline_keyboard: [] },
          })
          .catch(() => {});
      }
    } else if (action === 'mute') {
      const chat = await db.getChatByRowid(id);
      if (chat) {
        await db.setChatMuted(id, !chat.muted);
        await tg.answerCallback(q.id, chat.muted ? `🔔 התראות הופעלו: ${chat.name}` : `🔕 הושתק: ${chat.name}`);
      }
    } else {
      await tg.answerCallback(q.id);
    }
    return;
  }

  const text = (update.message?.text || '').trim();
  // A reply to one of the bot's daily questions = the answer.
  const repliedTo = update.message?.reply_to_message?.message_id;
  if (repliedTo && text && !text.startsWith('/')) {
    const q = await db.getQuestionByTelegramId(repliedTo);
    if (q) {
      await memory.answerQuestion(q.id, text);
      await tg.sendMessage(chatId, '✓ נשמר. תודה - זה יעזור לי להבין טוב יותר.');
      return;
    }
  }
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const today = events.todayIsrael();

  switch (cmd) {
    case '/start':
    case '/help':
      await tg.sendMessage(chatId, HELP_TEXT);
      break;
    case '/summary':
      await sendChatPicker(chatId, 'sum', 'איזו שיחה לסכם?');
      break;
    case '/today':
      await sendEventList(chatId, today, today, `📅 היום - ${events.formatDateHe(today)}`);
      break;
    case '/week':
      await sendEventList(chatId, today, events.addDays(today, 7), '🗓 7 הימים הקרובים');
      break;
    case '/events': {
      const pending = await db.getPendingEvents(today);
      if (!pending.length) await tg.sendMessage(chatId, 'אין אירועים שממתינים לאישור 👌');
      for (const ev of pending.slice(0, 10)) {
        await tg.sendMessage(chatId, eventCardText(ev), { parse_mode: 'HTML', reply_markup: eventKeyboard(ev) });
      }
      break;
    }
    case '/digest':
      await sendDailyDigest(chatId);
      break;
    case '/questions': {
      const open = await db.listQuestions({ status: 'open' });
      if (!open.length) await tg.sendMessage(chatId, 'אין לי שאלות פתוחות כרגע 👌');
      else await sendQuestionsToTelegram(open);
      break;
    }
    case '/mute':
      await sendChatPicker(chatId, 'mute', 'לחץ על שיחה כדי להשתיק / לבטל השתקה של התראות אירועים:');
      break;
    default:
      await tg.sendMessage(chatId, HELP_TEXT);
  }
}

let telegramStarted = false;

function startTelegram() {
  if (telegramStarted) return;
  if (!tg.isConfigured()) {
    log('TELEGRAM_BOT_TOKEN not set - Telegram disabled.');
    return;
  }
  telegramStarted = true;
  tg.setCommands([
    { command: 'summary', description: 'סיכום של שיחה' },
    { command: 'today', description: 'אירועים היום' },
    { command: 'week', description: 'אירועים ב-7 הימים הקרובים' },
    { command: 'events', description: 'אירועים שממתינים לאישור' },
    { command: 'digest', description: 'סיכום יומי עכשיו' },
    { command: 'mute', description: 'השתקת התראות לשיחה' },
    { command: 'questions', description: 'השאלות של הבוט אליך' },
    { command: 'help', description: 'עזרה' },
  ]);
  log('Telegram bot polling started.');
  tg.startPolling(handleTelegramUpdate, logError);
}

// Local web dashboard (http://localhost:3000 by default, bound to this computer only).
// Linking state of the WhatsApp account (Baileys engine only; set in launchBaileys).
let waLink = null;
// Care trackers work even while WhatsApp is disconnected (manual records + reminders).
// After the migration, read the trackers once so their linked chats are known before the first message arrives.
migrateFeedingToCare().then(careStatusAll).catch((e) => logError('Care migration failed:', e.message));
setInterval(() => careReminderTick().catch((e) => logError('Care reminders failed:', e.message)), 60 * 1000);

// ---- services for the settings window ----
const careApi = {
  kinds: care.KINDS,
  status: careStatusAll,
  list: () => db.listTrackers(),
  save: async (body) => {
    const t = care.normalizeTracker(body);
    const id = await db.saveTracker({ ...t, id: body.id ? Number(body.id) : undefined });
    // A linked chat must be read (text), otherwise nothing arrives to record.
    if (t.chat_id) {
      const c = await db.getChat(t.chat_id);
      if (c && !parseListenFlags(c.listen_mode).text) await db.setChatListenMode(c.rowid, [...new Set([...String(c.listen_mode || '').split(',').filter(Boolean), 'text'])].join(','));
    }
    return id;
  },
  remove: (id) => db.deleteTracker(Number(id)),
  order: (ids) => db.setTrackerOrder(ids.map(Number)),
  record: careRecord,
  removeLog: (id) => db.deleteCareLog(Number(id)),
};

const partnerApi = {
  async get() {
    const chat = await getLoveChat().catch(() => null);
    return { gender: (await db.getSetting('partner_gender')) || 'female', name: (await db.getSetting('partner_name')) || '', chat: chat ? { rowid: chat.rowid, chat_id: chat.chat_id, name: chat.name } : null };
  },
  search: (q) => db.searchPeople(q, 30),
  /** { id?: jid | null (null = remove), name?, gender? } */
  async set({ id, name, gender }) {
    if (gender !== undefined) await db.setSetting('partner_gender', gender === 'male' ? 'male' : 'female');
    if (name !== undefined) await db.setSetting('partner_name', String(name || '').trim().slice(0, 40));
    if (id === null) { await db.setSetting('love_chat_id', ''); await db.setSetting('love_analysis', 'null'); }
    if (id) {
      const jid = String(id);
      if (!/^\d{6,16}@(s\.whatsapp\.net|c\.us)$/.test(jid)) throw new Error('איש הקשר לא תקין');
      let chat = (await db.getChat(jid)) || (await db.getChat(jid.replace('@s.whatsapp.net', '@c.us'))) || (await db.getChat(jid.replace('@c.us', '@s.whatsapp.net')));
      if (!chat) { await db.upsertChat({ chat_id: jid, name: name || null, is_group: 0, last_message_at: 0, is_unknown: null }); chat = await db.getChat(jid); }
      await db.setSetting('love_chat_id', chat.chat_id);
      await db.setSetting('love_analysis', 'null');
      await ensureListening(chat); // marking also copies the last 24 hours from the archive
    }
    return this.get();
  },
};

// Backups of the work database (VACUUM INTO = a consistent copy while the app keeps running). Keeps the last 7.
async function backupNow() {
  const dir = dataPath('backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = path.join(dir, `work-${stamp}.db`);
  fs.rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite (two backups in the same second)
  await db.backupTo(file);
  const all = fs.readdirSync(dir).filter((f) => /^work-\d+\.db$/.test(f)).sort();
  for (const old of all.slice(0, -7)) fs.rmSync(path.join(dir, old), { force: true });
  const info = { at: Math.floor(Date.now() / 1000), file: path.basename(file), size: fs.statSync(file).size, ok: true };
  await db.setSetting('last_backup', JSON.stringify(info));
  log(`Backup saved: ${info.file}`);
  return info;
}
setTimeout(async () => {
  const last = JSON.parse((await db.getSetting('last_backup').catch(() => null)) || 'null');
  if (!last || Date.now() / 1000 - last.at > 86400) await backupNow().catch(async (e) => { logError('Backup failed:', e.message); await db.setSetting('last_backup', JSON.stringify({ at: Math.floor(Date.now() / 1000), ok: false, error: e.message })).catch(() => {}); });
}, 2 * 60 * 1000);
setInterval(() => backupNow().catch((e) => logError('Backup failed:', e.message)), 24 * 3600 * 1000);

/** "System status": one place that says what works, what does not, and what to do about it. */
async function systemStatus() {
  const wa = waLink ? waLink.status() : { engine: 'baileys', state: 'STARTING', linked: false, needsLink: false };
  const lastMsg = await db.getLastMessageTs(null).catch(() => null);
  const ai = localai.status();
  const backup = JSON.parse((await db.getSetting('last_backup').catch(() => null)) || 'null');
  const archive = waLink?.archiveStats ? await waLink.archiveStats().catch(() => null) : null;
  const size = (f) => { try { return fs.statSync(dataPath(f)).size; } catch { return 0; } };
  const problems = [];
  if (!wa.linked) problems.push({ level: 'bad', text: 'וואטסאפ לא מחובר למחשב הזה', fix: 'link', fix_label: 'קישור מחדש' });
  else if (lastMsg && Date.now() / 1000 - lastMsg > 12 * 3600) problems.push({ level: 'warn', text: 'לא התקבלו הודעות כבר יותר מ-12 שעות', fix: 'sync', fix_label: 'סנכרון שיחות' });
  if (!MAIN_IS_LOCAL && ['local', 'manual'].includes(process.env.PRIVACY_MODE)) problems.push({ level: process.env.PRIVACY_MODE === 'local' ? 'bad' : 'warn', text: process.env.PRIVACY_MODE === 'local' ? 'מצב הפרטיות "מקומי בלבד" אבל אין מודל מקומי: שום סיכום לא ייעשה' : 'מצב הפרטיות "ידני" בלי מודל מקומי: עבודה ברקע (אירועים, תמונות, סיכומים קצרים) לא תיעשה', fix: 'models', fix_label: 'הגדרת מודל מקומי' });
  if (!process.env.LOCAL_ENGINE && !llm.status().length) problems.push({ level: 'bad', text: 'עוד לא הוגדר מודל AI: בלי מודל אין סיכומים', fix: 'models', fix_label: 'הגדרת מודל' });
  if (process.env.LOCAL_ENGINE === 'builtin') {
    if (!ai.state.main) problems.push({ level: 'bad', text: 'לא נבחר מודל מקומי ראשי', fix: 'models', fix_label: 'בחירת מודל' });
    for (const role of ['main', 'agent']) {
      const s = ai.servers[role];
      if (s.state === 'crashed') {
        const oom = /memory|alloc|oom|vram/i.test(s.error || '');
        problems.push({ level: 'bad', text: `המודל ${role === 'main' ? 'הראשי' : 'הסוכן'} נעצר${oom ? ': אין מספיק זיכרון בכרטיס המסך' : ''}`, detail: s.error, fix: oom ? 'models' : 'restart-ai', fix_label: oom ? 'מעבר למודל קטן יותר' : 'הפעלה מחדש' });
      }
      if (s.state === 'no-runtime') problems.push({ level: 'bad', text: 'מנוע llama.cpp לא מותקן', fix: 'models', fix_label: 'התקנה' });
    }
  }
  for (const c of llm.status()) if (!c.ready) problems.push({ level: 'warn', text: `ספק הענן ${c.name} לא זמין כרגע`, detail: c.last_error, fix: 'cloud', fix_label: 'הגדרות ספקים' });
  if (!backup) problems.push({ level: 'warn', text: 'עוד לא נעשה גיבוי', fix: 'backup', fix_label: 'גבה עכשיו' });
  else if (!backup.ok) problems.push({ level: 'bad', text: 'הגיבוי האחרון נכשל', detail: backup.error, fix: 'backup', fix_label: 'נסה שוב' });
  if (tg.isConfigured() && !(await db.getSetting('telegram_owner_id'))) problems.push({ level: 'warn', text: 'בוט הטלגרם עוד לא אומת', fix: 'telegram', fix_label: 'חיבור טלגרם' });
  return {
    whatsapp: { ...wa, last_message_at: lastMsg },
    models: { engine: process.env.LOCAL_ENGINE || 'external', main: LLM_MODEL, agent: router.model, agent_jobs: router.jobs, servers: ai.servers, cloud: llm.status(), privacy: process.env.PRIVACY_MODE || 'hybrid' },
    storage: { work_db: size('whatsapp_history.db') + size('whatsapp_history.db-wal'), archive_db: size('archive.db') + size('archive.db-wal'), archive, data_dir: dataPath('') },
    backup,
    uptime_sec: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 2 ** 20),
    problems,
  };
}

require('./web').startWebServer({ waLink: () => waLink, db, events, calendar, summarizeChat, askQuestion, profileChatMembers, chatWithMemory, analyzeLove, setLoveChat, analyzeUnknown, backfillChat, analyzeWorkChat, syncAllChats, markLoveDone, memory, router, models: { big: LLM_MODEL, extract: EXTRACT_MODEL, vision: VISION_MODEL }, llm, log, logError, careApi, partnerApi, localai, systemStatus, backupNow, notifyOwner });

// Baileys path: resolves with a client of the same shape once this computer is linked and connected.
function launchBaileys() {
  return Promise.all([import('./wa/compat.js'), import('./wa/archive.js')]).then(async ([{ createCompat }, { createArchive, DEFAULT_RETENTION_DAYS }]) => {
    const authDir = process.env.WA_AUTH_DIR ? path.resolve(process.env.WA_AUTH_DIR) : dataPath('wa-auth');
    // Two local files: the work DB (marked chats, kept for good, with summaries) and archive.db (everything else,
    // kept ARCHIVE_DAYS days, default 30). Marking a chat copies its last 24 hours from the archive into the work DB.
    const archiveDb = await require('sqlite').open({ filename: dataPath('archive.db'), driver: require('sqlite3').Database });
    await archiveDb.exec('PRAGMA journal_mode = WAL;');
    const archive = createArchive({ db: archiveDb, mediaDir: dataPath('archive-media'), retentionDays: Number(process.env.ARCHIVE_DAYS) || DEFAULT_RETENTION_DAYS, log });
    const isMarked = async (chat_id) => parseListenFlags((await db.getChat(chat_id).catch(() => null))?.listen_mode).any;
    const linkInfo = { asked: false, batches: 0, messages: 0, last: 0 };
    const keepImages = async (chat_id) => !!(await db.getChat(chat_id).catch(() => null))?.archive_images;
    const compat = createCompat({
      authDir,
      log,
      archive,
      isMarked,
      keepImages,
      knownContacts: await db.listContacts().catch(() => []),
      onContacts: (list) => db.upsertContacts(list),
      onQr: () => { if (!linkInfo.asked) { linkInfo.asked = true; log('WhatsApp is not linked on this computer yet - waiting for linking from the dashboard.'); } },
      // History comes once, right after linking: every chat goes into the chat list (so it can be marked), messages of
      // chats that are already marked go to the work DB, and compat has already put the rest in the 30-day archive.
      onHistory: async (h) => {
        linkInfo.batches += 1;
        linkInfo.messages += h.messages.length + (h.archived || 0);
        linkInfo.last = Date.now();
        for (const c of h.chats) {
          if (!c.chat_id || c.chat_id === 'status@broadcast' || c.chat_id.endsWith('@newsletter') || c.chat_id.endsWith('@broadcast') || c.chat_id.endsWith('@lid')) continue;
          await db.upsertChat({ chat_id: c.chat_id, name: c.name, is_group: c.is_group, last_message_at: c.last_ts || 0, is_unknown: null }).catch(() => {});
        }
        for (const m of h.messages) {
          if (m.type !== 'chat' || !m.content) continue;
          await db.saveMessage({ id: m.id, chat_id: m.chat_id, sender_name: m.from_me ? 'אני' : m.sender_name || null, sender_id: m.sender_id, content: m.content, type: 'text', timestamp: m.timestamp, from_me: m.from_me }).catch(() => {});
        }
        await db.nameChatsFromContacts().catch(() => {});
      },
    });
    waLink = {
      status: () => ({ engine: 'baileys', state: compat.state, linked: compat.state === 'CONNECTED', needsLink: compat.link.needed, history: { batches: linkInfo.batches, messages: linkInfo.messages, idleSec: linkInfo.last ? Math.round((Date.now() - linkInfo.last) / 1000) : null } }),
      pair: (phone) => compat.link.pair(phone),
      archiveStats: () => archive.stats(),
      clearArchive: () => archive.clear(),
    };
    decryptMedia = compat.decryptMedia;
    refreshWaContacts = () => compat.refreshContacts();
    db.setMarkHook(async (chat_id) => {
      const n = await compat.promote(chat_id, (m) => handleIncomingMessage(compat.client, m, { catchUp: true }));
      log(`Chat ${chat_id} marked: ${n} messages from the last 24 hours copied from the archive.`);
    });
    const purge = () => archive.purge().then((n) => { if (n) log(`Archive: ${n} messages older than ${archive.retentionDays} days deleted.`); }).catch((e) => logError('archive purge failed:', e.message));
    purge();
    setInterval(purge, 6 * 3600 * 1000);
    log('WhatsApp engine: Baileys (read-only, no browser).');
    return compat.start().then(() => compat.ready);
  });
}

launchBaileys()
  .then((client) => start(client))
  .catch((err) => {
    logError('Failed to initialize WhatsApp client:', err.message);
    process.exit(1);
  });

process.on('unhandledRejection', (reason) => {
  logError('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  logError('Uncaught exception:', err.message);
});
