// Event extraction from WhatsApp messages + calendar helpers (Google Calendar link / .ics file).
const TZ = 'Asia/Jerusalem';
const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// Cheap pre-filter so we only send messages that might contain a date/time to the LLM.
const DATE_HINT = /\d|מחר|היום|הערב|מחרתיים|בבוקר|בערב|בצהריים|שבוע|חודש|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת|ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|תאריך|בשעה|אסיפה|פגישה|יום הולדת|מסיבה|טיול|אירוע|ישיבה|הרצאה|כנס|מפגש|דדליין|עד ה|להגיש|תשלום|זום|zoom|meet/i;

function looksLikeItMayHaveEvent(text) {
  return typeof text === 'string' && text.trim().length >= 8 && DATE_HINT.test(text);
}

// ---------- date helpers (always in Israel time) ----------

function israelParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekdayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    hour: Number(get('hour')),
    weekday: weekdayIdx,
  };
}

function todayIsrael() {
  return israelParts().date;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function formatDateHe(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `יום ${HEB_DAYS[weekdayOf(dateStr)]}, ${d}.${m}.${y}`;
}

function formatEventWhen(ev) {
  let s = formatDateHe(ev.date);
  if (ev.start_time) s += ` · ${ev.start_time}${ev.end_time ? `–${ev.end_time}` : ''}`;
  else s += ' · כל היום';
  return s;
}

// ---------- LLM extraction ----------

function buildPrompt({ text, messageDate, chatName, senderName, context }) {
  const p = israelParts(messageDate);
  const ctx = context && context.length
    ? `\nהודעות קודמות בשיחה (להקשר בלבד, אל תחלץ מהן):\n${context.join('\n')}\n`
    : '';
  return `ההודעה נשלחה ב: יום ${HEB_DAYS[p.weekday]}, ${p.date} בשעה ${p.time} (שעון ישראל).
קבוצה: ${chatName || 'לא ידוע'}
שולח: ${senderName || 'לא ידוע'}
${ctx}
ההודעה לניתוח:
"""
${text}
"""

חלץ מההודעה אירועים, פגישות, מועדים או דדליינים עתידיים עם תאריך ברור (או שניתן להסיק בוודאות).
חשב תאריכים יחסיים ("מחר", "ביום שלישי הבא", "בעוד שבועיים") ביחס לתאריך שבו ההודעה נשלחה.
אם אין אירוע כזה - החזר רשימה ריקה. אל תמציא אירועים.

בנוסף, חלץ משימות מעשיות שמבקשים ממני (המשתמש) לעשות - או שמבקשים מכל חברי הקבוצה לעשות (להביא, לשלם, להירשם, לקנות, לשלוח, לאשר, להחזיר תשובה).
אם השולח הוא "אני" והוא מתחייב לעשות משהו - גם זו משימה. אם אין משימות - רשימה ריקה.

החזר JSON בלבד, בלי שום טקסט נוסף, בפורמט:
{"events":[{"title":"כותרת קצרה בעברית","date":"YYYY-MM-DD","start_time":"HH:MM או null","end_time":"HH:MM או null","location":"מקום או null","notes":"פרט חשוב קצר או null","confidence":0.0-1.0}],
 "tasks":[{"text":"משימה קצרה בציווי, למשל: לשלם 50 ש״ח לטיול","due_date":"YYYY-MM-DD או null","due_time":"HH:MM או null","confidence":0.0-1.0}]}`;
}

// Some local models drift into a fabricated "next turn" of dialogue after a valid JSON reply
// (chat-template mismatch); cut that off first so a second, hallucinated JSON blob can't be parsed.
const DRIFT_MARKER_RE = /\n\s*\[?(?:Human|User|Instruct(?:ion)?|AI|Assistant)\]?\s*:/i;

function parseJsonLoose(raw) {
  if (!raw) return null;
  const driftMatch = raw.match(DRIFT_MARKER_RE);
  let s = (driftMatch ? raw.slice(0, driftMatch.index) : raw).replace(/```(?:json)?/gi, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first === -1 || last === -1) return null;
  s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const cleanStr = (v) => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null' ? v.trim() : null);
const cleanTime = (v) => {
  const s = cleanStr(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
};

function normalizeEvents(parsed, minConfidence = 0.5) {
  const list = Array.isArray(parsed?.events) ? parsed.events : [];
  const today = todayIsrael();
  const maxDate = addDays(today, 400);
  return list
    .map((e) => ({
      title: cleanStr(e.title),
      date: cleanStr(e.date),
      start_time: cleanTime(e.start_time),
      end_time: cleanTime(e.end_time),
      location: cleanStr(e.location),
      notes: cleanStr(e.notes),
      confidence: typeof e.confidence === 'number' ? e.confidence : Number(e.confidence) || 0.6,
    }))
    .filter((e) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ''))
    .filter((e) => e.date >= today && e.date <= maxDate)
    .filter((e) => e.confidence >= minConfidence)
    .map((e) => (e.end_time && e.start_time && e.end_time <= e.start_time ? { ...e, end_time: null } : e));
}

// Tasks found in the same extraction call (no extra model call). due_at = unix seconds, Israel time.
function normalizeTasks(parsed, minConfidence = 0.6) {
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const today = todayIsrael();
  return list
    .map((t) => {
      const text = cleanStr(typeof t === 'string' ? t : t?.text);
      const date = cleanStr(t?.due_date);
      const time = cleanTime(t?.due_time);
      const confidence = typeof t?.confidence === 'number' ? t.confidence : Number(t?.confidence) || 0.7;
      return { text, due_at: dueAtFrom(date, time), confidence, date };
    })
    .filter((t) => t.text && t.text.length <= 200 && t.confidence >= minConfidence)
    .filter((t) => !t.date || t.date >= today)
    .map(({ text, due_at }) => ({ text, due_at }));
}

// "YYYY-MM-DD" + optional "HH:MM" (Israel time) -> unix seconds. No time = end of that day.
function dueAtFrom(date, time) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time ? time.split(':').map(Number) : [23, 59];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offset = (ms) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
    const g = (k) => Number(p.find((x) => x.type === k).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - ms;
  };
  let utc = guess - offset(guess);
  utc = guess - offset(utc);
  return Math.floor(utc / 1000);
}

async function extractEvents(openai, model, info) {
  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 600,
    // Some local models drift into fabricated "next turn" text after answering (chat-template
    // mismatch); cutting them off here stops a second, hallucinated JSON blob from being parsed.
    stop: [
      '\nInstruct:', '\nInstruction:', '\nHuman:', '\nUser:', '\nAI:', '\n###',
      '\n[Instruct]', '\n[Instruction]', '\n[Human]', '\n[User]', '\n[AI]',
    ],
    messages: [
      { role: 'system', content: 'אתה מערכת שמחלצת אירועים ותאריכים מהודעות וואטסאפ בעברית ומחזירה JSON תקין בלבד.' },
      { role: 'user', content: buildPrompt(info) },
    ],
  });
  const raw = response.choices?.[0]?.message?.content || '';
  const parsed = parseJsonLoose(raw);
  const list = normalizeEvents(parsed);
  list.tasks = normalizeTasks(parsed); // extra property - callers that only iterate events are unaffected
  return list;
}

function dedupKey(chat_id, ev) {
  const t = (ev.title || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 25);
  return `${chat_id}|${ev.date}|${ev.start_time || ''}|${t}`;
}

// ---------- calendar output ----------

function compact(dateStr, time) {
  return `${dateStr.replace(/-/g, '')}T${time.replace(':', '')}00`;
}

function endOf(ev) {
  // An end time earlier than the start (e.g. 22:00-01:00) means the event ends the next day.
  if (ev.end_time) return { date: ev.end_time <= ev.start_time ? addDays(ev.date, 1) : ev.date, time: ev.end_time };
  const [h, m] = ev.start_time.split(':').map(Number);
  const total = h * 60 + m + 60;
  const date = total >= 24 * 60 ? addDays(ev.date, 1) : ev.date;
  const mins = total % (24 * 60);
  return { date, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` };
}

function describe(ev) {
  const lines = [];
  if (ev.notes) lines.push(ev.notes);
  if (ev.chat_name) lines.push(`מקור: ${ev.chat_name}`);
  if (ev.source_text) lines.push(`ההודעה: ${ev.source_text.slice(0, 500)}`);
  return lines.join('\n');
}

function googleCalendarLink(ev) {
  let dates;
  if (ev.start_time) {
    const end = endOf(ev);
    dates = `${compact(ev.date, ev.start_time)}/${compact(end.date, end.time)}`;
  } else {
    dates = `${ev.date.replace(/-/g, '')}/${addDays(ev.date, 1).replace(/-/g, '')}`;
  }
  const params = new URLSearchParams({ action: 'TEMPLATE', text: ev.title, dates, ctz: TZ, details: describe(ev).slice(0, 1200) });
  if (ev.location) params.set('location', ev.location);
  return `https://calendar.google.com/calendar/render?${params.toString().replace('%2F', '/')}`;
}

function icsEscape(s = '') {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function buildIcs(ev) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//whatsapp-summary-bot//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:Asia/Jerusalem',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'TZNAME:IDT', 'DTSTART:19700327T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=FR;BYMONTHDAY=23,24,25,26,27,28,29', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0300', 'TZOFFSETTO:+0200', 'TZNAME:IST', 'DTSTART:19701025T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:wa-event-${ev.id}@whatsapp-summary-bot`,
    `DTSTAMP:${stamp}`,
  ];
  if (ev.start_time) {
    const end = endOf(ev);
    lines.push(`DTSTART;TZID=${TZ}:${compact(ev.date, ev.start_time)}`);
    lines.push(`DTEND;TZID=${TZ}:${compact(end.date, end.time)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ev.date.replace(/-/g, '')}`);
    lines.push(`DTEND;VALUE=DATE:${addDays(ev.date, 1).replace(/-/g, '')}`);
  }
  lines.push(`SUMMARY:${icsEscape(ev.title)}`);
  if (ev.location) lines.push(`LOCATION:${icsEscape(ev.location)}`);
  lines.push(`DESCRIPTION:${icsEscape(describe(ev))}`);
  if (ev.start_time) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, 'TRIGGER:-PT1H', 'END:VALARM');
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  TZ,
  looksLikeItMayHaveEvent,
  israelParts,
  todayIsrael,
  addDays,
  formatDateHe,
  formatEventWhen,
  extractEvents,
  dedupKey,
  googleCalendarLink,
  buildIcs,
  // exported for tests
  normalizeEvents,
  normalizeTasks,
  dueAtFrom,
  parseJsonLoose,
};
