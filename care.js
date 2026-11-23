// Care trackers: things that have to happen on time - a baby's meals, a sick child's medicines, feeding a pet,
// watering plants. The user can add as many trackers as they like; each holds items with their own schedule:
//
//   { every_hours: 8 }            "every 8 hours" (counted from the last time it was given/done)
//   { times: ['08:00', '20:00'] } fixed times of day
//   { every_days: 3 }             "every 3 days" (plants)
//
// Medicines also have a course: start date + number of days ("5 days of antibiotics"), so the card can show
// "dose 7 of 15" and stop reminding when the course is over.
// Everything here is pure (no database, no clock of its own) so it can be tested.
const TZ = 'Asia/Jerusalem';

const KINDS = {
  feeding: { label: 'האכלת תינוק', icon: '🍼', item: 'ארוחה' },
  meds: { label: 'תרופות', icon: '💊', item: 'תרופה' },
  pet: { label: 'האכלת חיית מחמד', icon: '🐾', item: 'ארוחה' },
  plant: { label: 'השקיית צמחים', icon: '🪴', item: 'צמח' },
  custom: { label: 'תזכורת קבועה', icon: '⏰', item: 'פעולה' },
};

// A log entry this close to a fixed time counts as that dose (given a bit early or late).
const SLOT_WINDOW_SEC = 2 * 3600;

// Two reports of the same item this close together are one event (two people wrote "the dog ate", or someone
// pressed "done" twice). They are merged, never counted twice.
const SAME_EVENT_SEC = { feeding: 90 * 60, pet: 60 * 60, meds: 30 * 60, plant: 6 * 3600, custom: 30 * 60 };

/** An existing log entry that the new report most likely describes, or null. */
function findDuplicate(kind, logs, at) {
  const win = SAME_EVENT_SEC[kind] || 30 * 60;
  return logs.filter((l) => !l.deleted && Math.abs(l.at - at) < win).sort((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0] || null;
}

function parts(ts) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts * 1000));
  const g = (t) => Number(p.find((x) => x.type === t).value);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour'), mi: g('minute') };
}
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const p = parts(ts); return `${pad(p.h)}:${pad(p.mi)}`; };
const dateKey = (ts) => { const p = parts(ts); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };

