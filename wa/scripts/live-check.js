// Live check of the Baileys source: links this computer as a WhatsApp "linked device" with a pairing code,
// listens for a while, and prints ONLY aggregate numbers (counts, date range, message types).
// It never prints message text, names, phone numbers or chat ids, and never writes messages anywhere.
//
//   node scripts/live-check.js [--minutes=10] [--latest]
//
// The login (keys) is stored in wa/.auth-live - treat that folder like a password.
// To undo: on the phone, WhatsApp > Linked devices > pick this device > Log out.
import readline from 'node:readline/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSource } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const authDir = path.resolve(here, '..', '.auth-live');
const minutes = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] || 10);
const latest = process.argv.includes('--latest');

const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };
const day = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '-');

const st = {
  history: { batches: 0, messages: 0, chats: 0, groupChats: 0, oldest: 0, newest: 0, lastProgress: null, isLatest: false, types: {} },
  live: { messages: 0, types: {}, deletes: 0, edits: 0, calls: 0 },
  states: [],
};

let pairingAsked = false;
let reconnects = 0;
let finished = false;
let source;

function summary() {
  const h = st.history;
  console.log('\n===== סיכום (מספרים בלבד) =====');
  console.log(`מצבי חיבור: ${st.states.join(' > ')}`);
  console.log(`היסטוריה: ${h.messages} הודעות ב-${h.batches} חבילות, ${h.chats} שיחות (${h.groupChats} קבוצות)`);
  console.log(`טווח תאריכים של ההיסטוריה: ${day(h.oldest)} עד ${day(h.newest)}  | סיום סנכרון: ${h.isLatest ? 'כן' : 'לא'}`);
  console.log(`סוגי הודעות בהיסטוריה: ${JSON.stringify(h.types)}`);
  console.log(`הודעות חיות: ${st.live.messages} ${JSON.stringify(st.live.types)} | מחיקות: ${st.live.deletes} | עריכות: ${st.live.edits} | שיחות: ${st.live.calls}`);
}

function finish(code = 0) {
  if (finished) return;
  finished = true;
  summary();
  try { source?.stop(); } catch { /* ignore */ }
  setTimeout(() => process.exit(code), 500);
}

async function askNumber() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const raw = await rl.question('מספר הטלפון של החשבון (עם קידומת מדינה, למשל 972501234567): ');
  rl.close();
  let n = raw.replace(/\D/g, '');
  if (n.startsWith('0')) n = `972${n.slice(1)}`; // local Israeli format
  if (n.length < 9 || n.length > 15) throw new Error('המספר לא נראה תקין');
  return n;
}

source = createSource({
  authDir,
  fetchLatestVersion: latest,
  log: (m) => console.log(`[log] ${m}`),
  onQr: async () => {
    // Not linked yet: use a pairing code instead of a QR.
    if (pairingAsked) return;
    pairingAsked = true;
    try {
      const number = await askNumber();
      const code = await source.socket.requestPairingCode(number);
      console.log(`\nקוד צימוד:  ${code.slice(0, 4)}-${code.slice(4)}`);
      console.log('בטלפון: וואטסאפ > מכשירים מקושרים > קשר מכשיר > "קשר עם מספר טלפון במקום זאת" > הקלד את הקוד.\n');
    } catch (e) {
      console.log(`נכשל בקבלת קוד: ${e.message}`);
      finish(1);
    }
  },
  onState: (s, info) => {
    st.states.push(info?.code ? `${s}(${info.code})` : s);
    console.log(`[מצב] ${s}${info?.code ? ` (קוד ${info.code})` : ''}${info?.reason ? ` - ${info.reason}` : ''}`);
    if (s === 'open') console.log(`מחובר. מקשיב ${minutes} דקות... אפשר לבקש שמישהו ישלח הודעה כדי לבדוק הודעות חיות.`);
    if (s === 'reconnecting' && ++reconnects > 6) {
      console.log('יותר מדי ניסיונות חיבור חוזרים. אם הקוד הוא 405 נסה שוב עם --latest.');
      finish(1);
    }
    if (s === 'logged_out') { console.log('החשבון התנתק.'); finish(1); }
  },
  onHistory: ({ messages, chats, progress, isLatest }) => {
    const h = st.history;
    h.batches += 1;
    h.messages += messages.length;
    h.chats += chats.length;
    h.groupChats += chats.filter((c) => c.is_group).length;
    h.lastProgress = progress;
    h.isLatest = h.isLatest || isLatest;
    for (const m of messages) {
      bump(h.types, m.type);
      if (m.timestamp && (!h.oldest || m.timestamp < h.oldest)) h.oldest = m.timestamp;
      if (m.timestamp > h.newest) h.newest = m.timestamp;
    }
    console.log(`[היסטוריה] חבילה ${h.batches}: +${messages.length} הודעות, +${chats.length} שיחות, התקדמות ${progress ?? '?'}%, סה"כ ${h.messages}`);
  },
  onMessage: (m, { live }) => {
    if (!live) return;
    st.live.messages += 1;
    bump(st.live.types, m.type);
    console.log(`[חי] הודעה מסוג ${m.type} (${m.is_group ? 'קבוצה' : 'פרטי'})`);
  },
  onDelete: () => { st.live.deletes += 1; console.log('[חי] הודעה נמחקה'); },
  onEdit: () => { st.live.edits += 1; console.log('[חי] הודעה נערכה'); },
  onCall: () => { st.live.calls += 1; console.log('[חי] שיחה נכנסת (לא נענתה)'); },
});

process.on('SIGINT', () => finish(0));
console.log(`בדיקה חיה של Baileys. תיקיית ההתחברות: ${authDir}${fs.existsSync(authDir) ? ' (קיימת - ננסה להתחבר בלי קוד)' : ''}`);
await source.start();
setTimeout(() => finish(0), minutes * 60 * 1000);
