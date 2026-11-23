// Read-only access to your Google Calendar through its private iCal address
// (Google Calendar > Settings > your calendar > "Secret address in iCal format").
// Used only to spot conflicts with events found in WhatsApp. Nothing is ever written to the calendar.
const https = require('https');

const ICS_URL = (process.env.GOOGLE_CALENDAR_ICS_URL || '').trim();
const DEFAULT_TZ = 'Asia/Jerusalem';
const CACHE_MS = 15 * 60 * 1000;
const WINDOW_BACK_MS = 2 * 24 * 3600 * 1000;
const WINDOW_AHEAD_MS = 120 * 24 * 3600 * 1000;

let cache = { at: 0, events: [], error: null, fetching: null };

function isConfigured() {
  return /^https:\/\/calendar\.google\.com\//.test(ICS_URL) || /^https:\/\//.test(ICS_URL);
}

function download(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return download(new URL(res.headers.location, url).toString(), redirects - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      })
      .on('timeout', function onTimeout() { this.destroy(new Error('timeout')); })
      .on('error', reject);
  });
}

// ---------- time helpers ----------

function tzOffsetMs(utcMs, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const g = (t) => Number(p.find((x) => x.type === t).value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
  } catch {
    return tzOffsetMs(utcMs, DEFAULT_TZ);
  }
}

