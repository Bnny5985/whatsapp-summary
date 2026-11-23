// Desktop shell: one window showing the dashboard, a tray icon, autostart, and the engine supervisor.
// The shell never talks to WhatsApp itself - it only starts/stops the engine (index.js) and shows its web page.
const { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Supervisor } = require('./supervisor');

app.setName('WhatsApp Summary');

// ---------- 1. One copy only ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------- 2. Paths ----------
// Packaged: engine files sit next to the app (resources/engine) and user data in the per-user app-data folder.
// Development: engine is the parent folder, and data stays there unless BOT_DATA_DIR says otherwise
// (so a dev run sees the same database as the bot you already use).
const ENGINE_DIR = app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.resolve(__dirname, '..');
const DATA_DIR = process.env.BOT_DATA_DIR
  ? path.resolve(process.env.BOT_DATA_DIR)
  : app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : ENGINE_DIR;
// The installed app has its own port, so it never collides with a development bot on 3000.
const PORT = Number(process.env.WEB_PORT || (app.isPackaged ? 3210 : 3000));
const DASHBOARD_URL = `http://127.0.0.1:${PORT}`;
const ICON_PATH = path.join(ENGINE_DIR, 'public', 'app.ico');
const START_HIDDEN = process.argv.includes('--hidden');

fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });

// ---------- 3. Engine log (so a crash before the engine's own logger starts is not lost) ----------
const STDIO_LOG = path.join(DATA_DIR, 'logs', 'engine-stdio.log');
try {
  if (fs.existsSync(STDIO_LOG) && fs.statSync(STDIO_LOG).size > 2 * 1024 * 1024) fs.renameSync(STDIO_LOG, `${STDIO_LOG}.old`);
} catch { /* ignore */ }
function logStdio(text) {
  try { fs.appendFileSync(STDIO_LOG, text.endsWith('\n') ? text : `${text}\n`); } catch { /* ignore */ }
}

// ---------- 4. Engine supervisor ----------

const supervisor = new Supervisor({
  command: process.execPath,
  // BOT_ENGINE_ENTRY lets a development run use a stub engine (never honoured in the installed app).
  args: [!app.isPackaged && process.env.BOT_ENGINE_ENTRY ? path.resolve(process.env.BOT_ENGINE_ENTRY) : path.join(ENGINE_DIR, 'index.js')],
  cwd: DATA_DIR,
  env: {
    ELECTRON_RUN_AS_NODE: '1', // run the Electron binary as plain Node: no second Node install needed
    BOT_SUPERVISED: '1',
    BOT_DATA_DIR: DATA_DIR,
    WEB_PORT: String(PORT),
    TZ: 'Asia/Jerusalem',
  },
});
supervisor.on('log', (t) => logStdio(t));
supervisor.on('state', (s) => { logStdio(`[shell] engine state: ${s}`); updateTray(); });

// ---------- 5. Window ----------
let win = null;
let tray = null;
let quitting = false;

const LOADING_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#cbd5e1;font:18px Segoe UI,Arial" dir="rtl">' +
  '<div style="text-align:center"><div style="font-size:28px;margin-bottom:12px">מפעיל את הבוט…</div><div>זה לוקח כמה שניות</div></div>');

function dashboardAnswers() {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/version`, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function loadDashboardWhenReady() {
  for (let i = 0; i < 120 && !quitting; i++) { // up to ~2 minutes
    if (await dashboardAnswers()) {
      if (win) win.loadURL(DASHBOARD_URL);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (win && !quitting) {
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1020;color:#fca5a5;font:18px Segoe UI,Arial" dir="rtl">' +
      '<div style="text-align:center"><div style="font-size:26px;margin-bottom:12px">הבוט לא הגיב</div><div>בדוק את הקובץ logs\\engine-stdio.log בתיקיית הנתונים, או הפעל מחדש מאייקון המגש.</div></div>'));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 900,
    show: !START_HIDDEN,
    backgroundColor: '#0b1020',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    title: 'WhatsApp Summary',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(LOADING_HTML);

  // The page may only ever be the local dashboard; other links open in the normal browser, never inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(DASHBOARD_URL) && !url.startsWith('data:text/html')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Closing the window hides it to the tray; the bot keeps running.
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  loadDashboardWhenReady();
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- 6. Tray ----------
const STATE_TEXT = {
  stopped: 'מופסק',
  starting: 'מתחיל…',
  running: 'פועל',
  waiting: 'ממתין להפעלה מחדש',
  duplicate: 'עותק אחר של הבוט כבר רץ',
};

function updateTray() {
  if (!tray) return;
  const autostartOk = app.isPackaged;
  const menu = Menu.buildFromTemplate([
    { label: `הבוט: ${STATE_TEXT[supervisor.state] || supervisor.state}`, enabled: false },
    { type: 'separator' },
    { label: 'פתח את הדשבורד', click: showWindow },
    { label: 'הפעל מחדש את הבוט', click: () => { logStdio('[shell] restart requested from tray'); supervisor.restart(); } },
    { label: 'פתח את תיקיית הנתונים', click: () => shell.openPath(DATA_DIR) },
    {
      label: autostartOk ? 'הפעל עם Windows' : 'הפעל עם Windows (זמין רק אחרי התקנה)',
      type: 'checkbox',
      enabled: autostartOk,
      checked: autostartOk && app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    },
    { type: 'separator' },
    { label: 'יציאה (עוצר גם את הבוט)', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`WhatsApp Summary - ${STATE_TEXT[supervisor.state] || supervisor.state}`);
}

function createTray() {
  const img = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

// ---------- 7. Lifecycle ----------
app.on('second-instance', showWindow);

// Start with Windows by default (installed app only), once: if the user turns it off in the tray, it stays off.
function enableAutostartOnce() {
  if (!app.isPackaged) return;
  const marker = path.join(DATA_DIR, '.autostart-default');
  if (fs.existsSync(marker)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
  } catch (err) { logStdio(`[shell] autostart default failed: ${err.message}`); }
}

app.whenReady().then(() => {
  enableAutostartOnce();
  createTray();
  createWindow();
  supervisor.start();
});

// Stopping: engine first, then exit.
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  logStdio('[shell] quitting - stopping the engine');
  supervisor.stop(8000)
    .catch(() => {})
    .finally(() => { if (tray) tray.destroy(); app.exit(0); });
});

// A tray app has no reason to quit when its only window closes.
app.on('window-all-closed', () => { /* stay alive in the tray */ });

process.on('uncaughtException', (err) => {
  logStdio(`[shell] uncaught: ${err.stack || err.message}`);
  dialog.showErrorBox('WhatsApp Summary', err.message);
});
