// Links this computer as a WhatsApp linked device (pairing code) and stores everything the phone sends in a
// SEPARATE test database (wa/.data-test) - never in the bot's real database. Prints only counts.
//
//   node scripts/ingest-live.js [--fresh] [--minutes=25]
//
//   --fresh   forget the old login and the old test database first (use after unlinking the device on the phone)
//
// WhatsApp sends the full history only while pairing, so keep this window open until it says the sync is done.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '.data-test');
const authDir = path.resolve(here, '..', '.auth-live');
const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;
const fresh = process.argv.includes('--fresh');
const maxMinutes = Number(arg('minutes', 25));

if (fresh) {
  // Only these two folders, which this script itself created.
  for (const d of [authDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  console.log('נמחקו ההתחברות הישנה ומסד הבדיקה הישן.');
}
fs.mkdirSync(dataDir, { recursive: true });
process.env.BOT_DATA_DIR = dataDir; // before db.js is loaded

const { createSource } = await import('../source.js');
const { createIngest } = await import('../ingest.js');
const db = createRequire(import.meta.url)('../../db.js');

// The phone number is typed without being shown on screen.
function askHidden(prompt) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    process.stdout.write(prompt);
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const done = () => {
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') { done(); return resolve(buf); }
        if (c === '\u0003') { done(); process.exit(0); }                    // Ctrl-C
        if (c === '\u007f' || c === '\b') { if (buf) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        buf += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

let pairingAsked = false;
let finished = false;
let quietTimer = null;
let source;
const t0 = Date.now();

const ingest = createIngest({
  db,
  log: (m) => console.log(`[log] ${m}`),
  onLive: (m) => console.log(`[חי] הודעה נשמרה (${m.type})`),
});

async function summary() {
  const raw = await db.getDb();
  const n = await raw.get('SELECT COUNT(*) n, MIN(timestamp) lo, MAX(timestamp) hi FROM messages');
  const c = await raw.get('SELECT COUNT(*) n, SUM(is_group) g, SUM(CASE WHEN name IS NOT NULL THEN 1 ELSE 0 END) named FROM chats');
  const types = await raw.all('SELECT type, COUNT(*) n FROM messages GROUP BY type ORDER BY n DESC');
  const day = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '-');
  console.log('\n===== מה נשמר במסד הבדיקה (מספרים בלבד) =====');
  console.log(`הודעות: ${n.n}  | טווח: ${day(n.lo)} עד ${day(n.hi)}`);
  console.log(`שיחות: ${c.n} (קבוצות: ${c.g || 0}, עם שם: ${c.named})`);
  console.log(`סוגים: ${types.map((t) => `${t.type}=${t.n}`).join(' ')}`);
  console.log(`נדחו ככפולות: ${ingest.stats.duplicates} | סוגי תוכן לא מוכרים: ${JSON.stringify(ingest.stats.otherKinds)}`);
  console.log(`חבילות היסטוריה: ${ingest.stats.historyBatches} | סנכרון הסתיים: ${ingest.stats.historyDone ? 'כן' : 'לא'} | שגיאות: ${ingest.stats.errors} | זמן: ${Math.round((Date.now() - t0) / 60000)} דקות`);
  await raw.close();
}

async function finish(code = 0) {
  if (finished) return;
  finished = true;
  try { source?.stop(); } catch { /* ignore */ }
  await ingest.idle();
  await summary().catch((e) => console.log(`סיכום נכשל: ${e.message}`));
  process.exit(code);
}

source = createSource({
  authDir,
  ...ingest.handlers,
  onQr: async () => {
    if (pairingAsked) return;
    pairingAsked = true;
    try {
      let n = (await askHidden('מספר הטלפון של החשבון (עם קידומת מדינה, ההקלדה לא תוצג): ')).replace(/\D/g, '');
      if (n.startsWith('0')) n = `972${n.slice(1)}`;
      if (n.length < 9 || n.length > 15) throw new Error('המספר לא נראה תקין');
      const code = await source.socket.requestPairingCode(n);
      console.log(`\nקוד צימוד:  ${code.slice(0, 4)}-${code.slice(4)}`);
      console.log('בטלפון: וואטסאפ > מכשירים מקושרים > קשר מכשיר > "קשר עם מספר טלפון במקום זאת" > הקלד את הקוד.\n');
    } catch (e) {
      console.log(`נכשל בקבלת קוד: ${e.message}`);
      finish(1);
    }
  },
  onState: (s, i) => {
    console.log(`[מצב] ${s}${i?.code ? ` (${i.code})` : ''}${i?.reason ? ` - ${i.reason}` : ''}`);
    if (s === 'open') {
      console.log('מחובר. ההיסטוריה מתקבלת - השאר את החלון פתוח עד לסיכום.');
      ingest.fillGroupNames(source.socket).then(() => console.log('[שמות קבוצות] נשמרו')).catch((e) => console.log(`[שמות קבוצות] נכשל: ${e.message}`));
    }
    if (s === 'logged_out') { console.log('החשבון התנתק.'); finish(1); }
  },
  onHistory: (h) => {
    ingest.handlers.onHistory(h);
    console.log(`[היסטוריה] חבילה: +${h.messages.length} הודעות, +${h.chats.length} שיחות, התקדמות ${h.progress ?? '?'}%`);
    if (h.isLatest) {
      // The last batch has arrived; give any trailing batches 30 seconds, then finish.
      console.log('[היסטוריה] הגיעה החבילה האחרונה. מסיים בעוד 30 שניות...');
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(0), 30000);
    }
  },
});

process.on('SIGINT', () => finish(0));
await source.start();
setTimeout(() => finish(0), maxMinutes * 60 * 1000);
