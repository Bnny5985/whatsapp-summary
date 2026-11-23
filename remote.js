// Phone access through Tailscale (a free private network between your own devices).
// The dashboard stays bound to 127.0.0.1; `tailscale serve` publishes it only inside your own tailnet, over HTTPS,
// and tells the dashboard who is connecting - web.js lets in only your own Tailscale login (WEB_ALLOWED_TS_USER).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DOWNLOAD_URL = 'https://tailscale.com/download';

function findTailscale() {
  if (process.platform !== 'win32') return 'tailscale';
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  for (const d of dirs) {
    const exe = path.join(d, 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function run(exe, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err?.code }));
  });
}

function createRemote({ port, log = () => {} }) {
  const target = `http://127.0.0.1:${port}`;

  async function status() {
    const exe = findTailscale();
    if (!exe) return { installed: false, download: DOWNLOAD_URL };
    const st = await run(exe, ['status', '--json']);
    let j = null;
    try { j = JSON.parse(st.out); } catch { /* not running */ }
    if (!j || j.BackendState !== 'Running' || !j.Self) return { installed: true, running: false, state: j?.BackendState || 'Stopped' };
    const dns = String(j.Self.DNSName || '').replace(/\.$/, '');
    const login = j.User?.[j.Self.UserID]?.LoginName || '';
    const sv = await run(exe, ['serve', 'status', '--json']);
    let handlers = {};
    try { handlers = JSON.parse(sv.out || '{}').Web?.[`${dns}:443`]?.Handlers || {}; } catch { /* no serve config */ }
    const proxy = handlers['/']?.Proxy || '';
    const ours = proxy.replace(/\/$/, '') === target || proxy.replace(/\/$/, '') === `http://localhost:${port}`;
    return {
      installed: true, running: true, login, dns,
      url: ours ? `https://${dns}` : null,
      other: !ours && proxy ? proxy : null, // the address is already used for something else on this computer
      allowed_user: process.env.WEB_ALLOWED_TS_USER || '',
    };
  }

  /** Publish the dashboard inside the tailnet. Returns { ok, url } or { ok:false, enable_url } when Serve must be switched on once. */
  async function enable() {
    const exe = findTailscale();
    if (!exe) throw new Error('Tailscale לא מותקן');
    const before = await status();
    if (!before.running) throw new Error('Tailscale לא מחובר. פתח אותו והתחבר לחשבון שלך');
    const r = await run(exe, ['serve', '--bg', target], 25000);
    const text = `${r.out}\n${r.err}`;
    // First time on a tailnet: Tailscale asks to turn "Serve" on once in the browser.
    const enableUrl = (text.match(/https:\/\/login\.tailscale\.com\/[^\s]+/) || [])[0];
    const after = await status();
    if (after.url) { log(`Phone access on: ${after.url}`); return { ok: true, ...after }; }
    if (enableUrl) return { ok: false, enable_url: enableUrl };
    throw new Error(text.trim().split('\n').slice(-2).join(' ').slice(0, 200) || 'Tailscale לא הצליח להפעיל את הכתובת');
  }

  async function disable() {
    const exe = findTailscale();
    if (!exe) return { ok: true };
    const s = await status();
    if (s.url) await run(exe, ['serve', '--https=443', 'off']);
    log('Phone access off');
    return { ok: true };
  }

  return { status, enable, disable };
}

module.exports = { createRemote, findTailscale, DOWNLOAD_URL };
