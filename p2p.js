// Phone access through the built-in peer-to-peer bridge (p2p-bridge, Rust + Iroh). Nothing to install, no account.
// The phone app pairs once by scanning a QR code; after that it reaches this computer from anywhere over QUIC with
// end-to-end encryption (directly through the home router when possible, through an encrypted relay otherwise).
//
// Trust chain: the bridge only accepts phones whose key is in its allowlist (paired_devices.json in the data folder),
// and forwards each request to the dashboard with X-Remote-Peer-Id + X-P2P-Proxy-Secret. The secret is made fresh
// every time the engine starts and is handed to the bridge in its environment only, so no other program can forge it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const EXE = process.platform === 'win32' ? 'p2p-bridge.exe' : 'p2p-bridge';
const SECRET = crypto.randomBytes(24).toString('hex'); // 48 hex characters, new on every engine start
const PEER_RE = /^[0-9a-f]{64}$/;

function findBridge() {
  const candidates = [
    process.env.P2P_BRIDGE_PATH,
    path.join(__dirname, EXE), // installed app: copied next to the engine by scripts/build-engine.js
    path.join(__dirname, 'p2p-bridge', 'target', 'release', EXE), // development
    path.join(__dirname, 'p2p-bridge', 'target', 'debug', EXE),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const enabled = () => process.env.P2P_ENABLED === '1';

// Where the phone app is downloaded: the newest GitHub release (beta included) that carries an Android .apk. Asked from
// GitHub at most every 6 hours; when GitHub cannot be reached, the releases page (the .apk is listed there).
const APP_REPO = 'Bnny5985/whatsapp-summary';
const RELEASES_PAGE = `https://github.com/${APP_REPO}/releases`;
let appCache = null;
async function appDownload({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (appCache && now - appCache.at < 6 * 3600e3) return { ...appCache.value, svg: qrSvg(appCache.value.url) };
  let value = { url: RELEASES_PAGE, version: null, direct: false };
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${APP_REPO}/releases?per_page=15`, { headers: { 'User-Agent': 'whatsapp-summary-desktop', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (const r of await res.json()) {
      const apk = !r.draft && (r.assets || []).find((a) => /\.apk$/i.test(a.name));
      if (apk && /^https:\/\/github\.com\//.test(apk.browser_download_url)) { value = { url: apk.browser_download_url, version: r.tag_name, direct: true }; break; }
    }
    appCache = { at: now, value };
  } catch { /* offline: keep the releases page, and ask again next time */ }
  return { ...value, svg: qrSvg(value.url) };
}

/** The phone's NodeId when the request really came through our bridge, otherwise null. */
function remotePeer(req) {
  const given = Buffer.from(String(req.headers['x-p2p-proxy-secret'] || ''));
  const want = Buffer.from(SECRET);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  const peer = String(req.headers['x-remote-peer-id'] || '');
  return PEER_RE.test(peer) ? peer : null;
}

/** QR code as an SVG string, made here on the computer (no online QR service ever sees the pairing token). */
function qrSvg(text) {
  const qr = require('qrcode-generator')(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

function createP2P({ port, dataDir, log = () => {} }) {
  let child = null;
  let stopping = false;
  let restartTimer = null;
  let failures = 0;
  let nextId = 0;
  const pending = new Map();
  const info = { nodeId: null, relayUrl: null, online: false, error: null };
  const listeners = new Set();

  function onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.event) {
      if (m.event === 'ready') { info.nodeId = m.nodeId; info.error = null; failures = 0; }
      if (m.event === 'online') { info.online = true; info.relayUrl = m.relayUrl || null; }
      if (m.event === 'offline') info.online = false;
      if (m.event === 'paired') log(`Phone paired: ${m.name || m.nodeId.slice(0, 10)}`);
      for (const fn of listeners) { try { fn(m); } catch { /* listener errors are not ours */ } }
      return;
    }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
  }

  function start() {
    if (child) return;
    const bin = findBridge();
    if (!bin) {
      info.error = 'missing';
      log(`Phone access: ${EXE} was not found. In development run "npm run build:p2p" (needs Rust); in the installed app, reinstall the latest version.`);
      return;
    }
    stopping = false;
    const dir = path.join(dataDir, 'p2p');
    fs.mkdirSync(dir, { recursive: true });
    // Only what the bridge needs: never the AI keys or other secrets from this process's environment.
    const env = { P2P_PROXY_SECRET: SECRET, SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME };
    const c = spawn(bin, ['--data-dir', dir, '--port', String(port)], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child = c;
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    c.stderr.setEncoding('utf8');
    c.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => log(l)));
    // Could not start at all (no 'exit' follows): forget the child so the next attempt starts fresh.
    c.on('error', (err) => { info.error = err.message; if (child === c) child = null; for (const [, p] of pending) { clearTimeout(p.timer); p.reject(err); } pending.clear(); });
    c.on('exit', (code) => {
      if (child === c) child = null;
      info.online = false;
      for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error('הגשר נסגר')); }
      pending.clear();
      if (stopping || !enabled()) return;
      // Crashed: try again, waiting longer each time (5s, 10s, ... up to 5 minutes).
      failures += 1;
      info.error = `exited (${code})`;
      const delay = Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6));
      log(`p2p-bridge exited with ${code}; restarting in ${Math.round(delay / 1000)}s`);
      restartTimer = setTimeout(() => { restartTimer = null; start(); }, delay);
    });
  }

  function stop() {
    stopping = true;
    clearTimeout(restartTimer); restartTimer = null;
    const c = child;
    if (!c) return Promise.resolve();
    return new Promise((resolve) => {
      const kill = setTimeout(() => c.kill(), 3000);
      c.once('exit', () => { clearTimeout(kill); resolve(); });
      try { c.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`); c.stdin.end(); } catch { c.kill(); }
    });
  }

  function cmd(name, extra = {}, timeout = 20000) {
    if (!child) return Promise.reject(new Error('הגישה מהטלפון כבויה'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('הגשר לא ענה')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd: name, ...extra })}\n`);
    }).then((r) => { if (!r.ok) throw new Error(r.error || 'שגיאה'); return r; });
  }

  async function status() {
    const base = { available: Boolean(findBridge()), enabled: enabled(), running: Boolean(child), ...info };
    if (!child) return { ...base, devices: [], pairing: null };
    try {
      const s = await cmd('status');
      return { ...base, relayUrl: s.relayUrl || info.relayUrl, devices: s.devices || [], pairing: s.pairing };
    } catch (err) {
      return { ...base, devices: [], pairing: null, error: err.message };
    }
  }

  async function pair() {
    const r = await cmd('pair_start', { ttl: 120 });
    const payload = JSON.stringify(r.qr);
    return { expiresIn: r.expiresIn, qr: r.qr, svg: qrSvg(payload) };
  }

  return {
    start, stop, status, pair,
    stopPairing: () => cmd('pair_stop'),
    revoke: (nodeId) => cmd('revoke', { nodeId: String(nodeId || '') }),
    onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// sessionSecret: for the engine's own tests only (the secret never leaves this process except to the bridge).
module.exports = { createP2P, remotePeer, findBridge, qrSvg, appDownload, enabled, sessionSecret: () => SECRET };