// Wall-clock time in a time zone -> UTC ms (DST-correct).
function localToUtc(y, mo, d, h = 0, mi = 0, s = 0, tz = DEFAULT_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

function parseIcsDate(value, params) {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (params.VALUE === 'DATE' || h === undefined) {
    return { allDay: true, y: +y, mo: +mo, d: +d, h: 0, mi: 0, s: 0, tz: DEFAULT_TZ, ms: localToUtc(+y, +mo, +d, 0, 0, 0, DEFAULT_TZ) };
  }
  if (z) {
    const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    return { allDay: false, utc: true, ms };
  }
  const tz = params.TZID || DEFAULT_TZ;
  return { allDay: false, y: +y, mo: +mo, d: +d, h: +h, mi: +mi, s: +s, tz, ms: localToUtc(+y, +mo, +d, +h, +mi, +s, tz) };
}

function parseDuration(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

// ---------- ICS parsing ----------

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  const left = line.slice(0, idx);
  const value = line.slice(idx + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const [k, v] = p.split('=');
    if (k) params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function unescapeText(s) {
  return String(s || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseIcs(text) {
  const out = [];
  let cur = null;
  for (const raw of unfold(text)) {
    if (raw === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (raw === 'END:VEVENT') { if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = parseLine(raw);
    if (!l) continue;
    switch (l.name) {
      case 'SUMMARY': cur.summary = unescapeText(l.value); break;
      case 'LOCATION': cur.location = unescapeText(l.value); break;
      case 'UID': cur.uid = l.value; break;
      case 'STATUS': cur.status = l.value.toUpperCase(); break;
      case 'TRANSP': cur.transp = l.value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseIcsDate(l.value, l.params); break;
      case 'DTEND': cur.end = parseIcsDate(l.value, l.params); break;
      case 'DURATION': cur.duration = parseDuration(l.value); break;
      case 'RRULE': cur.rrule = l.value; break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseIcsDate(l.value, l.params); break;
      case 'EXDATE':
        for (const v of l.value.split(',')) {
          const d = parseIcsDate(v, l.params);
          if (d) cur.exdates.push(d.ms);
        }
        break;
      default: break;
    }
  }
  return out;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function expand(ev, fromMs, toMs) {
  if (!ev.start) return [];
  const durMs = ev.end ? ev.end.ms - ev.start.ms : ev.duration ?? (ev.start.allDay ? 86400000 : 3600000);
  const base = {
    title: ev.summary || '(ללא כותרת)', location: ev.location || null, allDay: ev.start.allDay, uid: ev.uid,
    busy: ev.transp !== 'TRANSPARENT',
  };
  if (!ev.rrule) {
    const s = ev.start.ms;
    return s + durMs > fromMs && s < toMs ? [{ ...base, startMs: s, endMs: s + durMs }] : [];
  }
  const rule = Object.fromEntries(ev.rrule.split(';').map((p) => p.split('=')));
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? parseIcsDate(rule.UNTIL, rule.UNTIL.length === 8 ? { VALUE: 'DATE' } : {})?.ms : Infinity;
  const byDay = rule.BYDAY ? rule.BYDAY.split(',').map((d) => DAY_CODES.indexOf(d.replace(/^[+-]?\d+/, ''))).filter((i) => i >= 0) : null;

  // Recurring UTC-based starts: walk in the event's own wall-clock time zone.
  const st = ev.start.utc
    ? (() => { const d = new Date(ev.start.ms + tzOffsetMs(ev.start.ms, DEFAULT_TZ)); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: 0, tz: DEFAULT_TZ }; })()
    : ev.start;
  const results = [];
  let n = 0;
  const ex = new Set(ev.exdates);
  const emit = (y, mo, d) => {
    const s = localToUtc(y, mo, d, st.h, st.mi, st.s, st.tz);
    if (s < ev.start.ms) return true;
    if (s > until || n >= count) return false;
    n += 1;
    if (!ex.has(s) && s + durMs > fromMs && s < toMs) results.push({ ...base, startMs: s, endMs: s + durMs });
    return s < toMs;
  };
  const day0 = Date.UTC(st.y, st.mo - 1, st.d);
  for (let i = 0; i < 2000; i++) {
    if (freq === 'DAILY') {
      const t = new Date(day0 + i * interval * 86400000);
      if (!emit(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())) break;
    } else if (freq === 'WEEKLY') {
      const weekStart = day0 - new Date(day0).getUTCDay() * 86400000 + i * interval * 7 * 86400000;
      const days = byDay && byDay.length ? [...byDay].sort() : [new Date(day0).getUTCDay()];
      let cont = true;
      for (const wd of days) {
        const t = new Date(weekStart + wd * 86400000);
        if (!emit(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())) { cont = false; break; }
      }
      if (!cont) break;
    } else if (freq === 'MONTHLY') {
      const t = new Date(Date.UTC(st.y, st.mo - 1 + i * interval, st.d));
      if (t.getUTCDate() !== st.d) continue;
      if (!emit(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())) break;
    } else if (freq === 'YEARLY') {
      if (!emit(st.y + i * interval, st.mo, st.d)) break;
    } else {
      break;
    }
  }
  return results;
}

async function refresh(force = false) {
  if (!isConfigured()) return cache;
  if (!force && Date.now() - cache.at < CACHE_MS) return cache;
  if (cache.fetching) return cache.fetching;
  cache.fetching = (async () => {
    try {
      const text = await download(ICS_URL);
      const raw = parseIcs(text).filter((e) => e.status !== 'CANCELLED');
      const from = Date.now() - WINDOW_BACK_MS;
      const to = Date.now() + WINDOW_AHEAD_MS;
      // Modified single instances of a recurring series replace the original occurrence.
      const overrides = raw.filter((e) => e.recurrenceId);
      const overridden = new Set(overrides.map((e) => `${e.uid}|${e.recurrenceId.ms}`));
      const list = [];
      for (const e of raw) {
        for (const occ of expand(e.recurrenceId ? { ...e, rrule: null } : e, from, to)) {
          if (!e.recurrenceId && overridden.has(`${e.uid}|${occ.startMs}`)) continue;
          list.push(occ);
        }
      }
      list.sort((a, b) => a.startMs - b.startMs);
      cache = { at: Date.now(), events: list, error: null, fetching: null };
    } catch (err) {
      cache = { ...cache, at: Date.now(), error: err.message, fetching: null };
    }
    return cache;
  })();
  return cache.fetching;
}

// Returns calendar entries that clash with a WhatsApp-detected event.
// kind: 'overlap' (times overlap) or 'same_day' (all-day entry, or the new event has no time yet).
async function conflictsFor(ev) {
  if (!isConfigured() || !ev?.date) return [];
  const c = await refresh();
  const [y, mo, d] = ev.date.split('-').map(Number);
  const dayStart = localToUtc(y, mo, d, 0, 0, 0, DEFAULT_TZ);
  const dayEnd = dayStart + 86400000;
  let s = null;
  let e = null;
  if (ev.start_time) {
    const [h, mi] = ev.start_time.split(':').map(Number);
    s = localToUtc(y, mo, d, h, mi, 0, DEFAULT_TZ);
    if (ev.end_time) {
      const [eh, emi] = ev.end_time.split(':').map(Number);
      e = localToUtc(y, mo, d, eh, emi, 0, DEFAULT_TZ);
    }
    if (!e || e <= s) e = s + 3600000;
  }
  const out = [];
  for (const ce of c.events) {
    if (!ce.busy) continue;
    if (ce.endMs <= dayStart || ce.startMs >= dayEnd) continue;
    let kind = 'same_day';
    if (s !== null && !ce.allDay && ce.startMs < e && ce.endMs > s) kind = 'overlap';
    else if (s !== null && !ce.allDay) continue; // same day but no time overlap - not a conflict
    out.push({ kind, title: ce.title, location: ce.location, all_day: ce.allDay, start: fmt(ce.startMs), end: fmt(ce.endMs) });
  }
  return out;
}

function fmt(ms) {
  return new Intl.DateTimeFormat('he-IL', { timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

function status() {
  return {
    configured: isConfigured(),
    ok: isConfigured() && !cache.error && cache.at > 0,
    error: cache.error,
    last_sync: cache.at ? Math.floor(cache.at / 1000) : null,
    count: cache.events.length,
  };
}

module.exports = { isConfigured, refresh, conflictsFor, status, parseIcs, expand, localToUtc };
