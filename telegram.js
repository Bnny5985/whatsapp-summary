// Minimal Telegram Bot API client (no extra dependencies - uses Node's built-in fetch).
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAX_LEN = 4000;

function isConfigured() {
  return Boolean(TOKEN);
}

async function call(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description}`);
  return data.result;
}

function escapeHtml(text = '') {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitText(text) {
  const parts = [];
  let rest = String(text);
  while (rest.length > MAX_LEN) {
    let cut = rest.lastIndexOf('\n', MAX_LEN);
    if (cut < MAX_LEN / 2) cut = MAX_LEN;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}

async function sendMessage(chatId, text, extra = {}) {
  const parts = splitText(text);
  let last;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const params = {
      chat_id: chatId,
      text: parts[i],
      disable_web_page_preview: true,
      ...(isLast ? extra : { parse_mode: extra.parse_mode }),
    };
    try {
      last = await call('sendMessage', params);
    } catch (err) {
      // A long HTML message split in the middle of a tag can't be parsed - send it as plain text instead.
      if (!params.parse_mode || !/parse entities|can't find end/i.test(err.message)) throw err;
      const plain = parts[i].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      last = await call('sendMessage', { ...params, text: plain, parse_mode: undefined });
    }
  }
  return last;
}

async function sendDocument(chatId, filename, content, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([content], { type: 'text/calendar' }), filename);
  const res = await fetch(`${API}/sendDocument`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram sendDocument failed: ${data.description}`);
  return data.result;
}

function answerCallback(callbackQueryId, text) {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text }).catch(() => {});
}


function setCommands(commands) {
  return call('setMyCommands', { commands }).catch(() => {});
}

// Long polling loop. onUpdate(update) is awaited for each update.
async function startPolling(onUpdate, onError = console.error) {
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          onError('Telegram update handler failed:', err.message);
        }
      }
    } catch (err) {
      onError('Telegram polling error:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

module.exports = {
  isConfigured,
  call,
  escapeHtml,
  sendMessage,
  sendDocument,
  answerCallback,
  setCommands,
  startPolling,
};