/** Unix time of a local (Israel) date + clock time. */
function localTs(dateStr, time = '00:00') {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  // Start from UTC and correct by the zone offset at that moment (twice, for DST edges).
  let ts = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  for (let i = 0; i < 2; i++) {
    const p = parts(ts);
    const shown = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) / 1000;
    ts -= shown - Date.UTC(y, mo - 1, d, h, mi) / 1000;
  }
  return ts;
}
const addDays = (dateStr, n) => dateKey(localTs(dateStr, '12:00') + n * 86400);

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Clean what the settings screen sent. Throws on anything that cannot be scheduled. */
function normalizeTracker(t) {
  const kind = KINDS[t?.kind] ? t.kind : 'custom';
  const name = String(t?.name || '').trim().slice(0, 60) || KINDS[kind].label;
  const items = (Array.isArray(t?.items) ? t.items : []).map((it, i) => {
    const nm = String(it?.name || '').trim().slice(0, 60);
    if (!nm) throw new Error(`חסר שם ל${KINDS[kind].item} מספר ${i + 1}`);
    const times = (Array.isArray(it.times) ? it.times : String(it.times || '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
    for (const x of times) if (!TIME_RE.test(x)) throw new Error(`השעה "${x}" לא תקינה (צורה: 08:00)`);
    const every_hours = Number(it.every_hours) || null;
    const every_days = Number(it.every_days) || null;
    if (!times.length && !every_hours && !every_days) throw new Error(`ל"${nm}" חסר תזמון: כל כמה שעות, באילו שעות, או כל כמה ימים`);
    if (every_hours && (every_hours < 0.5 || every_hours > 72)) throw new Error(`"כל ${every_hours} שעות" לא נראה נכון`);
    if (every_days && (every_days < 1 || every_days > 60)) throw new Error(`"כל ${every_days} ימים" לא נראה נכון`);
    const start = it.start && /^\d{4}-\d{2}-\d{2}$/.test(it.start) ? it.start : null;
    const days = Number(it.days) || null;
    return {
      id: String(it.id || `i${i + 1}${Date.now().toString(36).slice(-4)}`).slice(0, 24),
      name: nm,
      dose: String(it.dose || '').trim().slice(0, 60) || null,
      notes: String(it.notes || '').trim().slice(0, 200) || null,
      times: times.map((x) => x.padStart(5, '0')).sort(),
      every_hours: times.length ? null : every_hours,
      every_days: times.length || every_hours ? null : every_days,
      start, days: start && days ? Math.min(days, 365) : null,
    };
  });
  if (!items.length) throw new Error('צריך לפחות פריט אחד');
  return {
    kind, name,
    person: String(t?.person || '').trim().slice(0, 40) || null,
    icon: String(t?.icon || KINDS[kind].icon).slice(0, 8),
    remind: t?.remind === false || t?.remind === 0 ? 0 : 1,
    chat_id: kind === 'feeding' && t?.chat_id ? String(t.chat_id) : null,
    config: {
      items,
      // What each record holds besides the time: an amount (with its unit) and who did it.
      unit: String(t?.unit ?? (kind === 'feeding' ? 'מ"ל' : kind === 'pet' ? 'גרם' : '')).trim().slice(0, 12) || null,
      track_amount: t?.track_amount === undefined ? ['feeding', 'pet', 'plant'].includes(kind) : Boolean(t.track_amount),
      track_by: t?.track_by === undefined ? kind !== 'plant' : Boolean(t.track_by),
      ...(kind === 'feeding' ? { per_day: Math.min(Math.max(Number(t?.per_day) || 0, 0), 14) || null } : {}),
    },
  };
}

/** Where one item stands right now. `logs` = this item's log entries (not deleted), any order. */
function itemStatus(item, logs, now, since = 0) {
  const sorted = logs.slice().sort((a, b) => b.at - a.at);
  const last = sorted[0] || null;
  const today = dateKey(now);
  const out = {
    id: item.id, name: item.name, dose: item.dose, notes: item.notes,
    schedule: item.times.length ? `בשעות ${item.times.join(', ')}` : item.every_hours ? `כל ${item.every_hours} שעות` : `כל ${item.every_days} ימים`,
    last_at: last?.at || null, last_time: last ? hhmm(last.at) : null, last_amount: last?.amount || null, last_by: last?.by || null,
    today_count: logs.filter((l) => dateKey(l.at) === today).length,
    next_at: null, next_time: null, overdue: false, finished: false, not_started: false, course: null,
    // Times that passed with nothing written down. This means "no record", NOT "was not given".
    unlogged: [],
  };

  // Course (medicines): from the start date for N days.
  let courseEnd = null;
  if (item.start && item.days) {
    const startTs = localTs(item.start, '00:00');
    courseEnd = localTs(addDays(item.start, item.days), '00:00');
    const perDay = item.times.length || (item.every_hours ? Math.round(24 / item.every_hours) : null);
    const given = logs.filter((l) => l.at >= startTs - SLOT_WINDOW_SEC).length;
    out.course = { start: item.start, days: item.days, end: addDays(item.start, item.days - 1), given, total: perDay ? perDay * item.days : null, day: Math.min(item.days, Math.floor((now - startTs) / 86400) + 1) };
    if (now < startTs) { out.not_started = true; out.next_at = item.times.length ? localTs(item.start, item.times[0]) : startTs; }
    if (now >= courseEnd || (out.course.total && given >= out.course.total)) { out.finished = true; return finish(out); }
  }
  if (out.not_started) return finish(out);

  if (item.times.length) {
    // The next fixed time that was not covered by a log entry near it.
    const covered = (slot) => logs.some((l) => Math.abs(l.at - slot) <= SLOT_WINDOW_SEC);
    for (const t of item.times) {
      const slot = localTs(today, t);
      if (slot + SLOT_WINDOW_SEC < now && slot >= since && !covered(slot) && !(item.start && slot < localTs(item.start, '00:00'))) out.unlogged.push(t);
    }
    const day0 = dateKey(now - 86400);
    for (let d = 0; d < 3 && !out.next_at; d++) {
      const day = addDays(day0, d);
      for (const t of item.times) {
        const slot = localTs(day, t);
        if (slot < now - 6 * 3600) continue;            // long past: missed, not "next"
        if (item.start && slot < localTs(item.start, '00:00')) continue;
        if (covered(slot)) continue;
        out.next_at = slot; break;
      }
    }
  } else if (item.every_hours) {
    out.next_at = last ? last.at + item.every_hours * 3600 : now; // never given: due now
  } else if (item.every_days) {
    out.next_at = last ? last.at + item.every_days * 86400 : now;
  }
  if (courseEnd && out.next_at && out.next_at >= courseEnd) { out.next_at = null; out.finished = true; }
  out.overdue = Boolean(out.next_at && out.next_at <= now);
  return finish(out);

  function finish(o) {
    if (o.next_at) o.next_time = dateKey(o.next_at) === today ? hhmm(o.next_at) : `${dateKey(o.next_at).slice(8)}/${dateKey(o.next_at).slice(5, 7)} ${hhmm(o.next_at)}`;
    return o;
  }
}

/** A whole tracker card: its items, the most urgent one first, and today's log. */
function trackerStatus(tracker, logs, now = Math.floor(Date.now() / 1000)) {
  const live = logs.filter((l) => !l.deleted);
  const items = tracker.config.items.map((it) => itemStatus(it, live.filter((l) => l.item === it.id), now, Number(tracker.created_at) || 0));
  const active = items.filter((i) => !i.finished && i.next_at);
  const next = active.sort((a, b) => a.next_at - b.next_at)[0] || null;
  const today = dateKey(now);
  return {
    id: tracker.id, kind: tracker.kind, name: tracker.name, person: tracker.person, icon: tracker.icon, remind: Boolean(tracker.remind),
    chat_id: tracker.chat_id || null, per_day: tracker.config.per_day || null,
    items, next: next ? { item: next.id, name: next.name, at: next.next_at, time: next.next_time, overdue: next.overdue } : null,
    overdue: items.filter((i) => i.overdue).length,
    all_finished: items.length > 0 && items.every((i) => i.finished),
    today: live.filter((l) => dateKey(l.at) === today).sort((a, b) => b.at - a.at)
      .map((l) => ({ id: l.id, item: l.item, name: items.find((i) => i.id === l.item)?.name || '', time: hhmm(l.at), amount: l.amount, by: l.by || null, source: l.source, merged: l.merged || 0 })),
    unit: tracker.config.unit || null, track_amount: Boolean(tracker.config.track_amount), track_by: Boolean(tracker.config.track_by),
    items_def: tracker.config.items,
  };
}

/** Items that became due and were not announced yet. `sent` = Set of "trackerId:itemId:nextAt" already announced. */
function dueReminders(statuses, sent, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const t of statuses) {
    if (!t.remind) continue;
    for (const i of t.items) {
      if (!i.overdue || i.finished || !i.next_at || now - i.next_at > 3 * 3600) continue; // older than 3h: not a fresh reminder
      const key = `${t.id}:${i.id}:${i.next_at}`;
      if (sent.has(key)) continue;
      out.push({ key, tracker: t, item: i });
    }
  }
  return out;
}

function reminderText({ tracker, item }) {
  const who = tracker.person ? ` (${tracker.person})` : '';
  const verb = { meds: 'הגיע הזמן לתת', feeding: 'הגיע זמן', pet: 'הגיע הזמן לתת', plant: 'הגיע הזמן להשקות', custom: 'תזכורת:' }[tracker.kind] || 'תזכורת:';
  return `${tracker.icon} ${verb} ${item.name}${item.dose ? ` - ${item.dose}` : ''}${who}. מתוכנן ל-${item.next_time}.`;
}

module.exports = { KINDS, normalizeTracker, itemStatus, trackerStatus, dueReminders, reminderText, findDuplicate, localTs, dateKey, hhmm, addDays, SLOT_WINDOW_SEC, SAME_EVENT_SEC };
