// Baby-meal parser for a WhatsApp chat linked to a feeding tracker (care.js): understands "אכל 14:30",
// "14:30 120 מ\"ל", "אכל ב-3", "אכל עכשיו", "אכל לפני חצי שעה" (times are often written after the fact). Israel time.
const { localToUtc } = require('./calendar');
const TZ = 'Asia/Jerusalem';

const CFG = {
  perDay: Number(process.env.FEEDS_PER_DAY || 5),
  minGapHours: Number(process.env.FEED_MIN_GAP_HOURS || 3),
};

// Note: JS \b does not work next to Hebrew letters, so word edges are spelled out explicitly.
const FEED_WORDS = /אכל|סיים|אוכל|ארוח|בקבוק|ינק|הנק|האכל|שתה|שתת|תמ"?ל|מטרנה|סימילאק|נוטרילון|מ"ל|(?:^|[\s\d])מל(?=$|[\s.,!])|\d\s*ml|(?:^|\s)ml(?=$|\s)/i;
const FEED_VERB = /(?:^|[\s,.])(?:אכל|אכלה|האכלתי|האכלנו|ינק|ינקה|שתה|שתתה|סיים|סיימה|בקבוק)(?=$|[\s.,!])/;
const NOT_FEED = /\?\s*$|לא אכל|לא רוצה|סירב/;

function parts(ts) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts * 1000));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
}

const hhmm = (ts) => { const p = parts(ts); return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`; };

// Latest moment with this clock time that is not after the message (+10 min slack).
function resolveClock(msgTs, hour, minute, ambiguous12h) {
  const p = parts(msgTs);
  const candidates = [];
  const hours = ambiguous12h && hour < 12 ? [hour, hour + 12] : [hour];
  for (const h of hours) {
    for (const back of [0, 1]) {
      const base = localToUtc(p.y, p.mo, p.d, h, minute, 0, TZ) / 1000 - back * 86400;
      if (base <= msgTs + 600) candidates.push(base);
    }
  }
  if (!candidates.length) return null;
  const best = Math.max(...candidates);
  return msgTs - best > 20 * 3600 ? null : best; // more than 20h back is not a retro-report
}

function parseFeedMessage(text, msgTs) {
  const t = String(text || '').trim();
  if (!t || NOT_FEED.test(t)) return null;
  const amount = (t.match(/(\d{2,3})\s*(?:מ"ל|מל|ml|סמ"ק)/i) || [])[1] || null;
  const clock = t.match(/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/);
  const onlyTime = /^\s*([01]?\d|2[0-3])[:.][0-5]\d\s*(?:\d{2,3}\s*(?:מ"ל|מל|ml)?)?\s*$/i.test(t);
  const hasWord = FEED_WORDS.test(t);
  if (!hasWord && !onlyTime) return null;

  if (clock) {
    const raw = clock[1];
    const at = resolveClock(msgTs, Number(raw), Number(clock[2]), raw.length === 1 || (Number(raw) <= 12 && !raw.startsWith('0')));
    return at ? { fed_at: at, explicit: 1, amount } : null;
  }
  const hourOnly = t.match(/ב[-־]?\s?([01]?\d|2[0-3])(?![\d:.])(?:\s*(בבוקר|בצהריים|אחה"צ|בערב|בלילה))?/);
  if (hourOnly && hasWord) {
    let h = Number(hourOnly[1]);
    const part = hourOnly[2];
    if (part && /צהריים|אחה"צ|ערב/.test(part) && h < 12) h += 12;
    const at = resolveClock(msgTs, h, 0, !part);
    if (at) return { fed_at: at, explicit: 1, amount };
  }
  const rel = t.match(/לפני\s*(\d+|חצי|רבע|שעה|שעתיים)?\s*(דקות|דק'?|שעה|שעות|שעתיים)?/);
  if (rel && hasWord && (rel[1] || rel[2])) {
    let min = 0;
    const n = rel[1];
    const unit = rel[2] || '';
    if (n === 'חצי') min = 30;
    else if (n === 'רבע') min = 15;
    else if (n === 'שעה' || (!n && unit === 'שעה')) min = 60;
    else if (n === 'שעתיים' || unit === 'שעתיים') min = 120;
    else if (/^\d+$/.test(n || '')) min = Number(n) * (/שע/.test(unit) ? 60 : 1);
    if (min) return { fed_at: msgTs - min * 60, explicit: 1, amount };
  }
  if (hasWord && (FEED_VERB.test(t) || amount || /עכשיו|כרגע|סיים לאכול|אכל\s*\d{2,3}/.test(t))) {
    return { fed_at: msgTs, explicit: 0, amount };
  }
  return null;
}

// Medicines written after a time ("14:00 אקמול"): a separate, smaller timer - when the next dose is allowed.
const MEDS = [
  { re: /נובימול|נובימל/, name: 'נובימול', hours: 4 },
  { re: /אקמול/, name: 'אקמול', hours: 4 },
  { re: /נורופן|נרופן/, name: 'נורופן', hours: 6 },
];
const SOLID = /טעימה|טעם|מוצק|פירה|דייסה|פסטה|ירק|פרי/;   // tasting solid food - not a formula meal
const CLOCK = /(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/;

// One message can hold several lines, each its own entry: "10:20 130\n10:40 50", "14:00 אקמול".
// A number after the time (20-300) is the amount of formula in ml.
function parseFeedLines(text, msgTs) {
  const lines = String(text || '').split(/\n+/).map((l) => l.replace(/[\u200e\u200f]/g, '').trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const clock = line.match(CLOCK);
    if (!clock) continue;
    if (NOT_FEED.test(line)) continue;
    const raw = clock[1];
    const at = resolveClock(msgTs, Number(raw), Number(clock[2]), raw.length === 1 || (Number(raw) <= 12 && !raw.startsWith('0')));
    if (!at) continue;
    const rest = line.replace(clock[0], ' ');
    const num = (rest.match(/(?:^|\D)(\d{2,3})(?!\d)/) || [])[1];
    const amount = num && Number(num) >= 20 && Number(num) <= 300 ? num : null;
    const med = MEDS.find((m) => m.re.test(rest));
    if (med) {
      out.push({ kind: 'med', med: med.name, fed_at: at, explicit: 1, amount: null });
      if (!amount) continue;                       // "14:00 120 נורופן" = a meal too
    }
    if (SOLID.test(rest)) continue;
    // Only the time (+ amount / feeding words) counts - "רופא ב-10:30" is not a meal.
    const leftover = rest.replace(new RegExp(MEDS.map((m) => m.re.source).join('|'), 'g'), ' ').replace(/\d{2,3}/g, ' ').replace(/מ"ל|מ״ל|מל|ml|סמ"ק|תמ"?ל|תמ״ל/gi, ' ').replace(/[\s.,:\-–()!]+/g, '');
    if (leftover && !FEED_WORDS.test(rest)) continue;
    out.push({ kind: 'feed', fed_at: at, explicit: 1, amount });
  }
  if (out.length) return out;
  // No time in the text: the older phrasings ("אכל עכשיו", "אכל לפני חצי שעה", "אכל ב-3").
  const one = parseFeedMessage(text, msgTs);
  return one ? [{ kind: 'feed', ...one }] : [];
}

module.exports = { CFG, parseFeedMessage, parseFeedLines, MEDS, hhmm };
