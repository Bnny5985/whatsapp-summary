// Settings the user changes from the dashboard (AI provider, Telegram bot). They live in the ".env" file of the data
// folder - the same file the engine has always read - so nothing else in the engine had to change.
// Secrets are only ever written here; they are never sent back to the browser.
const fs = require('fs');
const { dataPath } = require('./paths');

const ENV_FILE = dataPath('.env');
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

function readEnv(file = ENV_FILE) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Values are written in single quotes so "#" and spaces survive; a value that cannot be written safely is refused.
function formatValue(value) {
  const v = String(value ?? '').trim();
  if (/[\r\n']/.test(v)) throw new Error('הערך מכיל תו לא חוקי');
  return v === '' ? '' : `'${v}'`;
}

/** Set (or, with an empty value, clear) keys in the settings file, keeping every other line as it is. */
function updateEnv(changes, file = ENV_FILE) {
  for (const k of Object.keys(changes)) if (!KEY_RE.test(k)) throw new Error(`bad setting name: ${k}`);
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { /* new file */ }
  const left = new Map(Object.entries(changes).map(([k, v]) => [k, formatValue(v)]));
  lines = lines.map((line) => {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (!m || !left.has(m[1])) return line;
    const v = left.get(m[1]);
    left.delete(m[1]);
    return `${m[1]}=${v}`;
  });
  for (const [k, v] of left) if (v !== '') lines.push(`${k}=${v}`);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

// Ready-made choices for the "AI provider" list. The model name stays editable: providers rename models often.
const AI_PRESETS = [
  { id: 'gemini', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-3.8-flash', keyHelp: 'aistudio.google.com > Get API key', cloud: true },
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHelp: 'platform.openai.com > API keys', cloud: true },
  { id: 'anthropic', label: 'Anthropic Claude', url: 'https://api.anthropic.com/v1/', model: 'claude-haiku-5-5', keyHelp: 'console.anthropic.com > API keys', cloud: true },
  { id: 'nvidia', label: 'NVIDIA', url: 'https://integrate.api.nvidia.com/v1', model: 'meta/llama-3.3-70b-instruct', keyHelp: 'build.nvidia.com > Get API key', cloud: true },
  { id: 'lmstudio', label: 'מודל מקומי - LM Studio', url: 'http://localhost:1234/v1', model: 'local-model', keyHelp: 'לא צריך מפתח', cloud: false },
  { id: 'ollama', label: 'מודל מקומי - Ollama', url: 'http://localhost:11434/v1', model: 'llama3.1', keyHelp: 'לא צריך מפתח', cloud: false },
];

// Jobs a small "agent" model can do instead of the main model (router.js / index.js read AGENT_JOBS).
const AGENT_JOBS = [
  { id: 'gate', label: 'מיון הודעות: האם יש בהודעה אירוע או משימה', default: true },
  { id: 'filter', label: 'סינון שורות חשובות לפני סיכום ולפני תשובה לשאלה', default: true },
  { id: 'links', label: 'תקציר קצר של קישורים שנשלחו', default: true },
  { id: 'extract', label: 'חילוץ אירועים ומשימות (מודל קטן פחות מדויק כאן)', default: false },
];
const agentJobs = (env = process.env) => (env.AGENT_JOBS === undefined ? AGENT_JOBS.filter((j) => j.default).map((j) => j.id) : String(env.AGENT_JOBS).split(',').map((x) => x.trim()).filter(Boolean));

const PRIVACY_MODES = ['hybrid', 'local', 'manual'];

function readCloud(env) {
  const list = [];
  for (let i = 1; i <= 5; i++) {
    if (!env[`CLOUD_${i}_URL`]) continue;
    list.push({
      n: i, name: env[`CLOUD_${i}_NAME`] || `ספק ${i}`, url: env[`CLOUD_${i}_URL`], model: env[`CLOUD_${i}_MODEL`] || '',
      has_key: Boolean(env[`CLOUD_${i}_KEY`]), private: String(env[`CLOUD_${i}_PRIVATE`] ?? '0') === '1',
      rpm: Number(env[`CLOUD_${i}_RPM`] || 30), context: Number(env[`CLOUD_${i}_CONTEXT`] || 32000),
    });
  }
  return list;
}

function publicSettings() {
  const env = readEnv();
  const url = env.LLM_BASE_URL || env.LM_STUDIO_URL || '';
  const engine = env.LOCAL_ENGINE || (url ? (url.includes(':11434') ? 'ollama' : url.includes(':1234') ? 'lmstudio' : AI_PRESETS.find((p) => p.url === url && p.cloud) ? 'cloud' : 'custom') : 'builtin');
  return {
    ai: { url, model: env.LLM_MODEL || '', has_key: Boolean(env.LLM_API_KEY), preset: AI_PRESETS.find((p) => p.url === url)?.id || (url ? 'custom' : '') },
    local: { engine, url, model: env.LLM_MODEL || '', fast_model: env.FAST_MODEL || '', gpu: env.LOCAL_GPU || 'auto', context: Number(env.LOCAL_CONTEXT) || 8192 },
    cloud: readCloud(env),
    agents: { jobs: agentJobs(env), all: AGENT_JOBS },
    privacy: { mode: PRIVACY_MODES.includes(env.PRIVACY_MODE) ? env.PRIVACY_MODE : 'hybrid' },
    general: { digest_hour: Number(env.DIGEST_HOUR ?? 20), archive_days: Number(env.ARCHIVE_DAYS || 30) },
    telegram: { has_token: Boolean(env.TELEGRAM_BOT_TOKEN) },
    presets: AI_PRESETS,
  };
}

/** Which engine runs the local model: builtin (llama.cpp in this app), lmstudio, ollama, custom URL, or cloud (no local model). */
function saveLocal({ engine, url, model, fast_model, gpu, context }) {
  const changes = { LOCAL_ENGINE: engine };
  if (!['builtin', 'lmstudio', 'ollama', 'custom', 'cloud'].includes(engine)) throw new Error('מנוע לא מוכר');
  if (engine === 'builtin') {
    changes.LOCAL_GPU = ['auto', 'vulkan', 'cpu'].includes(gpu) ? (gpu === 'auto' ? '' : gpu) : '';
    const c = Number(context) || 8192;
    if (c < 2048 || c > 131072) throw new Error('גודל ההקשר צריך להיות בין 2048 ל-131072');
    changes.LOCAL_CONTEXT = String(c);
  } else if (engine === 'cloud') {
    const env = readEnv();
    const first = readCloud(env)[0];
    if (!first) throw new Error('כדי לעבוד בלי מודל מקומי צריך קודם להוסיף ספק ענן');
    Object.assign(changes, { LLM_BASE_URL: first.url, LLM_MODEL: first.model, LLM_API_KEY: env[`CLOUD_${first.n}_KEY`] || '', FAST_MODEL: '' });
  } else {
    const preset = AI_PRESETS.find((p) => p.id === engine);
    const u = String(url || preset?.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('כתובת השירות לא תקינה');
    const m = String(model || '').trim();
    if (!m) throw new Error('חסר שם מודל');
    Object.assign(changes, { LLM_BASE_URL: u, LM_STUDIO_URL: u, LLM_MODEL: m, LLM_API_KEY: '', FAST_MODEL: String(fast_model || '').trim() });
  }
  updateEnv(changes);
}

/** The full list of cloud providers, in order of preference. A provider sent without a key keeps the key it had. */
function saveCloud(list) {
  if (!Array.isArray(list) || list.length > 5) throw new Error('אפשר עד 5 ספקים');
  const env = readEnv();
  const changes = {};
  for (let i = 1; i <= 5; i++) for (const k of ['NAME', 'URL', 'KEY', 'MODEL', 'PRIVATE', 'RPM', 'CONTEXT']) changes[`CLOUD_${i}_${k}`] = '';
  list.forEach((p, idx) => {
    const i = idx + 1;
    const url = String(p.url || '').trim();
    if (!/^https:\/\/[^\s]+$/i.test(url)) throw new Error(`ספק ${i}: הכתובת צריכה להתחיל ב-https://`);
    const model = String(p.model || '').trim();
    if (!model) throw new Error(`ספק ${i}: חסר שם מודל`);
    // A saved key stays only with the address it was saved for: a new address needs the key pasted again.
    const sameUrl = p.n && String(env[`CLOUD_${Number(p.n)}_URL`] || '').trim() === url;
    const key = String(p.key || '').trim() || (sameUrl ? env[`CLOUD_${Number(p.n)}_KEY`] || '' : '');
    if (!key) throw new Error(`ספק ${i}: ${p.n && !sameUrl ? 'הכתובת השתנתה, צריך להדביק שוב את מפתח ה-API' : 'חסר מפתח API'}`);
    Object.assign(changes, {
      [`CLOUD_${i}_NAME`]: String(p.name || `ספק ${i}`).trim().slice(0, 30), [`CLOUD_${i}_URL`]: url, [`CLOUD_${i}_KEY`]: key, [`CLOUD_${i}_MODEL`]: model,
      [`CLOUD_${i}_PRIVATE`]: p.private ? '1' : '0', [`CLOUD_${i}_RPM`]: String(Math.min(Math.max(Number(p.rpm) || 30, 1), 1000)),
      [`CLOUD_${i}_CONTEXT`]: String(Math.min(Math.max(Number(p.context) || 32000, 2048), 2000000)),
    });
  });
  updateEnv(changes);
}

function saveAgents({ jobs }) {
  const ok = (Array.isArray(jobs) ? jobs : []).filter((j) => AGENT_JOBS.some((x) => x.id === j));
  updateEnv({ AGENT_JOBS: ok.join(',') || 'none' });
}

function savePrivacy({ mode }) {
  if (!PRIVACY_MODES.includes(mode)) throw new Error('מצב פרטיות לא מוכר');
  updateEnv({ PRIVACY_MODE: mode });
}

function saveGeneral({ digest_hour, archive_days }) {
  const h = Number(digest_hour);
  const d = Number(archive_days);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error('שעת הסיכום היומי צריכה להיות בין 0 ל-23');
  if (!Number.isInteger(d) || d < 3 || d > 365) throw new Error('ימי שמירה בארכיון: בין 3 ל-365');
  updateEnv({ DIGEST_HOUR: String(h), ARCHIVE_DAYS: String(d) });
}

function saveAi({ url, key, model }) {
  const u = String(url || '').trim();
  const m = String(model || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('כתובת השירות לא תקינה');
  if (!m) throw new Error('חסר שם מודל');
  const changes = { LLM_BASE_URL: u, LLM_MODEL: m };
  if (key !== undefined && String(key).trim() !== '') changes.LLM_API_KEY = String(key).trim(); // empty = keep the stored key
  updateEnv(changes);
}

function saveTelegramToken(token) {
  const t = String(token || '').trim();
  if (t && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('זה לא נראה כמו טוקן של BotFather (צורה: 123456:ABC...)');
  updateEnv({ TELEGRAM_BOT_TOKEN: t });
}

module.exports = { readEnv, updateEnv, publicSettings, saveAi, saveTelegramToken, saveLocal, saveCloud, saveAgents, savePrivacy, saveGeneral, agentJobs, AI_PRESETS, AGENT_JOBS, ENV_FILE };
