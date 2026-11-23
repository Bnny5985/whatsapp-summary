/* Tracker cards on the main screen (medicines, baby/pet feeding, plants, custom reminders).
   Uses the page's helpers: $, esc, api, toast (ui.html). */
(() => {
  'use strict';
  const box = $('#care');
  if (!box) return;
  const VERB = { meds: 'ניתן', feeding: 'אכל/ה', pet: 'הואכל', plant: 'הושקה', custom: 'בוצע' };
  let trackers = [];
  let openForm = null; // "trackerId:itemId" whose details form is open

  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const nowHHMM = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

  function itemLine(t, i) {
    const key = `${t.id}:${i.id}`;
    const state = i.finished ? '<span class="st-badge ok">הטיפול הסתיים</span>'
      : i.not_started ? `<span class="st-badge">מתחיל ${esc(i.next_time || '')}</span>`
      : i.next_time ? `<span class="care-next ${i.overdue ? 'due' : ''}">${i.overdue ? 'עכשיו' : 'הבא'}: ${esc(i.next_time)}</span>` : '';
    const last = i.last_time ? `אחרון: ${esc(i.last_time)}${i.last_amount ? ` · ${esc(i.last_amount)}${t.unit ? ` ${esc(t.unit)}` : ''}` : ''}${i.last_by ? ` · ${esc(i.last_by)}` : ''}` : 'אין רישום עדיין';
    const course = i.course ? `<div class="s">יום ${i.course.day} מתוך ${i.course.days}${i.course.total ? ` · ${i.course.given}/${i.course.total} מנות` : ''} · עד ${esc(i.course.end.split('-').reverse().slice(0, 2).join('/'))}</div>` : '';
    const unlogged = i.unlogged.length ? `<div class="s care-unlogged" title="לא נרשם. ייתכן שניתן ולא סומן">אין רישום ל-${i.unlogged.map(esc).join(', ')}</div>` : '';
    const needsForm = t.track_amount || t.track_by;
    return `<div class="care-item ${i.overdue ? 'is-due' : ''}">
      <div class="grow"><div class="t">${esc(i.name)}${i.dose ? ` <span class="meta">· ${esc(i.dose)}</span>` : ''}</div>
        <div class="s">${esc(i.schedule)} · ${last}${i.today_count ? ` · היום: ${i.today_count}` : ''}</div>${course}${unlogged}
        ${i.notes ? `<div class="s">📝 ${esc(i.notes)}</div>` : ''}</div>
      <div class="care-actions">${state}
        ${i.finished ? '' : `<button class="btn btn-sm ${i.overdue ? 'btn-primary' : ''}" type="button" data-rec="${t.id}" data-item="${esc(i.id)}">✓ ${VERB[t.kind] || 'בוצע'}</button>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" data-more="${key}" title="${needsForm ? 'שעה, כמות ומי' : 'שעה אחרת'}">⋯</button>`}</div>
      ${openForm === key ? `<div class="care-form" data-form="${key}">
        <label class="st-field">שעה<input class="field" type="time" data-ff="time" value="${nowHHMM()}"></label>
        ${t.track_amount ? `<label class="st-field">כמות${t.unit ? ` (${esc(t.unit)})` : ''}<input class="field" data-ff="amount" inputmode="decimal" placeholder="${t.kind === 'feeding' ? '120' : ''}"></label>` : ''}
        ${t.track_by ? `<label class="st-field">מי<input class="field" data-ff="by" maxlength="30" placeholder="אמא / אבא"></label>` : ''}
        <button class="btn btn-primary btn-sm" type="button" data-save="${t.id}" data-item="${esc(i.id)}">שמור</button></div>` : ''}
    </div>`;
  }

  function card(t) {
    const head = `${esc(t.icon)} ${esc(t.name)}${t.person ? ` <span class="meta">· ${esc(t.person)}</span>` : ''}`;
    const sub = t.all_finished ? 'כל הטיפולים הסתיימו' : t.next ? `${t.next.overdue ? '⏰ עכשיו' : 'הבא'}: ${esc(t.next.name)} ב-${esc(t.next.time)}` : '';
    const perDay = t.kind === 'feeding' && t.per_day ? ` · ${t.today.length}/${t.per_day} היום` : '';
    const log = t.today.length ? `<details class="care-log"><summary>היום (${t.today.length})</summary>${t.today.map((l) => `
      <div class="care-log-row"><span>${esc(l.time)}</span><span class="grow">${esc(l.name)}${l.amount ? ` · ${esc(l.amount)}${t.unit ? ` ${esc(t.unit)}` : ''}` : ''}${l.by ? ` · ${esc(l.by)}` : ''}${l.source === 'whatsapp' ? ' · 💬' : ''}${l.merged ? ` <span class="meta" title="נרשם כמה פעמים ואוחד">(×${l.merged + 1})</span>` : ''}</span>
      <button class="btn btn-ghost btn-icon btn-sm" type="button" data-del-log="${l.id}" title="מחק רישום">✕</button></div>`).join('')}</details>` : '';
    return `<article class="care-card card ${t.overdue ? 'is-due' : ''}" data-tracker="${t.id}">
      <div class="care-head"><div class="grow"><div class="t">${head}</div><div class="s">${sub}${perDay}</div></div>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" data-open-settings="care" title="עריכה">✎</button></div>
      ${t.items.map((i) => itemLine(t, i)).join('')}${log}</article>`;
  }

  function render() {
    box.innerHTML = trackers.length ? trackers.map(card).join('')
      : `<div class="empty">אין עדיין מעקבים. אפשר להוסיף תרופות לילד חולה, האכלת תינוק, חיית מחמד או השקיית צמחים.
         <div style="margin-top:10px"><button class="btn btn-sm" type="button" data-open-settings="care">+ מעקב חדש</button></div></div>`;
  }

  async function load() {
    try { trackers = (await api('/api/care')).trackers; render(); }
    catch (err) { box.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
  }

  async function record(id, item, extra = {}) {
    const t = trackers.find((x) => String(x.id) === String(id));
    const r = await post(`/api/care/${id}/record`, { item, ...extra });
    trackers = r.trackers; openForm = null; render();
    const name = t?.items.find((i) => i.id === item)?.name || '';
    toast(r.merged ? `כבר נרשם לפני רגע (${name}). אוחד לרישום אחד.` : `✓ נרשם: ${name}`);
  }

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.rec) await record(b.dataset.rec, b.dataset.item);
      if (b.dataset.more) { openForm = openForm === b.dataset.more ? null : b.dataset.more; render(); box.querySelector(`[data-form="${CSS.escape(b.dataset.more)}"] input`)?.focus(); }
      if (b.dataset.save) {
        const form = b.closest('[data-form]');
        const v = (f) => form.querySelector(`[data-ff="${f}"]`)?.value?.trim() || undefined;
        await record(b.dataset.save, b.dataset.item, { time: v('time'), amount: v('amount'), by: v('by') });
      }
      if (b.dataset.delLog && confirm('למחוק את הרישום?')) { trackers = (await post(`/api/care/log/${b.dataset.delLog}/delete`)).trackers; render(); }
    } catch (err) { toast(err.message, true); }
  });

  window.loadCare = load;
  load();
  setInterval(() => { if (!openForm && !document.hidden) load(); }, 60000);
})();
