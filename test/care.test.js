const test = require('node:test');
const assert = require('node:assert');
const care = require('../care');

const at = (date, time) => care.localTs(date, time);
const log = (id, item, ts, extra = {}) => ({ id, item, at: ts, deleted: 0, source: 'manual', ...extra });

test('a sick child: two medicines from the doctor, each with its own schedule and course', () => {
  const t = { id: 1, ...care.normalizeTracker({
    kind: 'meds', name: 'תרופות של נועה', person: 'נועה',
    items: [
      { name: 'אמוקסיצילין', dose: '5 מ"ל', every_hours: 8, start: '2026-11-20', days: 7 },
      { name: 'נורופן', dose: '7.5 מ"ל', times: '08:00, 20:00' },
    ],
  }) };
  const [amoxId, nurofenId] = t.config.items.map((i) => i.id);
  const now = at('2026-11-23', '15:00');
  const s = care.trackerStatus(t, [log(1, amoxId, at('2026-11-23', '06:00')), log(2, nurofenId, at('2026-11-23', '08:10'))], now);
  const amox = s.items.find((i) => i.id === amoxId);
  assert.strictEqual(amox.next_time, '14:00');
  assert.strictEqual(amox.overdue, true, 'next dose was due at 14:00');
  assert.strictEqual(amox.course.day, 4);
  assert.strictEqual(amox.course.total, 21);
  const nuro = s.items.find((i) => i.id === nurofenId);
  assert.strictEqual(nuro.next_time, '20:00', 'the 08:00 dose is covered by the log at 08:10');
  assert.strictEqual(nuro.overdue, false);
  assert.deepStrictEqual(nuro.unlogged, []);
  assert.strictEqual(s.next.name, 'אמוקסיצילין');
});

test('a course ends: no more reminders after the last day', () => {
  const t = { id: 2, ...care.normalizeTracker({ kind: 'meds', name: 'x', items: [{ name: 'אנטיביוטיקה', every_hours: 12, start: '2026-11-10', days: 5 }] }) };
  const s = care.trackerStatus(t, [], at('2026-11-23', '10:00'));
  assert.strictEqual(s.items[0].finished, true);
  assert.strictEqual(s.next, null);
  assert.strictEqual(s.all_finished, true);
});

test('a course that has not started yet points to its first dose', () => {
  const t = { id: 3, ...care.normalizeTracker({ kind: 'meds', name: 'x', items: [{ name: 'טיפות', times: ['09:00'], start: '2026-11-25', days: 3 }] }) };
  const i = care.trackerStatus(t, [], at('2026-11-23', '10:00')).items[0];
  assert.strictEqual(i.not_started, true);
  assert.strictEqual(i.next_at, at('2026-11-25', '09:00'));
  assert.strictEqual(i.overdue, false);
});

test('a missing record is shown as "no record", not as "not given"', () => {
  const t = { id: 4, ...care.normalizeTracker({ kind: 'pet', name: 'רקס', items: [{ name: 'ארוחה', times: ['07:00', '19:00'] }] }) };
  const i = care.trackerStatus(t, [], at('2026-11-23', '12:00')).items[0];
  assert.deepStrictEqual(i.unlogged, ['07:00']);
  assert.strictEqual(i.next_time, '07:00', 'the unrecorded morning meal is still open');
});

test('plants: every N days from the last watering', () => {
  const t = { id: 5, ...care.normalizeTracker({ kind: 'plant', name: 'מרפסת', items: [{ name: 'פיקוס', every_days: 4 }, { name: 'בזיליקום', every_days: 1 }] }) };
  const [ficus, basil] = t.config.items.map((x) => x.id);
  const s = care.trackerStatus(t, [log(1, ficus, at('2026-11-21', '18:00')), log(2, basil, at('2026-11-21', '18:00'))], at('2026-11-23', '12:00'));
  assert.strictEqual(s.items.find((x) => x.id === ficus).overdue, false);
  assert.strictEqual(s.items.find((x) => x.id === basil).overdue, true);
  assert.strictEqual(s.overdue, 1);
});

test('two reports close together are one event (two people wrote that the dog ate)', () => {
  const logs = [log(1, 'a', at('2026-11-23', '07:05'))];
  assert.ok(care.findDuplicate('pet', logs, at('2026-11-23', '07:30')));
  assert.strictEqual(care.findDuplicate('pet', logs, at('2026-11-23', '09:00')), null);
  assert.strictEqual(care.findDuplicate('meds', logs, at('2026-11-23', '07:50')), null, 'medicines: only very close reports merge');
});

test('reminders fire once per due dose and only when fresh', () => {
  const t = { id: 6, ...care.normalizeTracker({ kind: 'meds', name: 'x', items: [{ name: 'סירופ', every_hours: 6 }] }) };
  const id = t.config.items[0].id;
  const now = at('2026-11-23', '12:30');
  const st = [care.trackerStatus(t, [log(1, id, at('2026-11-23', '06:00'))], now)];
  const sent = new Set();
  const first = care.dueReminders(st, sent, now);
  assert.strictEqual(first.length, 1);
  assert.match(care.reminderText(first[0]), /סירופ/);
  sent.add(first[0].key);
  assert.strictEqual(care.dueReminders(st, sent, now).length, 0);
  const late = care.dueReminders(st, new Set(), at('2026-11-23', '17:00'));
  assert.strictEqual(late.length, 0, 'more than 3 hours late: no "fresh" reminder');
});

test('bad settings are refused with a clear reason', () => {
  assert.throws(() => care.normalizeTracker({ kind: 'meds', items: [] }), /לפחות פריט/);
  assert.throws(() => care.normalizeTracker({ kind: 'meds', items: [{ name: 'x' }] }), /חסר תזמון/);
  assert.throws(() => care.normalizeTracker({ kind: 'meds', items: [{ name: 'x', times: '25:00' }] }), /לא תקינה/);
  const ok = care.normalizeTracker({ kind: 'feeding', name: 'תינוק', per_day: 6, items: [{ name: 'בקבוק', every_hours: 3 }] });
  assert.deepStrictEqual([ok.config.unit, ok.config.track_amount, ok.config.per_day], ['מ"ל', true, 6]);
});
