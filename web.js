// Local web dashboard. Bound to 127.0.0.1 by default, so it is reachable only from this computer.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.WEB_PORT || 3000);
const HOST = process.env.WEB_HOST || '127.0.0.1';
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', ...(process.env.WEB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)];
const p2pLib = require('./p2p');
const UI_FILE = path.join(__dirname, 'ui.html');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PUBLIC_TYPES = { '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// Optional extra lock for remote access through `tailscale serve`: only this Tailscale login may use the dashboard.
// Read on every request: turning phone access on in the settings sets it to your own login without a restart.
const allowedTsUser = () => (process.env.WEB_ALLOWED_TS_USER || '').trim().toLowerCase();

// localhost, anything in WEB_ALLOWED_HOSTS, and this machine's private Tailscale name (*.ts.net).
function isAllowedHost(host) {
  if (!host) return false;
  return ALLOWED_HOSTS.includes(host) || host.endsWith('.ts.net');
}

// `tailscale serve` relays phone requests from 127.0.0.1, so the socket address alone can't tell them apart
// from this computer. Its forwarding headers (or a *.ts.net Host) mark a request as remote, and the Host
// header alone is never trusted: a relayed request that claims "Host: localhost" is still remote.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// The built-in phone bridge (p2p.js) also relays from 127.0.0.1 and marks its requests with X-Remote-Peer-Id +
// X-P2P-Proxy-Secret; any request carrying either header is remote, valid or not.
const P2P_HEADERS = ['x-p2p-proxy-secret', 'x-remote-peer-id'];
const PROXY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', ...P2P_HEADERS];
const isProxied = (req, host) => host.endsWith('.ts.net') || PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
const isLocalRequest = (req, host) => !isProxied(req, host) && LOOPBACK.has(req.socket.remoteAddress) && ['localhost', '127.0.0.1'].includes(host);
const isP2PRequest = (req) => P2P_HEADERS.some((h) => req.headers[h] !== undefined);

// Changes that only the computer itself may make, whichever way a phone connects (Tailscale or the built-in bridge):
// AI keys and providers, the Telegram bot, linking WhatsApp, phone access itself, installing AI engines, deleting data.
const COMPUTER_ONLY = [
  /^\/api\/settings\/(ai|telegram|local|cloud|cloud\/test|agents|general)$/,
  /^\/api\/(remote|p2p)(\/|$)/,
  /^\/api\/wa\/pair$/,
  /^\/api\/ai\//,
  /^\/api\/data\//,
  /^\/api\/system\/(restart|open-folder)$/,
];
const isComputerOnly = (method, pathname) => method !== 'GET' && COMPUTER_ONLY.some((re) => re.test(pathname));

function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const MEDIA_DIR = require('./paths').dataPath('media');
const appSettings = require('./appsettings');
// Under the desktop app the engine is restarted by exiting with code 3 (the app starts it again with the new settings).
const SUPERVISED = process.env.BOT_SUPERVISED === '1';
function restartSoon() { if (SUPERVISED) setTimeout(() => process.exit(3), 800); }
// End of the one-click local AI setup: use the built-in engine from now on.
function switchToBuiltin() { appSettings.updateEnv({ LOCAL_ENGINE: 'builtin' }); restartSoon(); }
const SERVER_VERSION = 12; // bump together with UI_VERSION in ui.html
const MEDIA_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.ogg': 'audio/ogg' };
const LISTEN_FLAGS = ['text', 'voice', 'images', 'links'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function startWebServer({ waLink = () => null, db, events, calendar, summarizeChat, askQuestion, profileChatMembers, chatWithMemory, analyzeLove, setLoveChat, analyzeUnknown, backfillChat, analyzeWorkChat, syncAllChats, markLoveDone, memory, router, models, llm, log, logError, careApi = null, partnerApi = null, localai = null, systemStatus = null, backupNow = null, notifyOwner = null }) {
  const remote = require('./remote').createRemote({ port: PORT, log });
  const p2p = p2pLib.createP2P({ port: PORT, dataDir: require('./paths').DATA_DIR, log });
  if (p2pLib.enabled()) p2p.start();
  const server = http.createServer(async (req, res) => {
    try {
      // Block DNS-rebinding style access from other sites.
      const host = String(req.headers.host || '').split(':')[0];
      if (!isAllowedHost(host)) return send(res, 403, { error: 'forbidden host' });

      // Relayed requests (phone access through `tailscale serve`) must carry the owner's Tailscale login.
      // With no owner set (phone access never turned on in the settings) every relayed request is refused.
      // Requests from the built-in bridge must carry this session's secret and a phone NodeId, and phone access must be on.
      if (isP2PRequest(req)) {
        if (!p2pLib.enabled() || !p2pLib.remotePeer(req)) return send(res, 403, { error: 'forbidden device' });
      } else if (isProxied(req, host)) {
        const owner = allowedTsUser();
        const tsUser = String(req.headers['tailscale-user-login'] || '').trim().toLowerCase();
        if (!owner || tsUser !== owner) return send(res, 403, { error: 'forbidden user' });
      }
      // Block cross-site requests (CSRF): a POST must come from this dashboard's own page.
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const originHost = origin ? (() => { try { return new URL(origin).hostname; } catch { return null; } })() : null;
        // Same site only: localhost, or exactly this dashboard's own address (not any *.ts.net site).
        if (origin && !(originHost === host || ALLOWED_HOSTS.includes(originHost))) return send(res, 403, { error: 'forbidden origin' });
        if (!String(req.headers['content-type'] || '').includes('application/json')) {
          return send(res, 415, { error: 'content-type must be application/json' });
        }
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (isComputerOnly(req.method, url.pathname) && !isLocalRequest(req, host)) return send(res, 403, { error: 'אפשר לשנות את זה רק במחשב עצמו' });

      // Static app files (manifest + icons) so the dashboard can be installed on a phone home screen.
      if (req.method === 'GET' && parts[0] === 'public' && parts.length === 2) {
        const name = path.basename(parts[1]);
        const type = PUBLIC_TYPES[path.extname(name)];
        const file = path.join(PUBLIC_DIR, name);
        if (!type || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(file), type);
      }

      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(UI_FILE), 'text/html; charset=utf-8', {
          'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        });
      }

      // ---- settings screen: AI provider + Telegram bot (stored in the data folder's .env; secrets never leave it) ----
      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return send(res, 200, { ...appSettings.publicSettings(), supervised: SUPERVISED, telegram_owner: Boolean(await db.getSetting('telegram_owner_id')) });
      }
      if (req.method === 'POST' && url.pathname === '/api/settings/ai') {
        try { appSettings.saveAi(await readJson(req)); } catch (err) { return send(res, 400, { error: err.message }); }
        send(res, 200, { ok: true, restarting: SUPERVISED });
        return restartSoon();
      }
      // The user's own Telegram bot: save its token and hand back a one-time code; whoever sends "/start <code>" to the bot becomes its owner.
      if (req.method === 'POST' && url.pathname === '/api/settings/telegram') {
        const body = await readJson(req);
        try { appSettings.saveTelegramToken(body.token); } catch (err) { return send(res, 400, { error: err.message }); }
        const code = body.token ? String(require('crypto').randomInt(100000, 1000000)) : '';
        await db.setSetting('telegram_link_code', code);
        await db.setSetting('telegram_owner_id', '');
        send(res, 200, { ok: true, code, restarting: SUPERVISED });
        return restartSoon();
      }
      // ---- settings window (public/settings.js) ----
      const saveAndRestart = async (fn) => {
        try { fn(await readJson(req)); } catch (err) { return send(res, 400, { error: err.message }); }
        send(res, 200, { ok: true, restarting: SUPERVISED });
        return restartSoon();
      };
      if (req.method === 'POST' && url.pathname === '/api/settings/local') return saveAndRestart(appSettings.saveLocal);
      if (req.method === 'POST' && url.pathname === '/api/settings/cloud') return saveAndRestart((b) => appSettings.saveCloud(b.list));
      if (req.method === 'POST' && url.pathname === '/api/settings/agents') return saveAndRestart(appSettings.saveAgents);
      if (req.method === 'POST' && url.pathname === '/api/settings/general') return saveAndRestart(appSettings.saveGeneral);
      // Privacy mode takes effect at once (providers.js reads it on every request) and is kept for the next start.
      if (req.method === 'POST' && url.pathname === '/api/settings/privacy') {
        const body = await readJson(req);
        try { appSettings.savePrivacy(body); } catch (err) { return send(res, 400, { error: err.message }); }
        process.env.PRIVACY_MODE = body.mode;
        return send(res, 200, { ok: true });
      }
      // A tiny test request to a cloud provider before saving it (the key is used once and not stored here).
      if (req.method === 'POST' && url.pathname === '/api/settings/cloud/test') {
        const b = await readJson(req);
        // A saved key is only ever sent to the address it was saved with - never to a URL that arrives in the request.
        const env = appSettings.readEnv();
        const savedFor = b.n ? String(env[`CLOUD_${Number(b.n)}_URL`] || '').trim() : '';
        const typed = String(b.key || '').trim();
        if (!typed && b.n && savedFor !== String(b.url || '').trim()) return send(res, 400, { error: 'הכתובת השתנתה: הדבק שוב את המפתח כדי לבדוק' });
        const key = typed || (b.n ? env[`CLOUD_${Number(b.n)}_KEY`] : '');
        if (!/^https:\/\/[^\s]+$/i.test(String(b.url || '')) || !b.model || !key) return send(res, 400, { error: 'חסרים כתובת, מודל או מפתח' });
        const t0 = Date.now();
        try {
          const client = new (require('openai'))({ baseURL: b.url, apiKey: key, timeout: 30000, maxRetries: 0 });
          const r = await client.chat.completions.create({ model: b.model, max_tokens: 300, messages: [{ role: 'user', content: 'ענה במילה אחת בלבד: מה בירת צרפת?' }] });
          const answer = String(r.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim().slice(0, 60);
          return send(res, 200, { ok: Boolean(answer), answer, ms: Date.now() - t0 });
        } catch (err) {
          return send(res, 200, { ok: false, error: `${err.status || ''} ${String(err.message || err)}`.trim().slice(0, 240) });
        }
      }
      // Look & main-screen layout: stored in the database so the phone sees the same choices.
      if (url.pathname === '/api/settings/ui') {
        if (req.method === 'GET') return send(res, 200, JSON.parse((await db.getSetting('ui_prefs')) || '{}'));
        if (req.method === 'POST') {
          const text = JSON.stringify((await readJson(req)) || {});
          if (text.length > 20000) return send(res, 400, { error: 'too large' });
          await db.setSetting('ui_prefs', text);
          return send(res, 200, { ok: true });
        }
      }

      // ---- partner ----
      if (partnerApi && url.pathname === '/api/partner' && req.method === 'GET') return send(res, 200, await partnerApi.get());
      if (partnerApi && url.pathname === '/api/partner/search' && req.method === 'GET') return send(res, 200, await partnerApi.search(url.searchParams.get('q') || ''));
      if (partnerApi && url.pathname === '/api/partner' && req.method === 'POST') {
        try { return send(res, 200, await partnerApi.set(await readJson(req))); } catch (err) { return send(res, 400, { error: err.message }); }
      }

      // ---- care trackers ----
      if (careApi && parts[0] === 'api' && parts[1] === 'care') {
        try {
          if (req.method === 'GET' && parts.length === 2) return send(res, 200, { trackers: await careApi.status(), kinds: careApi.kinds });
          if (req.method === 'POST' && parts.length === 2) return send(res, 200, { id: await careApi.save(await readJson(req)), trackers: await careApi.status() });
          if (req.method === 'POST' && parts[2] === 'order') { await careApi.order((await readJson(req)).ids || []); return send(res, 200, { trackers: await careApi.status() }); }
          if (req.method === 'POST' && parts[2] === 'log' && parts[4] === 'delete') { await careApi.removeLog(parts[3]); return send(res, 200, { trackers: await careApi.status() }); }
          if (req.method === 'POST' && /^\d+$/.test(parts[2] || '') && parts[3] === 'delete') { await careApi.remove(parts[2]); return send(res, 200, { trackers: await careApi.status() }); }
          if (req.method === 'POST' && /^\d+$/.test(parts[2] || '') && parts[3] === 'record') {
            const b = await readJson(req);
            let at = Math.floor(Date.now() / 1000);
            const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(b.time || ''));
            if (m) { // "HH:MM" = the latest such time that is not in the future
              const care = require('./care');
              at = care.localTs(care.dateKey(at), `${m[1].padStart(2, '0')}:${m[2]}`);
              if (at > Date.now() / 1000 + 300) at -= 86400;
            }
            const r = await careApi.record({ tracker_id: Number(parts[2]), item: String(b.item || ''), at, amount: b.amount || null, by: b.by || null, note: b.note || null });
            return send(res, 200, { ...r, trackers: await careApi.status() });
          }
        } catch (err) { return send(res, 400, { error: err.message }); }
      }

      // ---- built-in local AI (localai.js) ----
      if (localai && parts[0] === 'api' && parts[1] === 'ai') {
        try {
          const p = parts[2];
          if (req.method === 'GET' && p === 'status') return send(res, 200, { ...localai.status(), hardware: await localai.hardware(), installed: localai.installed(), setup: localai.setup, engine: process.env.LOCAL_ENGINE || '' });
          if (req.method === 'GET' && p === 'recommend') return send(res, 200, await localai.recommend({ refresh: url.searchParams.get('refresh') === '1' }));
          if (req.method === 'GET' && p === 'catalog') return send(res, 200, await localai.catalog({ refresh: url.searchParams.get('refresh') === '1' }));
          if (req.method === 'GET' && p === 'files') return send(res, 200, await localai.files(String(url.searchParams.get('repo') || '')));
          if (req.method === 'POST') {
            const b = await readJson(req);
            if (p === 'download') return send(res, 200, await localai.downloadModel(b));
            if (p === 'cancel') return send(res, 200, { ok: localai.cancel(b.id) });
            if (p === 'active') {
              localai.setActive(b.role, b.file);
              const live = process.env.LOCAL_ENGINE === 'builtin';
              send(res, 200, { ok: true, restarting: SUPERVISED && live });
              return live ? restartSoon() : undefined;
            }
            if (p === 'remove') { await localai.removeModel(b.file); return send(res, 200, { ok: true }); }
            if (p === 'runtime') return send(res, 200, await localai.installRuntime(b.variant));
            if (p === 'benchmark') return send(res, 200, await localai.benchmark(b.role === 'agent' ? 'agent' : 'main'));
            if (p === 'setup') {
              // One click: the engine + the recommended models; when everything is in place, switch to the built-in engine and restart.
              const run = localai.autoSetup({ main: b.main, agent: b.agent, variant: b.variant, onReady: switchToBuiltin });
              return send(res, 200, run);
            }
            if (p === 'restart') { send(res, 200, { ok: true, restarting: SUPERVISED }); return restartSoon(); }
          }
        } catch (err) { return send(res, 400, { error: err.message }); }
      }

      // ---- phone access (remote.js, Tailscale) - switched on and off only from this computer itself ----
      if (url.pathname.startsWith('/api/remote')) {
        const local = isLocalRequest(req, host);
        if (req.method === 'GET' && url.pathname === '/api/remote') return send(res, 200, { ...(await remote.status()), local });
        if (!local) return send(res, 403, { error: 'אפשר לשנות את זה רק במחשב עצמו' });
        try {
          if (req.method === 'POST' && url.pathname === '/api/remote/enable') {
            const r = await remote.enable();
            // Only your own Tailscale account may open the dashboard (other devices shared into your tailnet may not).
            if (r.ok && r.login) { appSettings.updateEnv({ WEB_ALLOWED_TS_USER: r.login }); process.env.WEB_ALLOWED_TS_USER = r.login; }
            return send(res, 200, r);
          }
          if (req.method === 'POST' && url.pathname === '/api/remote/disable') return send(res, 200, await remote.disable());
          if (req.method === 'POST' && url.pathname === '/api/remote/telegram') {
            const s = await remote.status();
            if (!s.url || !notifyOwner) return send(res, 400, { error: 'אין כתובת או שטלגרם לא מחובר' });
            await notifyOwner(`📱 הכתובת של התוכנה בטלפון (פותחים אחרי שמתחברים ל-Tailscale בטלפון):\n${s.url}`);
            return send(res, 200, { ok: true });
          }
        } catch (err) { return send(res, 400, { error: err.message }); }
      }

      // ---- phone access through the built-in bridge (p2p.js) - changed only from this computer (see COMPUTER_ONLY) ----
      if (url.pathname.startsWith('/api/p2p')) {
        try {
          if (req.method === 'GET' && url.pathname === '/api/p2p/app') return send(res, 200, await p2pLib.appDownload());
          if (req.method === 'GET' && url.pathname === '/api/p2p') return send(res, 200, { ...(await p2p.status()), local: isLocalRequest(req, host) });
          if (req.method === 'POST' && url.pathname === '/api/p2p/enable') {
            appSettings.updateEnv({ P2P_ENABLED: '1' }); process.env.P2P_ENABLED = '1';
            p2p.start();
            return send(res, 200, { ok: true });
          }
          if (req.method === 'POST' && url.pathname === '/api/p2p/disable') {
            appSettings.updateEnv({ P2P_ENABLED: '0' }); process.env.P2P_ENABLED = '0';
            await p2p.stop();
            return send(res, 200, { ok: true });
          }
          if (req.method === 'POST' && url.pathname === '/api/p2p/pair') return send(res, 200, await p2p.pair());
          if (req.method === 'POST' && url.pathname === '/api/p2p/pair/stop') { await p2p.stopPairing(); return send(res, 200, { ok: true }); }
          if (req.method === 'POST' && url.pathname === '/api/p2p/revoke') return send(res, 200, await p2p.revoke((await readJson(req)).nodeId));
        } catch (err) { return send(res, 400, { error: err.message }); }
      }

      // ---- system status, backup, data ----
      if (systemStatus && url.pathname === '/api/system' && req.method === 'GET') return send(res, 200, await systemStatus());
      if (backupNow && url.pathname === '/api/system/backup' && req.method === 'POST') {
        try { return send(res, 200, await backupNow()); } catch (err) { return send(res, 500, { error: err.message }); }
      }
      if (url.pathname === '/api/system/restart' && req.method === 'POST') { send(res, 200, { ok: true, restarting: SUPERVISED }); return restartSoon(); }
      // Open the data folder in Explorer / Finder - only when the dashboard is opened on this computer itself.
      if (url.pathname === '/api/system/open-folder' && req.method === 'POST') {
        const opener = { win32: 'explorer.exe', darwin: 'open' }[process.platform];
        if (!['localhost', '127.0.0.1'].includes(host) || !opener) return send(res, 403, { error: 'זמין רק במחשב עצמו' });
        require('child_process').spawn(opener, [require('./paths').DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/data/clear-archive' && req.method === 'POST') {
        const link = waLink();
        if (!link?.clearArchive) return send(res, 400, { error: 'אין ארכיון במנוע הזה' });
        await link.clearArchive();
        return send(res, 200, { ok: true });
      }

      // GET /api/wa/status - is this computer linked to a WhatsApp account?
      if (req.method === 'GET' && url.pathname === '/api/wa/status') {
        const link = waLink();
        return send(res, 200, link ? link.status() : { engine: 'open-wa', linked: true, needsLink: false });
      }
      // POST /api/wa/pair {phone} - returns the 8-character code to type on the phone (Linked devices > Link with phone number)
      if (req.method === 'POST' && url.pathname === '/api/wa/pair') {
        const link = waLink();
        if (!link) return send(res, 400, { error: 'המנוע עוד לא מוכן. נסה שוב בעוד כמה שניות.' });
        const body = await readJson(req);
        let phone = String(body.phone || '').replace(/[^0-9]/g, '');
        if (phone.startsWith('00')) phone = phone.slice(2);
        else if (phone.startsWith('0')) phone = `972${phone.slice(1)}`; // local Israeli format
        if (phone.length < 9 || phone.length > 15) return send(res, 400, { error: 'המספר לא נראה תקין. הקלד אותו עם קידומת מדינה, למשל 972501234567.' });
        try {
          const code = await link.pair(phone);
          return send(res, 200, { ok: true, code: `${code.slice(0, 4)}-${code.slice(4)}` });
        } catch (err) {
          return send(res, 500, { error: `לא הצלחתי לקבל קוד: ${err.message}. נסה שוב בעוד כמה שניות.` });
        }
      }
      // GET /api/version - lets the dashboard notice when the running bot is older than the files on disk
      if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: SERVER_VERSION, platform: process.platform });
      // GET /api/models - which model does what (and how much the small one filtered)
      if (req.method === 'GET' && url.pathname === '/api/models') {
        return send(res, 200, { ...models, fast: router?.model || null, fast_active: Boolean(router?.active), stats: router?.stats || null, cloud: llm ? llm.status() : [] });
      }

      // GET /api/chats
      if (req.method === 'GET' && url.pathname === '/api/chats') {
        const since = Math.floor(Date.now() / 1000) - 24 * 3600;
        const chats = await db.listChatsWithStats(since);
        for (const c of chats) {
          if (c.selected) c.summary = (await db.getLatestSummary(c.chat_id)) || null;
        }
        return send(res, 200, chats);
      }

      // POST /api/chats/:rowid/local {on: bool} - keep this chat away from cloud models
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'local') {
        const body = await readJson(req);
        await db.setChatLocalOnly(Number(parts[2]), Boolean(body.on));
        return send(res, 200, { ok: true, local_only: body.on ? 1 : 0 });
      }

      // POST /api/chats/:rowid/archive-images {on: bool} - for an unmarked chat: also keep its pictures in the archive (30 days)
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'archive-images') {
        const body = await readJson(req);
        await db.setChatArchiveImages(Number(parts[2]), Boolean(body.on));
        return send(res, 200, { ok: true, archive_images: body.on ? 1 : 0 });
      }
      // POST /api/chats/:rowid/select  {selected: bool}
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'select') {
        const body = await readJson(req);
        const rowid = Number(parts[2]);
        await db.setChatSelected(rowid, Boolean(body.selected));
        // Marking a chat that isn't listened to yet -> start with text only.
        const chat = await db.getChatByRowid(rowid);
        if (body.selected && chat && !String(chat.listen_mode || '').trim()) await db.setChatListenMode(rowid, 'text');
        return send(res, 200, { ok: true });
      }

      // POST /api/chats/:rowid/summarize  {hours}
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'summarize') {
        const body = await readJson(req);
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 24 * 30);
        const detail = body.detail === 'full' ? 'full' : 'short';
        const result = await summarizeChat(chat, { hours, detail });
        if (!result) return send(res, 200, { summary: null });
        return send(res, 200, { summary: await db.getLatestSummary(chat.chat_id), label: result.label });
      }

      // GET /api/chats/:rowid/messages?limit=100
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'messages') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
        return send(res, 200, await db.getRecentMessages(chat.chat_id, limit));
      }

      // GET /api/chats/:rowid/profile - cached, previously-learned member profiles (fast)
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'profile') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const stored = await db.getPersonProfiles(chat.chat_id);
        return send(res, 200, {
          chat_name: chat.name || chat.chat_id,
          members: stored.map((p) => ({
            sender_name: p.sender_name,
            count: p.message_count,
            first_seen: new Date(p.first_seen * 1000).toLocaleDateString('he-IL', { timeZone: events.TZ }),
            last_seen: new Date(p.last_seen * 1000).toLocaleDateString('he-IL', { timeZone: events.TZ }),
            profile: p.profile_text,
            updated_at: p.updated_at,
          })),
        });
      }

      // POST /api/chats/:rowid/profile  {hours?} - relearn now (0 or omitted = all time) and persist
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'profile') {
        const body = await readJson(req);
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const hours = Math.min(Math.max(Number(body.hours) || 0, 0), 24 * 365);
        return send(res, 200, await profileChatMembers(chat, { hours }));
      }

      // GET /api/chats/:rowid/notes
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'notes') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        return send(res, 200, { notes: chat.notes || '' });
      }

      // POST /api/chats/:rowid/notes  {notes}
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'notes') {
        const body = await readJson(req);
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        await db.setChatNotes(chat.rowid, String(body.notes || ''));
        return send(res, 200, { ok: true });
      }

      // GET /api/chats/:rowid/qa?limit=30 - chat memory history
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'qa') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 200);
        return send(res, 200, await db.getChatQa(chat.chat_id, limit));
      }

      // POST /api/chats/:rowid/qa  {question} - ask this chat's own memory-aware chat box
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'qa') {
        const body = await readJson(req);
        const question = String(body.question || '').trim();
        if (!question) return send(res, 400, { error: 'question is required' });
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        return send(res, 200, await chatWithMemory(chat, question));
      }

      // GET /api/search?q=...&hours=168&chat=<rowid> - plain text search (used by the Claude MCP server)
      if (req.method === 'GET' && url.pathname === '/api/search') {
        const hours = Math.min(Math.max(Number(url.searchParams.get('hours')) || 168, 1), 24 * 365);
        const rowid = Number(url.searchParams.get('chat')) || null;
        const chat = rowid ? await db.getChatByRowid(rowid) : null;
        return send(res, 200, await db.searchMessages(url.searchParams.get('q'), { sinceTs: Math.floor(Date.now() / 1000) - hours * 3600, chat_id: chat?.chat_id || null, limit: 60 }));
      }

      // POST /api/ask {question, rowid?, hours?}
      if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readJson(req);
        const question = String(body.question || '').trim();
        if (!question) return send(res, 400, { error: 'question is required' });
        const hours = Math.min(Math.max(Number(body.hours) || 72, 1), 24 * 30);
        let chat = null;
        if (body.rowid) {
          chat = await db.getChatByRowid(Number(body.rowid));
          if (!chat) return send(res, 404, { error: 'chat not found' });
        }
        const result = await askQuestion(question, { chat, hours });
        return send(res, 200, result);
      }

      // Saved media (images / voice) - only files inside ./media, served to the dashboard only.
      if (req.method === 'GET' && parts[0] === 'media' && parts.length === 3) {
        const dir = path.basename(decodeURIComponent(parts[1]));
        const name = path.basename(decodeURIComponent(parts[2]));
        const type = MEDIA_TYPES[path.extname(name).toLowerCase()];
        const file = path.join(MEDIA_DIR, dir, name);
        if (!type || !file.startsWith(MEDIA_DIR + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(file), type, { 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' });
      }

      // GET /api/chats/:rowid/summary - latest stored summary of any chat (opened from the side list)
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'summary') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        return send(res, 200, { summary: (await db.getLatestSummary(chat.chat_id)) || null });
      }

      // POST /api/chats/:rowid/mode {flags: ['text','voice','images','links']}  (empty = not listening)
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'mode') {
        const body = await readJson(req);
        let flags;
        if (Array.isArray(body.flags)) flags = body.flags.filter((f) => LISTEN_FLAGS.includes(f));
        else return send(res, 400, { error: 'bad flags' });
        const value = LISTEN_FLAGS.filter((f) => flags.includes(f)).join(',');
        const before = await db.getChatByRowid(Number(parts[2]));
        await db.setChatListenMode(Number(parts[2]), value);
        // Just started listening -> pull recent history from WhatsApp so there's context right away.
        if (before && !String(before.listen_mode || '').trim() && value) {
          backfillChat(before.chat_id).catch((err) => logError('Backfill failed:', err.message));
        }
        return send(res, 200, { ok: true, listen_mode: value });
      }

      // POST /api/chats/sync - re-read the full chat/group list from WhatsApp
      if (req.method === 'POST' && url.pathname === '/api/chats/sync') {
        return send(res, 200, { ok: true, count: await syncAllChats({ refreshContacts: true }) });
      }

      // POST /api/chats/:rowid/backfill - load recent history of this chat from WhatsApp
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'backfill') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        return send(res, 200, { ok: true, saved: await backfillChat(chat.chat_id) });
      }

      // POST /api/chats/:rowid/work {prefix} - work chat: events get the prefix + full-conversation analysis now
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'work') {
        const body = await readJson(req);
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const prefix = String(body.prefix ?? chat.event_prefix ?? '').trim().slice(0, 40);
        await db.setChatEventPrefix(chat.rowid, prefix);
        if (!prefix) return send(res, 200, { ok: true, prefix: '' });
        if (!String(chat.listen_mode || '').includes('text')) {
          const f = new Set(String(chat.listen_mode || '').split(',').filter(Boolean)); f.add('text');
          await db.setChatListenMode(chat.rowid, [...f].join(','));
        }
        if ((await db.countMessages(chat.chat_id)) < 50) await backfillChat(chat.chat_id).catch(() => 0);
        const result = await analyzeWorkChat({ ...chat, event_prefix: prefix });
        return send(res, 200, { ok: true, prefix, ...result });
      }

      // Memory: GET /api/memory | POST /api/memory/questions/generate | POST /api/memory/questions/:id {answer} or {skip:true}
      //         POST /api/memory/facts {text, subject?, rowid?} | POST /api/memory/facts/:id/delete | POST /api/chats/:rowid/learn
      if (url.pathname === '/api/memory' && req.method === 'GET') {
        const all = await db.listChatsWithStats(0);
        const byChat = new Map(all.map((c) => [c.chat_id, c.rowid]));
        const withRowid = (q) => ({ ...q, chat_rowid: q.chat_id ? byChat.get(q.chat_id) || null : null });
        return send(res, 200, {
          questions: (await db.listQuestions({ status: 'open', limit: 20 })).map(withRowid),
          facts: (await db.listMemoryFacts({ limit: 200, noPerson: true })).map(withRowid),
          groups: all.filter((c) => c.group_profile).map((c) => ({ rowid: c.rowid, name: c.name, is_group: c.is_group, group_profile: c.group_profile, group_profile_at: c.group_profile_at })),
          people: (await Promise.all((await db.listPeople(80)).map(async (p) => ({
            id: p.id, name: p.name, aliases: JSON.parse(p.aliases || '[]'), profile: p.profile, profile_at: p.profile_at, message_count: p.message_count,
            facts: (await db.listPersonFacts(p.id, 30)).map((f) => ({ id: f.id, answer: f.answer, about: f.about, question: f.question, chat_name: f.chat_name })),
          })))).filter((p) => p.profile || p.facts.length || p.message_count >= 8).slice(0, 40),
          questions_hour: memory.QUESTIONS_HOUR,
          last_questions_date: await db.getSetting('last_questions_date'),
        });
      }
      if (url.pathname === '/api/memory/questions/generate' && req.method === 'POST') {
        await memory.generateDailyQuestions({ force: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'memory' && parts[2] === 'questions' && parts.length === 4) {
        const body = await readJson(req);
        const id = Number(parts[3]);
        if (!body.skip && !String(body.answer || '').trim()) return send(res, 400, { error: 'מה התשובה?' });
        if (body.skip) await db.updateQuestion(id, { status: 'skipped' });
        else await memory.answerQuestion(id, String(body.answer || '').slice(0, 600));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/api/memory/facts' && req.method === 'POST') {
        const body = await readJson(req);
        if (!String(body.text || '').trim()) return send(res, 400, { error: 'מה לזכור?' });
        const chat = body.rowid ? await db.getChatByRowid(Number(body.rowid)) : null;
        const fact = await memory.addFact({ chat_id: chat?.chat_id || null, chat_name: chat?.name || null, subject: body.subject, text: String(body.text || '').slice(0, 600) });
        return send(res, 200, fact);
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'memory' && parts[2] === 'facts' && parts[4] === 'delete') {
        await db.updateQuestion(Number(parts[3]), { status: 'deleted' });
        return send(res, 200, { ok: true });
      }
      // POST /api/people/:id/learn - relearn one person from all chats | POST /api/people/:id/fact {text}
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'people' && parts[3] === 'learn') {
        const text = await memory.learnPerson(parts[2], { deep: true });
        return send(res, 200, { profile: text || null, error: text ? undefined : 'מעט מדי הודעות של האדם הזה' });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'people' && parts[3] === 'fact') {
        const body = await readJson(req);
        if (!String(body.text || '').trim()) return send(res, 400, { error: 'מה לזכור?' });
        const person = await db.getPerson(parts[2]);
        if (!person) return send(res, 404, { error: 'person not found' });
        return send(res, 200, await memory.addFact({ subject: person.name, text: String(body.text).slice(0, 600), person_id: person.id }));
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'chats' && parts[3] === 'learn') {
        const chat = await db.getChatByRowid(Number(parts[2]));
        if (!chat) return send(res, 404, { error: 'chat not found' });
        const text = await memory.learnGroup(chat);
        return send(res, 200, { group_profile: text || null, error: text ? undefined : 'מעט מדי הודעות כדי ללמוד את אופי השיחה (צריך לפחות 15)' });
      }

      // Gallery: GET /api/gallery?kind=people|other|all&chat=<rowid>&before=<ts>
      if (url.pathname === '/api/gallery' && req.method === 'GET') {
        const kind = url.searchParams.get('kind') || 'all';
        const rowid = Number(url.searchParams.get('chat')) || null;
        const chat = rowid ? await db.getChatByRowid(rowid) : null;
        const before = Number(url.searchParams.get('before')) || null;
        const items = await db.listGallery({ kind, chat_id: chat?.chat_id || null, before, limit: 60 });
        const counts = Object.fromEntries((await db.galleryCounts()).map((r) => [r.kind, r.n]));
        return send(res, 200, { items, counts });
      }

      // Tasks: GET /api/tasks | POST /api/tasks {text, due_at?} | POST /api/tasks/:id {status?, text?, due_at?}
      if (url.pathname === '/api/tasks' && req.method === 'GET') {
        const all = await db.listTasks(['open', 'suggested']);
        return send(res, 200, { open: all.filter((t) => t.status === 'open'), suggested: all.filter((t) => t.status === 'suggested').slice(0, 30) });
      }
      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        const body = await readJson(req);
        const text = String(body.text || '').trim().slice(0, 300);
        if (!text) return send(res, 400, { error: 'מה המשימה?' });
        const due = body.due_at ? Number(body.due_at) : null;
        const id = await db.addTask({ text, due_at: Number.isFinite(due) ? due : null, status: 'open', origin: 'manual' });
        return send(res, 200, { ok: true, id });
      }
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'tasks' && parts.length === 3) {
        const body = await readJson(req);
        const fields = {};
        if ('status' in body) {
          if (!['open', 'done', 'dismissed', 'suggested'].includes(body.status)) return send(res, 400, { error: 'bad status' });
          fields.status = body.status;
        }
        if ('text' in body) {
          const t = String(body.text || '').trim();
          if (!t) return send(res, 400, { error: 'טקסט חובה' });
          fields.text = t.slice(0, 300);
        }
        if ('due_at' in body) fields.due_at = body.due_at ? Number(body.due_at) || null : null;
        await db.updateTask(Number(parts[2]), fields);
        return send(res, 200, { ok: true });
      }

      // Numbers not saved in the phone: GET /api/unknown | POST /api/unknown/refresh
      if (url.pathname === '/api/unknown' && req.method === 'GET') return send(res, 200, await analyzeUnknown());
      if (url.pathname === '/api/unknown/refresh' && req.method === 'POST') return send(res, 200, await analyzeUnknown({ force: true }));

      // GET /api/love  |  POST /api/love/refresh  |  POST /api/love/chat {rowid}
      if (url.pathname === '/api/love' && req.method === 'GET') {
        return send(res, 200, await analyzeLove());
      }
      // POST /api/love/done {text} - "seen and done": hide this request/task from her card
      if (url.pathname === '/api/love/done' && req.method === 'POST') {
        const body = await readJson(req);
        return send(res, 200, await markLoveDone(body.text));
      }
      if (url.pathname === '/api/love/refresh' && req.method === 'POST') {
        return send(res, 200, await analyzeLove({ force: true }));
      }
      if (url.pathname === '/api/love/chat' && req.method === 'POST') {
        const body = await readJson(req);
        await setLoveChat(Number(body.rowid));
        return send(res, 200, await analyzeLove({ force: true }));
      }

      // GET /api/calendar - status of the read-only calendar connection
      if (req.method === 'GET' && url.pathname === '/api/calendar') {
        if (calendar.isConfigured()) await calendar.refresh().catch(() => {});
        return send(res, 200, calendar.status());
      }

      // POST /api/events/:id {title?, date?, start_time?, end_time?, location?, notes?} - complete missing details
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'events' && parts.length === 3) {
        const body = await readJson(req);
        const ev = await db.getEvent(Number(parts[2]));
        if (!ev) return send(res, 404, { error: 'event not found' });
        const fields = {};
        if ('title' in body) {
          const t = String(body.title || '').trim();
          if (!t) return send(res, 400, { error: 'כותרת חובה' });
          fields.title = t.slice(0, 200);
        }
        if ('date' in body) {
          if (!DATE_RE.test(String(body.date))) return send(res, 400, { error: 'תאריך לא תקין' });
          fields.date = body.date;
        }
        for (const k of ['start_time', 'end_time']) {
          if (k in body) {
            const v = String(body[k] || '');
            if (v && !TIME_RE.test(v)) return send(res, 400, { error: 'שעה לא תקינה' });
            fields[k] = v;
          }
        }
        for (const k of ['location', 'notes']) if (k in body) fields[k] = String(body[k] || '').trim().slice(0, 500);
        await db.updateEvent(ev.id, fields);
        const updated = await db.getEvent(ev.id);
        return send(res, 200, {
          ...updated,
          when: events.formatEventWhen(updated),
          gcal: events.googleCalendarLink(updated),
          conflicts: await calendar.conflictsFor(updated).catch(() => []),
        });
      }

      // GET /api/events?days=14
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const days = Math.min(Number(url.searchParams.get('days')) || 14, 365);
        const today = events.todayIsrael();
        const list = await db.getEventsBetween(today, events.addDays(today, days));
        const out = [];
        for (const ev of list) {
          out.push({
            ...ev,
            when: events.formatEventWhen(ev),
            gcal: events.googleCalendarLink(ev),
            conflicts: await calendar.conflictsFor(ev).catch(() => []),
          });
        }
        return send(res, 200, out);
      }

      // POST /api/events/:id/status {status: added|ignored|pending}
      if (req.method === 'POST' && parts[0] === 'api' && parts[1] === 'events' && parts[3] === 'status') {
        const body = await readJson(req);
        if (!['added', 'ignored', 'pending'].includes(body.status)) return send(res, 400, { error: 'bad status' });
        await db.setEventStatus(Number(parts[2]), body.status);
        return send(res, 200, { ok: true });
      }

      // GET /api/events/:id/ics
      if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'events' && parts[3] === 'ics') {
        const ev = await db.getEvent(Number(parts[2]));
        if (!ev) return send(res, 404, { error: 'event not found' });
        return send(res, 200, events.buildIcs(ev), 'text/calendar; charset=utf-8', {
          'Content-Disposition': `attachment; filename="event-${ev.id}.ics"`,
        });
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      logError('Web request failed:', err.message);
      const { isContextError, CONTEXT_ERROR_HE } = require('./budget');
      return send(res, 500, { error: isContextError(err) ? CONTEXT_ERROR_HE : err.message });
    }
  });

  server.on('error', (err) => {
    logError('Web server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      logError(`Port ${PORT} is already used - another copy of the bot is already running. This copy closes itself (exit 4).`);
      // Two copies fight over the same WhatsApp window; the second one must not keep retrying.
      setTimeout(() => process.exit(4), 500);
    }
  });
  server.listen(PORT, HOST, () => log(`Web dashboard: http://localhost:${PORT}`));
  // Downloads and the one-click setup that a restart interrupted carry on by themselves.
  if (localai?.resumePending) localai.resumePending({ onSetupReady: switchToBuiltin }).catch((e) => logError(`Local AI resume failed: ${e.message}`));
  return server;
}

module.exports = { startWebServer };
