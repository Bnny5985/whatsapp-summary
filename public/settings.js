/* Settings window + look & main-screen layout preferences.
   Uses the page's helpers: $, esc, api, toast, chats (ui.html). Every tab is rendered from the server's state. */
(() => {
  'use strict';
  const dlg = $('#settingsDialog');
  // Which system the computer runs (the texts below name Windows or macOS). Asked once; Windows until the answer arrives.
  let PLATFORM = 'win32';
  fetch('/api/version').then((r) => r.json()).then((v) => { if (v?.platform) PLATFORM = v.platform; }).catch(() => {});
  const isMac = () => PLATFORM === 'darwin';
  const OS_NAME = () => (isMac() ? 'macOS' : 'Windows');
  const STARTS_WITH = () => (isMac() ? 'היא עולה לבד כשנכנסים ל-Mac' : 'היא עולה לבד עם Windows');

  /* ===================== look & layout preferences ===================== */
  const MODULES = [
    { id: 'love', sel: '#loveBlock', label: '💗 בן/בת הזוג' },
    { id: 'care', sel: '#careBlock', label: '💊 מעקבים (תרופות, האכלה, צמחים)' },
    { id: 'today', sel: '#todayBlock', label: '⚡ היום: משימות ומספרים לא שמורים' },
    { id: 'ask', sel: '#askBlock', label: '✨ שאל שאלה' },
    { id: 'events', sel: '#eventsBlock', label: '🗓 אירועים קרובים' },
    { id: 'cards', sel: '#cardsBlock', label: '💬 השיחות שלי' },
    { id: 'gallery', sel: '#galleryBlock', label: '🖼 גלריה' },
    { id: 'chats', sel: '#chatsBlock', label: '☰ כל השיחות' },
    { id: 'memory', sel: '#memoryBlock', label: '🧠 הבוט לומד אותך' },
  ];
  const DEFAULT_PREFS = { theme: 'dark', accent: 'green', text: 100, fx: true, mode: 'simple', modules: MODULES.map((m) => ({ id: m.id, show: 'always' })) };
  const askSection = $('.ask')?.closest('section');
  if (askSection && !askSection.id) askSection.id = 'askBlock';

  let prefs = load();
  function load() {
    try { return normalize(JSON.parse(localStorage.getItem('ui_prefs') || 'null')); } catch { return normalize(null); }
  }
  function normalize(p) {
    const out = { ...DEFAULT_PREFS, ...(p || {}) };
    const known = (Array.isArray(out.modules) ? out.modules : []).filter((m) => MODULES.some((x) => x.id === m.id));
    for (const m of MODULES) if (!known.some((k) => k.id === m.id)) known.push({ id: m.id, show: 'always' });
    out.modules = known;
    return out;
  }
  function applyPrefs() {
    const root = document.documentElement;
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.accent = prefs.accent;
    root.classList.toggle('fx-off', !prefs.fx);
    document.body.style.zoom = String((Number(prefs.text) || 100) / 100);
    prefs.modules.forEach((m, i) => {
      const def = MODULES.find((x) => x.id === m.id);
      const el = def && $(def.sel);
      if (!el) return;
      el.style.order = String(i);
      el.dataset.show = m.show;
      el.classList.toggle('pref-hidden', m.show === 'hidden');
      el.style.display = m.show === 'hidden' ? 'none' : '';
      document.querySelectorAll(`a[href="${def.sel}"]`).forEach((a) => { a.style.display = m.show === 'hidden' ? 'none' : ''; });
    });
    quietCheck();
  }
  async function savePrefs() {
    try { localStorage.setItem('ui_prefs', JSON.stringify(prefs)); } catch { /* private window */ }
    applyPrefs();
    try { await api('/api/settings/ui', { method: 'POST', body: JSON.stringify(prefs) }); } catch (err) { toast(err.message, true); }
  }
  // "Only when there is something new": a block with nothing in it folds to its title line.
  function isEmptyBlock(el) {
    const body = [...el.children].filter((c) => !c.classList.contains('block-head') && !c.classList.contains('neon-line'));
    if (!body.length) return true;
    const text = body.map((c) => c.innerText || '').join(' ').trim();
    if (body.some((c) => c.querySelector('.skeleton'))) return false;
    return !text || body.every((c) => !c.querySelector('.card, .chat-card, .event-hero, li, img, .care-card') || c.querySelector('.empty'));
  }
  function quietCheck() {
    for (const m of prefs.modules) {
      const def = MODULES.find((x) => x.id === m.id);
      const el = def && $(def.sel);
      if (!el || el.dataset.opened === '1') continue;
      el.classList.toggle('is-quiet', m.show === 'new' && isEmptyBlock(el));
    }
  }
  document.addEventListener('click', (e) => {
    const head = e.target.closest('.block.is-quiet .block-head');
    if (head) { const b = head.closest('.block'); b.dataset.opened = '1'; b.classList.remove('is-quiet'); }
  });
  let quietTimer = null;
  new MutationObserver(() => { clearTimeout(quietTimer); quietTimer = setTimeout(quietCheck, 400); }).observe($('main'), { childList: true, subtree: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyPrefs);
  applyPrefs();
  // The server copy wins (the same look on the phone and on the computer).
  api('/api/settings/ui').then((p) => { if (p && Object.keys(p).length) { prefs = normalize(p); try { localStorage.setItem('ui_prefs', JSON.stringify(prefs)); } catch { /* */ } applyPrefs(); } }).catch(() => {});

  /* ===================== the window ===================== */
  const TABS = [
    { id: 'partner', ico: '💗', label: 'בן/בת זוג' },
    { id: 'care', ico: '💊', label: 'מעקבים' },
    { id: 'models', ico: '🧠', label: 'מודלים מקומיים' },
    { id: 'agents', ico: '🤖', label: 'סוכנים', advanced: true },
    { id: 'cloud', ico: '☁️', label: 'ספקי AI בענן (API)' },
    { id: 'privacy', ico: '🔒', label: 'פרטיות' },
    { id: 'telegram', ico: '✈️', label: 'טלגרם' },
    { id: 'phone', ico: '📱', label: 'גישה מהטלפון' },
    { id: 'look', ico: '🎨', label: 'מראה' },
    { id: 'home', ico: '🧩', label: 'מסך ראשי' },
    { id: 'general', ico: '⚙', label: 'כללי' },
    { id: 'system', ico: '🩺', label: 'מצב מערכת' },
  ];
  let current = 'partner';
  let settings = null;
  let pollTimer = null;

  dlg.innerHTML = `<div class="st-wrap"><nav class="st-nav" id="stNav"></nav><section class="st-main" id="stMain"></section></div>`;
  const nav = $('#stNav', dlg);
  const main = $('#stMain', dlg);

  function renderNav(problems = 0) {
    nav.innerHTML = '<h3>⚙ הגדרות</h3>' + TABS.filter((t) => !t.advanced || prefs.mode === 'advanced').map((t) =>
      `<button type="button" data-tab="${t.id}" class="${t.id === current ? 'on' : ''}"><span class="ico">${t.ico}</span>${esc(t.label)}${t.id === 'system' && problems ? '<i class="st-dot" title="יש בעיות"></i>' : ''}</button>`).join('');
  }
  nav.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) show(b.dataset.tab); });

  async function open(tab) {
    settings = await api('/api/settings');
    renderNav();
    if (!dlg.open) dlg.showModal();
    show(tab || current);
    api('/api/system').then((s) => renderNav(s.problems.filter((p) => p.level === 'bad').length)).catch(() => {});
  }
  dlg.addEventListener('close', () => { clearInterval(pollTimer); pollTimer = null; });
  $('#openSettings').addEventListener('click', () => open().catch((err) => toast(err.message, true)));
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-open-settings]'); if (b) open(b.dataset.openSettings).catch((err) => toast(err.message, true)); });

  function show(tab) {
    current = tab;
    clearInterval(pollTimer); pollTimer = null;
    nav.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    main.innerHTML = '<button class="btn btn-ghost btn-icon st-close" type="button" data-close-dialog title="סגור">✕</button><div class="skeleton">טוען...</div>';
    main.scrollTop = 0;
    const body = document.createElement('div');
    Promise.resolve(RENDER[tab](body)).then(() => { main.querySelector('.skeleton')?.remove(); main.appendChild(body); })
      .catch((err) => { main.querySelector('.skeleton').outerHTML = `<p class="error-text">${esc(err.message)}</p>`; });
  }
  const head = (title, sub) => `<h2>${esc(title)}</h2>${sub ? `<p class="st-sub">${sub}</p>` : ''}`;
  const msg = (el, text, kind = '') => { if (el) { el.textContent = text; el.className = `st-msg ${kind}`; } };
  const restarting = (r, el) => { msg(el, r.restarting ? 'נשמר. המנוע מופעל מחדש, הדף יתרענן בעוד כמה שניות…' : 'נשמר. השינוי יחול אחרי הפעלה מחדש של התוכנה.', 'ok'); if (r.restarting) setTimeout(() => location.reload(), 9000); };
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
  const gb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)}GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)}MB` : `${Math.max(1, Math.round((bytes || 0) / 1e3))}KB`);
  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString('he-IL', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' }) : '—');
  const phoneLabel = (p) => { const d = String(p || '').replace(/[^0-9]/g, ''); return d.startsWith('972') && d.length === 12 ? `+972 ${d.slice(3, 5)}-${d.slice(5, 8)}-${d.slice(8)}` : (d ? `+${d}` : ''); };

  const RENDER = {};

  /* ---------- partner ---------- */
  RENDER.partner = async (el) => {
    const p = await api('/api/partner');
    const g = p.gender === 'male';
    el.innerHTML = head('בן/בת הזוג', 'כרטיס בן/בת הזוג במסך הראשי עוקב אחרי מה שמבקשים ממך, משימות, רשימות ושאלות שמחכות לתשובה. הצ׳אט נקרא תמיד ונשאר במחשב.') + `
      <div class="st-sec"><h4>לשון פנייה</h4>
        <div class="st-opts">
          <label class="st-opt"><input type="radio" name="pg" value="female" ${!g ? 'checked' : ''}><b>בת זוג</b><span>"היא ביקשה", "לענות לה"</span></label>
          <label class="st-opt"><input type="radio" name="pg" value="male" ${g ? 'checked' : ''}><b>בן זוג</b><span>"הוא ביקש", "לענות לו"</span></label>
        </div></div>
      <div class="st-sec"><h4>מי ${g ? 'בן הזוג' : 'בת הזוג'}</h4>
        <div id="pCur">${p.chat ? `<div class="st-item"><span style="font-size:22px">💗</span><div class="grow"><div class="t">${esc(p.chat.name || phoneLabel(p.chat.chat_id))}</div><div class="s" dir="ltr">${esc(phoneLabel(p.chat.chat_id))}</div></div><button class="btn btn-ghost btn-sm" type="button" id="pRemove">הסר</button></div>` : '<p class="meta" style="margin:0">עוד לא נבחר.</p>'}</div>
        <div class="st-row" style="margin-top:12px"><input class="field" id="pSearch" style="flex:1" placeholder="חפש לפי השם השמור בוואטסאפ או לפי מספר…" autocomplete="off"></div>
        <div class="st-search-results st-list" id="pResults"></div></div>
      <div class="st-sec"><h4>כינוי (לא חובה)</h4>
        <div class="st-row"><input class="field" id="pName" style="flex:1" maxlength="40" value="${esc(p.name)}" placeholder="איך לקרוא ${g ? 'לו' : 'לה'} בסיכומים, למשל: אהובה"><button class="btn btn-sm" type="button" id="pNameSave">שמור</button></div>
        <div class="st-msg" id="pMsg"></div></div>`;
    el.querySelectorAll('input[name="pg"]').forEach((r) => r.addEventListener('change', async () => {
      await post('/api/partner', { gender: r.value }); toast('✓ נשמר'); show('partner'); if (typeof loadLove === 'function') loadLove().catch(() => {});
    }));
    $('#pRemove', el)?.addEventListener('click', async () => { await post('/api/partner', { id: null }); show('partner'); if (typeof loadLove === 'function') loadLove().catch(() => {}); });
    $('#pNameSave', el).addEventListener('click', async () => { await post('/api/partner', { name: $('#pName', el).value }); msg($('#pMsg', el), '✓ נשמר', 'ok'); });
    let t = null;
    const search = async () => {
      const q = $('#pSearch', el).value.trim();
      const list = await api(`/api/partner/search?q=${encodeURIComponent(q)}`);
      $('#pResults', el).innerHTML = list.length ? list.map((c) => `<div class="st-item pick" data-pick="${esc(c.id)}" data-name="${esc(c.name)}"><span>👤</span><div class="grow"><div class="t">${esc(c.name)}</div><div class="s" dir="ltr">${esc(phoneLabel(c.phone))}</div></div>${c.saved ? '<span class="st-badge ok">שמור בטלפון</span>' : ''}</div>`).join('')
        : `<p class="meta">${q ? 'לא נמצא. נסה חלק מהשם או מהמספר.' : 'אין עדיין אנשי קשר. הם מגיעים מוואטסאפ אחרי החיבור.'}</p>`;
    };
    $('#pSearch', el).addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => search().catch(() => {}), 250); });
    $('#pResults', el).addEventListener('click', async (e) => {
      const c = e.target.closest('[data-pick]'); if (!c) return;
      try { await post('/api/partner', { id: c.dataset.pick, name: $('#pName', el).value || undefined }); toast(`✓ ${c.dataset.name} נבחר/ה`); show('partner'); if (typeof loadLove === 'function') loadLove().catch(() => {}); }
      catch (err) { toast(err.message, true); }
    });
    search().catch(() => {});
  };

  /* ---------- care trackers ---------- */
  const KIND_HELP = {
    meds: { title: 'תרופות', sub: 'לילד חולה (או לכל אחד): כל מה שהרופא נתן, כל תרופה עם המינון והתזמון שלה', item: 'תרופה' },
    feeding: { title: 'האכלת תינוק', sub: 'ארוחות, כמויות, וכמה ארוחות ביום. אפשר לחבר קבוצת וואטסאפ שבה כותבים "אכל 120"', item: 'ארוחה' },
    pet: { title: 'חיית מחמד', sub: 'ארוחות בשעות קבועות, כמה ומי האכיל', item: 'ארוחה' },
    plant: { title: 'צמחים', sub: 'כל צמח וכל כמה ימים משקים אותו', item: 'צמח' },
    custom: { title: 'תזכורת קבועה', sub: 'כל דבר אחר שחוזר על עצמו', item: 'פעולה' },
  };
  RENDER.care = async (el) => {
    const { trackers, kinds } = await api('/api/care');
    el.innerHTML = head('מעקבים', 'אפשר להוסיף כמה מעקבים שרוצים. כל מעקב מופיע ככרטיס במסך הראשי עם הזמן הבא וכפתור "בוצע". כשמגיע הזמן נשלחת תזכורת לטלגרם (אם מחובר). כשאין רישום מוצג "אין רישום", לא "לא ניתן".') + `
      <div class="st-sec"><h4>המעקבים שלך</h4><div class="st-list" id="cList">${trackers.length ? trackers.map((t, i) => `
        <div class="st-item"><span style="font-size:22px">${esc(t.icon)}</span><div class="grow"><div class="t">${esc(t.name)}${t.person ? ` · ${esc(t.person)}` : ''}</div>
        <div class="s">${esc(kinds[t.kind]?.label || '')} · ${t.items.map((x) => esc(x.name)).join(', ')}${t.remind ? ' · 🔔' : ''}</div></div>
        <button class="btn btn-ghost btn-icon" type="button" data-cmove="${i}" data-dir="-1" title="למעלה" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn btn-ghost btn-icon" type="button" data-cmove="${i}" data-dir="1" title="למטה" ${i === trackers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn btn-sm" type="button" data-cedit="${t.id}">עריכה</button>
        <button class="btn btn-ghost btn-sm" type="button" data-cdel="${t.id}">מחק</button></div>`).join('') : '<p class="meta" style="margin:0">אין עדיין מעקבים.</p>'}</div></div>
      <div class="st-sec"><h4>מעקב חדש</h4><div class="st-opts">${Object.entries(KIND_HELP).map(([k, h]) => `<button type="button" class="st-opt" data-cnew="${k}" style="text-align:start"><b>${kinds[k]?.icon || ''} ${h.title}</b><span>${h.sub}</span></button>`).join('')}</div></div>
      <div id="cEditor"></div>`;
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.cnew) editor(el, { kind: b.dataset.cnew, name: '', person: '', remind: true, items: [{ name: '' }] }, kinds);
      if (b.dataset.cedit) { const t = trackers.find((x) => String(x.id) === b.dataset.cedit); editor(el, { ...t, items: t.items_def }, kinds); }
      if (b.dataset.cdel && confirm('למחוק את המעקב? הרישומים שלו יישמרו במסד אבל לא יוצגו.')) { await post(`/api/care/${b.dataset.cdel}/delete`); show('care'); window.loadCare?.(); }
      if (b.dataset.cmove !== undefined) {
        const ids = trackers.map((t) => t.id); const i = Number(b.dataset.cmove); const j = i + Number(b.dataset.dir);
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await post('/api/care/order', { ids }); show('care'); window.loadCare?.();
      }
    });
  };
  function editor(root, t, kinds) {
    const h = KIND_HELP[t.kind];
    const box = $('#cEditor', root);
    const chatOpts = (typeof chats !== 'undefined' ? chats : []).filter((c) => c.name).sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));
    const itemHtml = (it, i) => {
      const mode = it.times?.length ? 'times' : it.every_days ? 'days' : 'hours';
      return `<div class="st-sec" data-item="${i}"><div class="st-grid">
        <label class="st-field">${h.item}<input class="field" data-f="name" value="${esc(it.name || '')}" placeholder="${t.kind === 'meds' ? 'למשל: אמוקסיצילין' : t.kind === 'plant' ? 'למשל: פיקוס' : 'למשל: בקבוק'}"></label>
        ${t.kind === 'meds' || t.kind === 'pet' || t.kind === 'custom' ? `<label class="st-field">מינון / כמות<input class="field" data-f="dose" value="${esc(it.dose || '')}" placeholder="${t.kind === 'meds' ? '5 מ"ל' : ''}"></label>` : ''}
        <label class="st-field">תזמון<select class="select" data-f="mode"><option value="hours" ${mode === 'hours' ? 'selected' : ''}>כל כמה שעות</option><option value="times" ${mode === 'times' ? 'selected' : ''}>בשעות קבועות</option><option value="days" ${mode === 'days' ? 'selected' : ''}>כל כמה ימים</option></select></label>
        <label class="st-field" data-show="hours" ${mode !== 'hours' ? 'hidden' : ''}>כל X שעות<input class="field" type="number" min="0.5" max="72" step="0.5" data-f="every_hours" value="${esc(it.every_hours || '')}" placeholder="8"></label>
        <label class="st-field" data-show="times" ${mode !== 'times' ? 'hidden' : ''}>שעות (מופרדות בפסיק)<input class="field" data-f="times" dir="ltr" value="${esc((it.times || []).join(', '))}" placeholder="08:00, 14:00, 20:00"></label>
        <label class="st-field" data-show="days" ${mode !== 'days' ? 'hidden' : ''}>כל X ימים<input class="field" type="number" min="1" max="60" data-f="every_days" value="${esc(it.every_days || '')}" placeholder="3"></label>
        ${t.kind === 'meds' ? `<label class="st-field">התחלה<input class="field" type="date" data-f="start" value="${esc(it.start || new Date().toLocaleDateString('en-CA', { timeZone: TZ }))}"></label>
        <label class="st-field">כמה ימים (משך הטיפול)<input class="field" type="number" min="1" max="365" data-f="days" value="${esc(it.days || '')}" placeholder="7 (ריק = ללא הגבלה)"></label>` : ''}
        <label class="st-field" style="grid-column:1/-1">הערות<input class="field" data-f="notes" value="${esc(it.notes || '')}" placeholder="${t.kind === 'meds' ? 'אחרי אוכל, לנער לפני שימוש…' : ''}"></label>
      </div><div class="st-row" style="margin-top:8px"><button class="btn btn-ghost btn-sm" type="button" data-irem="${i}">הסר ${h.item}</button></div>
      <input type="hidden" data-f="id" value="${esc(it.id || '')}"></div>`;
    };
    const draw = () => {
      box.innerHTML = `<div class="st-sec st-rec"><h4>${kinds[t.kind]?.icon || ''} ${t.id ? 'עריכת' : 'מעקב חדש:'} ${h.title}</h4>
        <div class="st-grid">
          <label class="st-field">שם המעקב<input class="field" id="ceName" value="${esc(t.name || '')}" placeholder="${t.kind === 'meds' ? 'התרופות של נועה' : h.title}"></label>
          <label class="st-field">בשביל מי (לא חובה)<input class="field" id="cePerson" value="${esc(t.person || '')}" placeholder="נועה / רקס / המרפסת"></label>
          <label class="st-field">אייקון<input class="field" id="ceIcon" value="${esc(t.icon || kinds[t.kind]?.icon || '')}" maxlength="4"></label>
          ${t.kind === 'feeding' ? `<label class="st-field">ארוחות ביום (לא חובה)<input class="field" type="number" min="0" max="14" id="cePerDay" value="${esc(t.per_day || '')}"></label>
          <label class="st-field">קבוצת וואטסאפ לרישום אוטומטי (לא חובה)<select class="select" id="ceChat"><option value="">בלי, רק ידני</option>${chatOpts.map((c) => `<option value="${esc(c.chat_id)}" ${c.chat_id === t.chat_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
        </div>
        <div class="st-row" style="margin-top:10px"><label class="st-check"><input type="checkbox" id="ceRemind" ${t.remind !== false ? 'checked' : ''}>תזכורת כשמגיע הזמן (טלגרם)</label>
          <label class="st-check"><input type="checkbox" id="ceAmount" ${(t.track_amount ?? ['feeding', 'pet', 'plant'].includes(t.kind)) ? 'checked' : ''}>לרשום כמות</label>
          <label class="st-check"><input type="checkbox" id="ceBy" ${(t.track_by ?? t.kind !== 'plant') ? 'checked' : ''}>לרשום מי ביצע</label></div>
        <h4 style="margin-top:14px">${t.kind === 'meds' ? 'התרופות (כל מה שקיבל מהרופא)' : `פריטים (${h.item})`}</h4>
        <div class="st-items-edit" id="ceItems">${t.items.map(itemHtml).join('')}</div>
        <div class="st-row" style="margin-top:10px"><button class="btn btn-sm" type="button" id="ceAdd">+ ${h.item} נוספת</button><span class="spacer"></span>
          <button class="btn btn-ghost" type="button" id="ceCancel">ביטול</button><button class="btn btn-primary" type="button" id="ceSave">שמור מעקב</button></div>
        <div class="st-msg" id="ceMsg"></div></div>`;
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const collect = () => {
      t.name = $('#ceName', box).value; t.person = $('#cePerson', box).value; t.icon = $('#ceIcon', box).value;
      t.remind = $('#ceRemind', box).checked; t.track_amount = $('#ceAmount', box).checked; t.track_by = $('#ceBy', box).checked;
      if (t.kind === 'feeding') { t.per_day = $('#cePerDay', box).value; t.chat_id = $('#ceChat', box).value || null; }
      t.items = [...box.querySelectorAll('[data-item]')].map((row) => {
        const v = (f) => row.querySelector(`[data-f="${f}"]`)?.value?.trim() || '';
        const mode = v('mode');
        return { id: v('id') || undefined, name: v('name'), dose: v('dose'), notes: v('notes'), start: v('start') || null, days: v('days') || null,
          every_hours: mode === 'hours' ? v('every_hours') : null, times: mode === 'times' ? v('times') : '', every_days: mode === 'days' ? v('every_days') : null };
      });
    };
    draw();
    box.oninput = box.onchange = (e) => {
      const sel = e.target.closest('[data-f="mode"]');
      if (sel) sel.closest('[data-item]').querySelectorAll('[data-show]').forEach((x) => { x.hidden = x.dataset.show !== sel.value; });
    };
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'ceAdd') { collect(); t.items.push({ name: '' }); draw(); }
      if (b.dataset.irem !== undefined) { collect(); t.items.splice(Number(b.dataset.irem), 1); if (!t.items.length) t.items.push({ name: '' }); draw(); }
      if (b.id === 'ceCancel') box.innerHTML = '';
      if (b.id === 'ceSave') {
        collect();
        try { await post('/api/care', t); toast('✓ המעקב נשמר'); show('care'); window.loadCare?.(); }
        catch (err) { msg($('#ceMsg', box), err.message, 'bad'); }
      }
    };
  }

  /* ---------- local models ---------- */
  RENDER.models = async (el) => {
    const st = await api('/api/ai/status');
    const local = settings.local;
    const hw = st.hardware;
    const gpus = hw.gpus.filter((g) => g.vram_gb).map((g) => `${esc(g.name)} (${g.vram_gb}GB)`).join(', ') || 'לא נמצא כרטיס מסך מתאים';
    el.innerHTML = head('מודלים מקומיים', 'מודל מקומי רץ על המחשב הזה. שום הודעה לא יוצאת החוצה. התוכנה סורקת את המחשב, מציעה את המודלים העדכניים שמתאימים לו, ומורידה אותם בלחיצה אחת.') + `
      <div class="st-sec"><h4>🖥 המחשב הזה</h4><div class="meta">זיכרון: <b>${hw.ram_gb}GB</b> · מעבד: ${hw.cpu_cores} ליבות · כרטיסי מסך: ${gpus}</div></div>
      <div class="st-sec"><h4>מנוע</h4><div class="st-opts">
        ${[['builtin', 'מובנה (מומלץ)', 'llama.cpp בתוך התוכנה, בלי להתקין שום דבר'], ['lmstudio', 'LM Studio', 'אם הוא כבר מותקן אצלך'], ['ollama', 'Ollama', 'אם הוא כבר מותקן אצלך'], ['custom', 'כתובת אחרת', 'כל שרת תואם OpenAI'], ['cloud', 'בלי מודל מקומי', 'הכול דרך ספקי הענן']]
          .map(([v, b, s]) => `<label class="st-opt"><input type="radio" name="eng" value="${v}" ${local.engine === v ? 'checked' : ''}><b>${b}</b><span>${s}</span></label>`).join('')}
      </div><div id="engExtra" style="margin-top:12px"></div><div class="st-msg" id="engMsg"></div></div>
      <div id="builtinArea"></div>`;
    const extra = $('#engExtra', el);
    const drawExtra = (eng) => {
      if (['lmstudio', 'ollama', 'custom'].includes(eng)) {
        const preset = settings.presets.find((p) => p.id === eng);
        extra.innerHTML = `<div class="st-grid"><label class="st-field">כתובת<input class="field" id="exUrl" dir="ltr" value="${esc(local.engine === eng ? local.url : preset?.url || '')}"></label>
          <label class="st-field">מודל ראשי<input class="field" id="exModel" dir="ltr" value="${esc(local.engine === eng ? local.model : '')}" placeholder="שם המודל כפי שמופיע בתוכנה"></label>
          <label class="st-field">מודל סוכן קטן (לא חובה)<input class="field" id="exFast" dir="ltr" value="${esc(local.engine === eng ? local.fast_model : '')}"></label></div>
          <div class="st-row" style="margin-top:10px"><button class="btn btn-primary btn-sm" type="button" id="exSave">שמור</button></div>`;
        $('#exSave', el).onclick = async () => { try { restarting(await post('/api/settings/local', { engine: eng, url: $('#exUrl', el).value, model: $('#exModel', el).value, fast_model: $('#exFast', el).value }), $('#engMsg', el)); } catch (err) { msg($('#engMsg', el), err.message, 'bad'); } };
      } else if (eng === 'cloud') {
        extra.innerHTML = '<div class="st-row"><span class="meta">הסיכומים ייעשו בספק הענן הראשון ברשימה (לשונית "ספקי AI בענן").</span><button class="btn btn-primary btn-sm" type="button" id="exSave">שמור</button></div>';
        $('#exSave', el).onclick = async () => { try { restarting(await post('/api/settings/local', { engine: 'cloud' }), $('#engMsg', el)); } catch (err) { msg($('#engMsg', el), err.message, 'bad'); } };
      } else extra.innerHTML = '';
      $('#builtinArea', el).innerHTML = '';
      if (eng === 'builtin') builtinArea($('#builtinArea', el), st, local).catch((err) => { $('#builtinArea', el).innerHTML = `<p class="error-text">${esc(err.message)}</p>`; });
    };
    el.querySelectorAll('input[name="eng"]').forEach((r) => r.addEventListener('change', () => drawExtra(r.value)));
    drawExtra(local.engine);
  };

  async function builtinArea(area, st, local) {
    const live = st.engine === 'builtin';
    const srv = st.servers;
    const stateLabel = { ready: ['פועל', 'ok'], loading: ['נטען…', 'warn'], crashed: ['נעצר', 'bad'], 'no-runtime': ['חסר מנוע', 'bad'], off: ['כבוי', ''], stopped: ['כבוי', ''] };
    const badge = (s) => { const [t, k] = stateLabel[s.state] || [s.state, '']; return `<span class="st-badge ${k}">${t}</span>`; };
    const bench = st.state.bench || {};
    area.innerHTML = `
      <div class="st-sec st-rec" id="recBox"><h4>⭐ המלצה למחשב שלך</h4><div class="skeleton">סורק את המחשב ובודק אילו מודלים חדשים יצאו…</div></div>
      <div class="st-sec"><h4>הורדות</h4><div id="jobs" class="st-list"></div></div>
      <div class="st-sec"><h4>מודלים מותקנים</h4>${live ? `<div class="st-row meta" style="margin-bottom:8px">ראשי: ${badge(srv.main)} · סוכן: ${badge(srv.agent)}</div>` : '<p class="meta">המנוע המובנה עוד לא פעיל. הוא יופעל אוטומטית בסוף ההתקנה בלחיצה אחת.</p>'}
        <div class="st-list">${st.installed.length ? st.installed.map((m) => {
          const b = bench[m.file];
          return `<div class="st-item" style="flex-wrap:wrap"><div class="grow"><div class="t">${esc(m.repo.split('/')[1])} <span class="st-badge">${esc(m.quant)}</span>
            ${m.active_main ? '<span class="st-badge brand">ראשי</span>' : ''}${m.active_agent ? '<span class="st-badge brand">סוכן</span>' : ''}${m.mmproj ? '<span class="st-badge">תמונות</span>' : ''}</div>
            <div class="s">${gb(m.size)}${b ? ` · בדיקה בעברית: ${b.passed}/${b.of} · ${esc(b.verdict)}${b.memory_mb ? ` · ${b.memory_mb}MB זיכרון` : ''}` : ''}</div>
            ${b ? `<div class="st-results">${b.results.map((r) => `<div title="${esc(r.detail || '')}">${r.ok ? '✅' : '❌'} ${esc(r.name)}${r.name === 'מהירות' ? `: ${r.score}/שנ׳` : ''}</div>`).join('')}</div>` : ''}</div>
            ${!m.active_main ? `<button class="btn btn-sm" type="button" data-act="main" data-file="${esc(m.file)}">הפוך לראשי</button>` : ''}
            ${!m.active_agent ? `<button class="btn btn-sm" type="button" data-act="agent" data-file="${esc(m.file)}">הפוך לסוכן</button>` : ''}
            ${live && ((m.active_main && srv.main.state === 'ready') || (m.active_agent && srv.agent.state === 'ready')) ? `<button class="btn btn-sm" type="button" data-bench="${m.active_main ? 'main' : 'agent'}">בדיקה בעברית</button>` : ''}
            <button class="btn btn-ghost btn-sm" type="button" data-rm="${esc(m.file)}">מחק</button></div>`;
        }).join('') : '<p class="meta" style="margin:0">אין עדיין מודלים.</p>'}</div><div class="st-msg" id="instMsg"></div></div>
      <div class="st-sec"><h4>הגדרות מנוע</h4><div class="st-grid">
        <label class="st-field">האצה<select class="select" id="bGpu"><option value="auto">אוטומטי</option><option value="vulkan">${st.hardware?.accel === 'Metal' ? 'שבב גרפי (Metal)' : 'כרטיס מסך (Vulkan)'}</option><option value="cpu">מעבד בלבד</option></select></label>
        <label class="st-field">גודל הקשר (טוקנים)<select class="select" id="bCtx">${[4096, 8192, 16384, 32768, 65536].map((c) => `<option value="${c}" ${Number(local.context) === c ? 'selected' : ''}>${c.toLocaleString('he-IL')}</option>`).join('')}</select></label></div>
        <div class="st-row" style="margin-top:10px"><button class="btn btn-sm" type="button" id="bSave">שמור והפעל</button><span class="st-msg" id="bMsg"></span></div></div>
      ${prefs.mode === 'advanced' ? '<div class="st-sec"><h4>כל המודלים העדכניים</h4><div id="catalog"><div class="skeleton">טוען קטלוג…</div></div></div>' : '<p class="meta">לרשימה המלאה של המודלים: הגדרות › מראה › מצב מתקדם.</p>'}`;
    $('#bGpu', area).value = local.gpu || 'auto';
    $('#bSave', area).onclick = async () => { try { restarting(await post('/api/settings/local', { engine: 'builtin', gpu: $('#bGpu', area).value, context: $('#bCtx', area).value }), $('#bMsg', area)); } catch (err) { msg($('#bMsg', area), err.message, 'bad'); } };
    area.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      try {
        if (b.dataset.act) { const r = await post('/api/ai/active', { role: b.dataset.act, file: b.dataset.file }); if (r.restarting) restarting(r, $('#instMsg', area)); else show('models'); }
        if (b.dataset.rm && confirm('למחוק את קובץ המודל מהמחשב?')) { await post('/api/ai/remove', { file: b.dataset.rm }); show('models'); }
        if (b.dataset.bench) { b.disabled = true; b.textContent = 'בודק… (עד דקה)'; await post('/api/ai/benchmark', { role: b.dataset.bench }); show('models'); }
        if (b.dataset.dl) { await post('/api/ai/download', { repo: b.dataset.dl, role: b.dataset.role }); toast('ההורדה התחילה'); poll(); }
        if (b.dataset.cancel) { await post('/api/ai/cancel', { id: b.dataset.cancel }); poll(); }
        if (b.id === 'recGo') {
          b.disabled = true;
          await post('/api/ai/setup', { main: { repo: b.dataset.main }, agent: { repo: b.dataset.agent } });
          toast('מתחיל: מנוע + מודלים. זה יכול לקחת זמן, אפשר להמשיך לעבוד.'); poll();
        }
        if (b.id === 'catRefresh') catalog(true);
      } catch (err) { toast(err.message, true); b.disabled = false; }
    };
    const poll = async () => {
      const s = await api('/api/ai/status').catch(() => null);
      if (!s || current !== 'models') return;
      const active = s.jobs.filter((j) => ['downloading', 'verifying', 'installing'].includes(j.state));
      const recent = s.jobs.slice(-6).reverse();
      const jobsEl = $('#jobs', area);
      if (jobsEl) jobsEl.innerHTML = (s.setup && s.setup.state !== 'done' ? `<div class="st-item"><div class="grow"><div class="t">התקנה בלחיצה אחת: ${esc(s.setup.step)}</div>${s.setup.error ? `<div class="s error-text">${esc(s.setup.error)}</div>` : ''}</div></div>` : '')
        + (recent.length ? recent.map((j) => {
          const pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0;
          const lbl = { downloading: `${pct}% · ${gb(j.done)} מתוך ${gb(j.total)}`, verifying: 'בודק תקינות קובץ…', installing: 'מתקין…', done: '✓ הסתיים', error: j.error, cancelled: 'בוטל' }[j.state];
          return `<div class="st-item"><div class="grow"><div class="t">${esc(j.label)}</div><div class="s">${esc(lbl || '')}</div>${j.state === 'downloading' ? `<div class="st-bar" style="margin-top:6px"><i style="width:${pct}%"></i></div>` : ''}</div>
            ${['downloading', 'verifying'].includes(j.state) ? `<button class="btn btn-ghost btn-sm" type="button" data-cancel="${j.id}">ביטול</button>` : ''}</div>`;
        }).join('') : '<p class="meta" style="margin:0">אין הורדות.</p>');
      clearTimeout(pollTimer);
      if (active.length || s.setup?.state === 'running') pollTimer = setTimeout(poll, 1500);
      else if (s.setup?.state === 'done') { msg($('#instMsg', area), 'הכול מותקן. המנוע מופעל מחדש…', 'ok'); setTimeout(() => location.reload(), 12000); }
    };
    poll();
    // Recommendations (live from the catalog)
    try {
      const r = await api('/api/ai/recommend');
      const m = r.main[0]; const a = r.agent[0];
      const why = (x) => `<ul class="st-why">${x.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;
      const alt = (list, role) => list.slice(1).map((x) => `<div class="st-item"><div class="grow"><div class="t">${esc(x.name)}</div><div class="s">${x.params_b}B · ~${x.est_gb}GB · ${x.fit === 'gpu' ? 'כרטיס מסך' : 'זיכרון'}</div></div><button class="btn btn-ghost btn-sm" type="button" data-dl="${esc(x.repo)}" data-role="${role}">הורד</button></div>`).join('');
      $('#recBox', area).innerHTML = `<h4>⭐ המלצה למחשב שלך</h4><p class="meta" style="margin:0 0 10px">לפי סריקה של המחשב ורשימת המודלים העדכנית (עודכנה ${esc(new Date(r.fetched_at).toLocaleString('he-IL'))}).</p>
        <div class="st-grid">
          ${m ? `<div class="st-sec" style="margin:0"><b>מודל ראשי: ${esc(m.name)}</b><div class="meta">לסיכומים, תשובות וניתוח</div>${why(m)}</div>` : '<p class="meta">לא נמצא מודל ראשי שמתאים למחשב.</p>'}
          ${a ? `<div class="st-sec" style="margin:0"><b>סוכן: ${esc(a.name)}</b><div class="meta">מיון הודעות ועבודות פשוטות, מהר</div>${why(a)}</div>` : ''}
        </div>
        <div class="st-row" style="margin-top:12px"><button class="btn btn-primary" type="button" id="recGo" data-main="${esc(m?.repo || '')}" data-agent="${esc(a?.repo || '')}" ${m ? '' : 'disabled'}>⬇ הורד והתקן את המומלצים (${m && a ? `כ-${Math.round((m.est_gb + a.est_gb) * 10) / 10}GB` : ''})</button>
        <span class="meta">המנוע (llama.cpp) והמודלים נשמרים בתיקיית הנתונים של התוכנה, ונבדקים מול חתימת SHA-256.</span></div>
        <details style="margin-top:10px"><summary class="meta" style="cursor:pointer">אפשרויות נוספות</summary><div class="st-list" style="margin-top:8px"><b class="meta">ראשי</b>${alt(r.main, 'main')}<b class="meta">סוכן</b>${alt(r.agent, 'agent')}</div></details>`;
    } catch (err) { $('#recBox', area).innerHTML = `<h4>⭐ המלצה</h4><p class="error-text">${esc(err.message)}</p>`; }
    if (prefs.mode === 'advanced') catalog(false);
    async function catalog(refresh) {
      const box = $('#catalog', area); if (!box) return;
      box.innerHTML = '<div class="skeleton">טוען קטלוג…</div>';
      try {
        const c = await api(`/api/ai/catalog${refresh ? '?refresh=1' : ''}`);
        const fitLbl = { gpu: ['כרטיס מסך', 'ok'], ram: ['זיכרון (איטי)', 'warn'], no: ['גדול מדי', 'bad'] };
        box.innerHTML = `<div class="st-row" style="margin-bottom:8px"><span class="meta">${c.models.length} מודלים · עודכן ${esc(new Date(c.fetched_at).toLocaleString('he-IL'))}${c.error ? ` · ${esc(c.error)}` : ''}</span><button class="btn btn-ghost btn-sm" type="button" id="catRefresh">רענן</button></div>
          <div class="st-list">${c.models.map((x) => { const [fl, fk] = fitLbl[x.fit] || ['', '']; return `<div class="st-item"><div class="grow"><div class="t">${esc(x.name)} ${x.hebrew ? '<span class="st-badge ok">עברית</span>' : ''} <span class="st-badge">${x.role === 'agent' ? 'סוכן' : 'ראשי'}</span></div>
            <div class="s">${esc(x.author)} · ${x.params_b}B · ~${x.est_gb}GB · ${x.created ? esc(new Date(x.created).toLocaleDateString('he-IL')) : ''} · ${Number(x.downloads).toLocaleString('he-IL')} הורדות</div></div>
            <span class="st-badge ${fk}">${fl}</span>${x.fit !== 'no' ? `<button class="btn btn-ghost btn-sm" type="button" data-dl="${esc(x.repo)}" data-role="${x.role}">הורד</button>` : ''}</div>`; }).join('')}</div>`;
      } catch (err) { box.innerHTML = `<p class="error-text">${esc(err.message)}</p>`; }
    }
  }

  /* ---------- agents ---------- */
  RENDER.agents = (el) => {
    const a = settings.agents;
    el.innerHTML = head('סוכנים', 'מודל קטן ומהיר עושה את העבודות הפשוטות, והמודל הגדול מקבל רק מה שחשוב. אם הסוכן לא בטוח או איטי, העבודה עוברת למודל הגדול, כך ששום מידע לא הולך לאיבוד.') + `
      <div class="st-sec"><h4>מה הסוכן עושה</h4><div class="st-list">${a.all.map((j) => `<label class="st-check"><input type="checkbox" value="${j.id}" ${a.jobs.includes(j.id) ? 'checked' : ''}>${esc(j.label)}</label>`).join('')}</div>
      <div class="st-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" type="button" id="agSave">שמור</button><span class="st-msg" id="agMsg"></span></div>
      <p class="meta" style="margin:10px 0 0">מודל הסוכן נבחר בלשונית "מודלים מקומיים".</p></div>`;
    $('#agSave', el).onclick = async () => { try { restarting(await post('/api/settings/agents', { jobs: [...el.querySelectorAll('input:checked')].map((x) => x.value) }), $('#agMsg', el)); } catch (err) { msg($('#agMsg', el), err.message, 'bad'); } };
  };

  /* ---------- cloud providers ---------- */
  RENDER.cloud = (el) => {
    let list = settings.cloud.map((p) => ({ ...p, key: '' }));
    const presets = settings.presets.filter((p) => p.cloud);
    el.innerHTML = head('ספקי AI בענן (API)', 'ספקים לפי סדר עדיפות: אם הראשון לא זמין, עוברים לבא בתור, ובסוף למודל המקומי. המפתחות נשמרים רק במחשב הזה ולא מוצגים שוב.') + '<div id="clList"></div>';
    const box = $('#clList', el);
    const draw = () => {
      box.innerHTML = `${list.map((p, i) => `<div class="st-sec" data-i="${i}"><div class="st-row" style="margin-bottom:8px"><b>${i + 1}. ${esc(p.name || 'ספק')}</b><span class="spacer"></span>
          <button class="btn btn-ghost btn-icon" type="button" data-mv="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn btn-ghost btn-icon" type="button" data-mv="1" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-sm" type="button" data-test>בדוק</button><button class="btn btn-ghost btn-sm" type="button" data-del>הסר</button></div>
        <div class="st-grid"><label class="st-field">שם<input class="field" data-f="name" value="${esc(p.name)}"></label>
          <label class="st-field">כתובת<input class="field" data-f="url" dir="ltr" value="${esc(p.url)}"></label>
          <label class="st-field">מודל<input class="field" data-f="model" dir="ltr" value="${esc(p.model)}"></label>
          <label class="st-field">מפתח API<input class="field" data-f="key" type="password" dir="ltr" autocomplete="off" placeholder="${p.has_key ? 'שמור. השאר ריק כדי לא לשנות' : 'הדבק כאן'}"></label></div>
        <div class="st-row" style="margin-top:8px"><label class="st-check"><input type="checkbox" data-f="private" ${p.private ? 'checked' : ''}>מותר לשלוח גם שיחות פרטיות (לא רק קבוצות)</label><span class="st-msg" data-res></span></div></div>`).join('')}
        <div class="st-sec"><h4>הוספת ספק</h4><div class="st-row"><select class="select" id="clAdd"><option value="">בחר ספק…</option>${presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}<option value="custom">אחר (כתובת ידנית)</option></select><span class="meta" id="clHelp"></span></div></div>
        <div class="st-row"><button class="btn btn-primary" type="button" id="clSave" ${list.length > 5 ? 'disabled' : ''}>שמור את כל הספקים</button><span class="st-msg" id="clMsg"></span></div>`;
    };
    const collect = () => { box.querySelectorAll('[data-i]').forEach((row) => { const p = list[Number(row.dataset.i)]; row.querySelectorAll('[data-f]').forEach((f) => { p[f.dataset.f] = f.type === 'checkbox' ? f.checked : f.value.trim(); }); }); };
    draw();
    box.onchange = (e) => {
      if (e.target.id !== 'clAdd') return;
      collect();
      const p = presets.find((x) => x.id === e.target.value);
      if (list.length >= 5) { toast('אפשר עד 5 ספקים', true); return; }
      list.push(p ? { name: p.label, url: p.url, model: p.model, key: '', private: false } : { name: 'ספק', url: 'https://', model: '', key: '', private: false });
      draw();
      if (p) msg($('#clHelp', el), `איפה מקבלים מפתח: ${p.keyHelp}`);
    };
    box.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const row = b.closest('[data-i]'); const i = row ? Number(row.dataset.i) : -1;
      collect();
      if (b.dataset.mv) { const j = i + Number(b.dataset.mv); [list[i], list[j]] = [list[j], list[i]]; draw(); }
      if (b.hasAttribute('data-del')) { list.splice(i, 1); draw(); }
      if (b.hasAttribute('data-test')) {
        const res = row.querySelector('[data-res]'); msg(res, 'בודק…');
        const p = list[i];
        const r = await post('/api/settings/cloud/test', { url: p.url, model: p.model, key: p.key, n: p.n }).catch((err) => ({ ok: false, error: err.message }));
        msg(res, r.ok ? `✓ עובד (${r.ms}ms): ${r.answer}` : `✗ ${r.error || 'אין תשובה'}`, r.ok ? 'ok' : 'bad');
      }
      if (b.id === 'clSave') { try { restarting(await post('/api/settings/cloud', { list }), $('#clMsg', el)); } catch (err) { msg($('#clMsg', el), err.message, 'bad'); } }
    };
  };

  /* ---------- privacy ---------- */
  RENDER.privacy = (el) => {
    const mode = settings.privacy.mode;
    el.innerHTML = head('פרטיות', 'קובע מתי מותר לשלוח טקסט של הודעות לספק ענן. ההודעות עצמן תמיד נשמרות רק במחשב הזה.') + `
      <div class="st-sec"><h4>מצב עבודה</h4><div class="st-opts">
        <label class="st-opt"><input type="radio" name="pm" value="local" ${mode === 'local' ? 'checked' : ''}><b>🏠 מקומי בלבד</b><span>שום דבר לא יוצא מהמחשב. הכול נעשה במודל המקומי.</span></label>
        <label class="st-opt"><input type="radio" name="pm" value="hybrid" ${mode === 'hybrid' ? 'checked' : ''}><b>🔀 משולב</b><span>עבודות כבדות (סיכום מלא, שאלה, סיכום יומי) יכולות לעבור לענן, לפי ההרשאות של כל ספק ושל כל צ׳אט.</span></label>
        <label class="st-opt"><input type="radio" name="pm" value="manual" ${mode === 'manual' ? 'checked' : ''}><b>✋ ידני</b><span>ענן רק כשאתה מבקש עכשיו (שאלה או סיכום מלא). כל העבודה ברקע נשארת מקומית.</span></label>
      </div><div class="st-msg" id="pmMsg"></div></div>
      <div class="st-sec"><h4>הרשאות לכל צ׳אט</h4><p class="meta" style="margin:0">ברשימת "כל השיחות", באייקונים ליד כל צ׳אט, אפשר לסמן "מקומי בלבד". צ׳אט כזה לא נשלח לאף ספק ענן בשום מצב. שיחות פרטיות נשלחות רק לספק שסומן אצלו "מותר לשלוח גם שיחות פרטיות".</p></div>
      <div class="st-sec"><h4>מה נשמר ואיפה</h4><p class="meta" style="margin:0">הכול בתיקיית הנתונים של התוכנה: קובץ העבודה (צ׳אטים מסומנים, לצמיתות), ארכיון (שאר הצ׳אטים, ${settings.general.archive_days} יום), מפתחות החיבור לוואטסאפ, וקובץ ההגדרות עם מפתחות ה-API. התוכנה קוראת בלבד: היא לא שולחת הודעות בוואטסאפ.</p></div>`;
    el.querySelectorAll('input[name="pm"]').forEach((r) => r.addEventListener('change', async () => {
      try { await post('/api/settings/privacy', { mode: r.value }); settings.privacy.mode = r.value; msg($('#pmMsg', el), '✓ נשמר ופעיל מעכשיו', 'ok'); } catch (err) { msg($('#pmMsg', el), err.message, 'bad'); }
    }));
  };

  /* ---------- telegram ---------- */
  RENDER.telegram = (el) => {
    el.innerHTML = head('טלגרם (לא חובה)', 'לקבלת הסיכום היומי, תזכורות של מעקבים והתראות לטלפון. הבוט הוא שלך בלבד, כך שהסיכומים לא עוברים דרך אף אחד אחר.') + `
      <div class="st-sec"><h4>מצב</h4><p class="meta" style="margin:0">${settings.telegram.has_token ? (settings.telegram_owner ? '✓ בוט טלגרם מחובר ומאומת.' : 'הטוקן שמור, אבל עוד לא נרשמת כבעלים. חבר שוב כדי לקבל קוד חדש.') : 'לא מחובר.'}</p></div>
      <div class="st-sec"><h4>חיבור שלב אחר שלב</h4>
        <ol class="meta" style="margin:0 0 10px;padding-inline-start:22px;line-height:2">
          <li>בטלגרם, חפש את <b dir="ltr">@BotFather</b> ופתח איתו שיחה.</li>
          <li>שלח לו <b dir="ltr">/newbot</b>, בחר שם לבוט, ואחר כך שם משתמש שמסתיים ב-<b dir="ltr">bot</b>.</li>
          <li>BotFather ישלח לך "טוקן" (שורה ארוכה עם מספרים ואותיות, למשל <span dir="ltr">123456:ABC-xyz…</span>). העתק אותו.</li>
          <li>הדבק אותו כאן ולחץ שמור.</li>
          <li>פתח את הבוט שיצרת ושלח לו את הקוד שיופיע כאן. רק מי ששולח את הקוד נרשם כבעלים.</li>
        </ol>
        <div class="st-row"><input class="field" id="tgTok" type="password" dir="ltr" autocomplete="off" placeholder="123456:ABC..." style="flex:1 1 240px"><button class="btn btn-primary" type="button" id="tgSave">שמור</button></div>
        <div id="tgCodeBox" class="hidden" style="margin-top:12px"><div class="meta">שלב אחרון: שלח לבוט שלך את ההודעה הזו:</div><div style="font:700 24px ui-monospace,Consolas,monospace;margin:8px 0" dir="ltr" id="tgCode"></div></div>
        <div class="st-msg" id="tgMsg"></div>
        ${settings.telegram.has_token ? '<button class="btn btn-ghost btn-sm" type="button" id="tgOff" style="margin-top:8px">נתק את טלגרם</button>' : ''}</div>`;
    $('#tgSave', el).onclick = async () => {
      try {
        const r = await post('/api/settings/telegram', { token: $('#tgTok', el).value });
        $('#tgTok', el).value = '';
        $('#tgCode', el).textContent = `/start ${r.code}`; $('#tgCodeBox', el).classList.remove('hidden');
        msg($('#tgMsg', el), r.restarting ? 'נשמר. המנוע מופעל מחדש, חכה כ-10 שניות לפני שאתה שולח את הקוד.' : 'נשמר. הפעל מחדש את התוכנה ואז שלח את הקוד.', 'ok');
      } catch (err) { msg($('#tgMsg', el), err.message, 'bad'); }
    };
    $('#tgOff', el)?.addEventListener('click', async () => { if (!confirm('לנתק את בוט הטלגרם?')) return; restarting(await post('/api/settings/telegram', { token: '' }), $('#tgMsg', el)); });
  };

  /* ---------- phone access, other way: Tailscale ---------- */
  const renderTailscale = async (el) => {
    const s = await api('/api/remote');
    const step = (n, done, title, body) => `<div class="st-sec ${done ? '' : 'st-rec'}"><h4>${done ? '✅' : `${n}.`} ${title}</h4>${body}</div>`;
    const onPc = s.local;
    el.innerHTML = '<p class="meta">Tailscale היא אפליקציה חינמית שמחברת בצורה פרטית ומוצפנת בין המחשב לטלפון, ופותחים את התוכנה בדפדפן של הטלפון. מתאים למי שכבר משתמש בה.</p>' + `
      ${step(1, s.installed, 'מתקינים את Tailscale במחשב', s.installed ? '<p class="meta" style="margin:0">מותקן.</p>'
        : `<p class="meta">לוחצים על הכפתור, מורידים את הגרסה ל-${OS_NAME()} ומתקינים כמו כל תוכנה. בסוף ההתקנה נפתח חלון התחברות: מתחברים עם חשבון Google (או Microsoft / Apple). זה בחינם.</p>
           <a class="btn btn-primary" href="${esc(s.download)}" target="_blank" rel="noopener">⬇ הורדת Tailscale</a>`)}
      ${s.installed ? step(2, s.running, 'מתחברים ל-Tailscale במחשב', s.running ? `<p class="meta" style="margin:0">מחובר בתור <b dir="ltr">${esc(s.login)}</b>.</p>`
        : `<p class="meta" style="margin:0">${isMac() ? 'בשורת התפריטים למעלה (ליד השעון)' : 'ליד השעון של Windows'} יש אייקון של Tailscale (כמה נקודות). לוחצים עליו ובוחרים <b>Log in</b> (או <b>Connect</b>). אחרי שמתחברים, חוזרים לכאן ולוחצים "בדוק שוב".</p>`) : ''}
      ${s.running ? step(3, Boolean(s.url), 'מפעילים את הגישה', s.url
        ? `<p class="meta">הכתובת של התוכנה בטלפון:</p><div class="st-row"><b dir="ltr" style="font-size:18px" id="rmUrl">${esc(s.url)}</b>
             <button class="btn btn-sm" type="button" id="rmCopy">העתק</button>${onPc ? '<button class="btn btn-sm" type="button" id="rmTg">שלח לי בטלגרם</button>' : ''}</div>
           <p class="meta" style="margin:10px 0 0">🔒 רק החשבון <b dir="ltr">${esc(s.allowed_user || s.login)}</b> יכול להיכנס.</p>
           ${onPc ? '<button class="btn btn-ghost btn-sm" type="button" id="rmOff" style="margin-top:10px">כבה גישה מהטלפון</button>' : ''}`
        : `${s.other ? `<p class="meta warn">שים לב: הכתובת של המחשב הזה ב-Tailscale משמשת כרגע תוכנה אחרת (${esc(s.other)}). הפעלה כאן תחליף אותה.</p>` : ''}
           ${onPc ? '<button class="btn btn-primary" type="button" id="rmOn">📱 הפעל גישה מהטלפון</button>' : '<p class="meta">את זה מפעילים מהמחשב עצמו.</p>'}
           <div id="rmEnable"></div>`) : ''}
      ${step(4, false, 'בטלפון', `<ol class="meta" style="margin:0;padding-inline-start:22px;line-height:2">
          <li>מתקינים את האפליקציה <b>Tailscale</b> מ-Google Play או מה-App Store.</li>
          <li>פותחים אותה ומתחברים <b>עם אותו חשבון</b> שהתחברת איתו במחשב, ומאשרים את בקשת ה-VPN.</li>
          <li>פותחים בדפדפן (Chrome או Safari) את הכתובת${s.url ? ` <b dir="ltr">${esc(s.url)}</b>` : ' שתופיע כאן אחרי ההפעלה'}.</li>
          <li>כדי שיהיה אייקון כמו אפליקציה: בתפריט הדפדפן בוחרים <b>הוספה למסך הבית</b>.</li>
        </ol><p class="meta" style="margin:8px 0 0">המחשב צריך להיות דלוק והתוכנה פועלת (${STARTS_WITH()}).</p>`)}
      <div class="st-row"><button class="btn btn-ghost btn-sm" type="button" id="rmRe">בדוק שוב</button><span class="st-msg" id="rmMsg"></span></div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const m = $('#rmMsg', el);
      try {
        if (b.id === 'rmRe') return show('phone');
        if (b.id === 'rmCopy') { await navigator.clipboard.writeText(s.url); return msg(m, '✓ הועתק', 'ok'); }
        if (b.id === 'rmTg') { await post('/api/remote/telegram'); return msg(m, '✓ נשלח לטלגרם', 'ok'); }
        if (b.id === 'rmOff') { await post('/api/remote/disable'); return show('phone'); }
        if (b.id === 'rmOn') {
          b.disabled = true; msg(m, 'מפעיל…');
          const r = await post('/api/remote/enable');
          if (r.ok) return show('phone');
          $('#rmEnable', el).innerHTML = `<p class="meta" style="margin-top:10px">פעם ראשונה בלבד: Tailscale מבקש לאשר את האפשרות הזו. לוחצים על הכפתור, מאשרים בדף שנפתח (<b>Enable</b>), וחוזרים לכאן ללחוץ שוב "הפעל".</p>
            <a class="btn btn-sm" href="${esc(r.enable_url)}" target="_blank" rel="noopener">פתח את דף האישור</a>`;
          b.disabled = false; msg(m, '');
        }
      } catch (err) { b.disabled = false; msg(m, err.message, 'bad'); }
    };
  };

  /* ---------- phone access: the phone app (built-in p2p bridge) ---------- */
  let pairPoll = null;
  let phoneFlash = ''; // shown once on the next render (show() replaces the whole tab)
  RENDER.phone = async (el) => {
    clearInterval(pairPoll); pairPoll = null;
    const s = await api('/api/p2p');
    const onPc = s.local;
    const ago = (t) => { if (!t) return ''; const m = Math.round((Date.now() / 1000 - t) / 60); return m < 2 ? 'עכשיו' : m < 60 ? `לפני ${m} דקות` : m < 1440 ? `לפני ${Math.round(m / 60)} שעות` : `לפני ${Math.round(m / 1440)} ימים`; };
    const devices = (s.devices || []).map((d) => `<div class="st-item"><span style="font-size:22px">📱</span>
        <div class="grow"><div class="t">${esc(d.name || 'טלפון')}</div><div class="s"><span dir="ltr">${esc(d.nodeId.slice(0, 10))}…</span> · ${d.connected ? 'מחובר עכשיו' : `נראה ${esc(ago(d.lastSeen))}`}</div></div>
        ${d.connected ? '<span class="st-badge ok">מחובר</span>' : ''}
        ${onPc ? `<button class="btn btn-ghost btn-sm" type="button" data-revoke="${esc(d.nodeId)}" data-name="${esc(d.name || 'הטלפון')}">בטל</button>` : ''}</div>`).join('');
    let app;
    if (!s.available) app = '<p class="meta warn" style="margin:0">רכיב החיבור לטלפון חסר בהתקנה הזו. התקן מחדש את הגרסה האחרונה.</p>';
    else if (!s.enabled) app = onPc ? '<p class="meta">מפעילים פעם אחת, ואז מצמדים את הטלפון בסריקת קוד.</p><button class="btn btn-primary" type="button" id="p2On">📱 הפעל גישה מהאפליקציה</button>' : '<p class="meta" style="margin:0">כבוי. את זה מפעילים מהמחשב עצמו.</p>';
    else app = `
        <p class="meta" style="margin-top:0">${s.running ? (s.online ? '🟢 פועל ומוכן לחיבור מכל מקום.' : '🟡 פועל, מחפש חיבור לאינטרנט…') : `🔴 לא פועל${s.error ? ` (${esc(s.error)})` : ''}.`}</p>
        <h4 style="margin:14px 0 6px">טלפונים מחוברים</h4>
        ${devices || '<p class="meta" style="margin:0">עוד אין. לוחצים "צמד טלפון חדש" וסורקים את הקוד באפליקציה.</p>'}
        ${onPc ? `<div class="st-row" style="margin-top:12px"><button class="btn btn-primary" type="button" id="p2Pair">➕ צמד טלפון חדש</button>
          <button class="btn btn-ghost btn-sm" type="button" id="p2Off">כבה גישה מהאפליקציה</button></div>
          <div id="p2Qr"></div>` : ''}`;
    el.innerHTML = head('גישה מהטלפון', 'פותחים את התוכנה מהטלפון, גם מחוץ לבית. החיבור ישיר ומוצפן מקצה לקצה בין המחשב לטלפון שלך, בלי חשבון ובלי להתקין שום דבר במחשב. רק טלפון שצימדת בסריקת קוד יכול להיכנס.') + `
      <div class="st-sec">
        <h4>אפליקציית הטלפון (מומלץ)</h4>
        ${app}
        <ol class="meta" style="margin:12px 0 0;padding-inline-start:22px;line-height:2">
          <li>מתקינים בטלפון את האפליקציה <b>סיכומי וואטסאפ</b>.</li>
          <li>כאן במחשב לוחצים <b>צמד טלפון חדש</b>.</li>
          <li>באפליקציה לוחצים <b>סרוק קוד QR מהמחשב</b> ומכוונים את המצלמה לקוד.</li>
        </ol>
        <p class="meta" style="margin:8px 0 0">המחשב צריך להיות דלוק והתוכנה פועלת (${STARTS_WITH()}).</p>
      </div>
      <details class="st-sec" id="tsBox"><summary style="cursor:pointer"><b>דרך נוספת: Tailscale</b></summary><div id="tsInner" style="margin-top:10px"></div></details>
      <div class="st-row"><button class="btn btn-ghost btn-sm" type="button" id="p2Re">בדוק שוב</button><span class="st-msg" id="p2Msg"></span></div>`;
    if (phoneFlash) { msg($('#p2Msg', el), phoneFlash, 'ok'); phoneFlash = ''; }
    $('#tsBox', el).addEventListener('toggle', (e) => { if (e.target.open && !$('#tsInner', el).childElementCount) renderTailscale($('#tsInner', el)).catch((err) => msg($('#p2Msg', el), err.message, 'bad')); }, { once: false });

    const qrBox = $('#p2Qr', el);
    const showQr = (r) => {
      const known = new Set((s.devices || []).map((d) => d.nodeId));
      let left = r.expiresIn;
      qrBox.innerHTML = `<div class="st-sec" style="text-align:center;margin-top:12px">
          <p class="meta" style="margin-top:0">באפליקציה בטלפון: <b>סרוק קוד QR מהמחשב</b></p>
          <div style="width:240px;max-width:100%;margin:0 auto;background:#fff;padding:8px;border-radius:12px">${r.svg}</div>
          <p class="meta" id="p2Left"></p>
          <button class="btn btn-ghost btn-sm" type="button" id="p2Cancel">ביטול</button></div>`;
      const tick = () => { const l = $('#p2Left', el); if (l) l.textContent = left > 0 ? `הקוד בתוקף עוד ${left} שניות, ולשימוש אחד בלבד.` : 'הקוד פג. לוחצים שוב "צמד טלפון חדש".'; };
      tick();
      let n = 0;
      pairPoll = setInterval(async () => {
        if (!el.isConnected) { clearInterval(pairPoll); pairPoll = null; return; }
        left -= 1; tick();
        if (left <= 0) { clearInterval(pairPoll); pairPoll = null; $('#p2Qr svg', el)?.setAttribute('opacity', '0.15'); return; }
        if (++n % 2) return; // check every 2 seconds
        try {
          const now = await api('/api/p2p');
          const added = (now.devices || []).find((d) => !known.has(d.nodeId));
          if (added) { clearInterval(pairPoll); pairPoll = null; phoneFlash = `✓ ${added.name || 'הטלפון'} צומד בהצלחה`; show('phone'); }
        } catch { /* keep waiting */ }
      }, 1000);
    };

    el.onclick = async (e) => {
      const b = e.target.closest('button'); if (!b || b.closest('#tsInner')) return;
      const m = $('#p2Msg', el);
      try {
        if (b.id === 'p2Re') return show('phone');
        if (b.id === 'p2On') { b.disabled = true; await post('/api/p2p/enable'); return show('phone'); }
        if (b.id === 'p2Off') { if (!confirm('לכבות את הגישה מהאפליקציה? הטלפונים יישארו מצומדים ויתחברו שוב כשתפעיל.')) return; await post('/api/p2p/disable'); return show('phone'); }
        if (b.id === 'p2Pair') { b.disabled = true; msg(m, 'מכין קוד…'); clearInterval(pairPoll); showQr(await post('/api/p2p/pair')); msg(m, ''); b.disabled = false; return; }
        if (b.id === 'p2Cancel') { clearInterval(pairPoll); pairPoll = null; qrBox.innerHTML = ''; await post('/api/p2p/pair/stop'); return; }
        if (b.dataset.revoke) {
          if (!confirm(`לבטל את הגישה של "${b.dataset.name}"? כדי לחבר אותו שוב צריך לסרוק קוד חדש.`)) return;
          await post('/api/p2p/revoke', { nodeId: b.dataset.revoke });
          return show('phone');
        }
      } catch (err) { b.disabled = false; msg(m, err.message, 'bad'); }
    };
  };

  /* ---------- look ---------- */
  RENDER.look = (el) => {
    const ACC = [['green', '#22e07a'], ['violet', '#b46bff'], ['blue', '#38bdf8'], ['pink', '#ff4f9a'], ['orange', '#ff8a3d']];
    el.innerHTML = head('מראה', 'השינויים חלים מיד, ונשמרים גם לטלפון.') + `
      <div class="st-sec"><h4>מצב תצוגה</h4><div class="st-opts">
        <label class="st-opt"><input type="radio" name="lm" value="simple" ${prefs.mode === 'simple' ? 'checked' : ''}><b>רגיל</b><span>נקי ושקט: מה שצריך ביום-יום.</span></label>
        <label class="st-opt"><input type="radio" name="lm" value="advanced" ${prefs.mode === 'advanced' ? 'checked' : ''}><b>מתקדם</b><span>כל המודלים, סוכנים, נתונים ופרטים טכניים.</span></label></div></div>
      <div class="st-sec"><h4>ערכת צבעים</h4><div class="st-opts">
        ${[['dark', 'כהה'], ['light', 'בהירה'], ['auto', `לפי ${OS_NAME()}`]].map(([v, l]) => `<label class="st-opt"><input type="radio" name="lt" value="${v}" ${prefs.theme === v ? 'checked' : ''}><b>${l}</b></label>`).join('')}</div>
        <h4 style="margin-top:14px">צבע הדגשה</h4><div class="st-swatches">${ACC.map(([v, c]) => `<button type="button" class="st-swatch ${prefs.accent === v ? 'on' : ''}" data-acc="${v}" style="background:${c}" title="${v}"></button>`).join('')}</div></div>
      <div class="st-sec"><h4>גודל טקסט</h4><div class="st-opts">${[[90, 'קטן'], [100, 'רגיל'], [115, 'גדול'], [130, 'גדול מאוד']].map(([v, l]) => `<label class="st-opt"><input type="radio" name="lx" value="${v}" ${Number(prefs.text) === v ? 'checked' : ''}><b style="font-size:${v / 100}em">${l}</b></label>`).join('')}</div></div>
      <div class="st-sec"><h4>אפקטים</h4><label class="st-check"><input type="checkbox" id="lfx" ${prefs.fx ? 'checked' : ''}>תלת-ממד, תאורה ותנועה (כיבוי חוסך משאבים ומקל על הקריאה)</label></div>`;
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'lm') { prefs.mode = t.value; renderNav(); }
      if (t.name === 'lt') prefs.theme = t.value;
      if (t.name === 'lx') prefs.text = Number(t.value);
      if (t.id === 'lfx') prefs.fx = t.checked;
      savePrefs();
    });
    el.addEventListener('click', (e) => { const s = e.target.closest('[data-acc]'); if (!s) return; prefs.accent = s.dataset.acc; el.querySelectorAll('.st-swatch').forEach((x) => x.classList.toggle('on', x === s)); savePrefs(); });
  };

  /* ---------- main screen modules ---------- */
  RENDER.home = (el) => {
    const draw = () => {
      el.innerHTML = head('מסך ראשי', 'בחר אילו חלקים יופיעו, באיזה סדר, ומה יופיע רק כשיש בו משהו חדש (אחרת הוא מצטמצם לשורת כותרת).') + `
        <div class="st-sec"><div class="st-list">${prefs.modules.map((m, i) => { const def = MODULES.find((x) => x.id === m.id); return `
          <div class="st-item"><div class="grow"><div class="t">${esc(def.label)}</div></div>
          <select class="select" data-show="${i}"><option value="always" ${m.show === 'always' ? 'selected' : ''}>תמיד</option><option value="new" ${m.show === 'new' ? 'selected' : ''}>רק כשיש חדש</option><option value="hidden" ${m.show === 'hidden' ? 'selected' : ''}>מוסתר</option></select>
          <button class="btn btn-ghost btn-icon" type="button" data-mv="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn btn-ghost btn-icon" type="button" data-mv="${i}" data-d="1" ${i === prefs.modules.length - 1 ? 'disabled' : ''}>↓</button></div>`; }).join('')}</div>
          <div class="st-row" style="margin-top:12px"><button class="btn btn-ghost btn-sm" type="button" id="hmReset">ברירת מחדל</button></div></div>`;
    };
    draw();
    el.onchange = (e) => { const s = e.target.closest('[data-show]'); if (!s) return; prefs.modules[Number(s.dataset.show)].show = s.value; savePrefs(); };
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mv !== undefined) { const i = Number(b.dataset.mv); const j = i + Number(b.dataset.d); [prefs.modules[i], prefs.modules[j]] = [prefs.modules[j], prefs.modules[i]]; savePrefs(); draw(); }
      if (b.id === 'hmReset') { prefs.modules = DEFAULT_PREFS.modules.map((m) => ({ ...m })); savePrefs(); draw(); }
    };
  };

  /* ---------- general ---------- */
  RENDER.general = (el) => {
    const g = settings.general;
    el.innerHTML = head('כללי') + `
      <div class="st-sec"><div class="st-grid">
        <label class="st-field">שעת הסיכום היומי<select class="select" id="gHour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${g.digest_hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></label>
        <label class="st-field">כמה ימים לשמור צ׳אטים לא מסומנים בארכיון<input class="field" type="number" min="3" max="365" id="gDays" value="${g.archive_days}"></label></div>
        <div class="st-row" style="margin-top:12px"><button class="btn btn-primary btn-sm" type="button" id="gSave">שמור</button><span class="st-msg" id="gMsg"></span></div></div>
      ${isMac()
        ? '<div class="st-sec"><h4>הפעלה עם ה-Mac</h4><p class="meta" style="margin:0">התוכנה עולה לבד כשנכנסים ל-Mac וממשיכה לעבוד ברקע גם כשהחלון סגור. אפשר לכבות את זה מהאייקון שלה בשורת התפריטים למעלה, או בהגדרות המערכת › כללי › פריטי התחברות.</p></div>'
        : '<div class="st-sec"><h4>הפעלה עם Windows</h4><p class="meta" style="margin:0">התוכנה עולה לבד כשנכנסים ל-Windows וממשיכה לעבוד ברקע גם כשהחלון סגור. אפשר לכבות את זה מהאייקון שלה ליד השעון (לחיצה ימנית).</p></div>'}`;
    $('#gSave', el).onclick = async () => { try { restarting(await post('/api/settings/general', { digest_hour: Number($('#gHour', el).value), archive_days: Number($('#gDays', el).value) }), $('#gMsg', el)); } catch (err) { msg($('#gMsg', el), err.message, 'bad'); } };
  };

  /* ---------- system status ---------- */
  RENDER.system = async (el) => {
    const s = await api('/api/system');
    renderNav(s.problems.filter((p) => p.level === 'bad').length);
    const wa = s.whatsapp; const m = s.models;
    const srvLbl = (x) => ({ ready: '✓ פועל', loading: '… נטען', crashed: '✗ נעצר', off: 'כבוי', 'no-runtime': '✗ חסר מנוע', stopped: 'כבוי' }[x.state] || x.state);
    el.innerHTML = head('מצב מערכת', 'מה עובד, מה לא, ומה עושים.') + `
      <div class="st-sec"><h4>${s.problems.length ? '⚠ דברים שצריך לטפל בהם' : '✓ הכול תקין'}</h4><div class="st-list">${s.problems.map((p) => `
        <div class="st-item"><span class="st-badge ${p.level === 'bad' ? 'bad' : 'warn'}">${p.level === 'bad' ? 'תקלה' : 'שים לב'}</span><div class="grow"><div class="t">${esc(p.text)}</div>${p.detail ? `<div class="s">${esc(String(p.detail).slice(0, 200))}</div>` : ''}</div>
        ${p.fix ? `<button class="btn btn-sm" type="button" data-fix="${p.fix}">${esc(p.fix_label)}</button>` : ''}</div>`).join('')}</div></div>
      <div class="st-grid">
        <div class="st-sec"><h4>📱 וואטסאפ</h4><div class="meta">${wa.linked ? '✓ מחובר' : '✗ לא מחובר'} · מנוע: ${esc(wa.engine)}<br>הודעה אחרונה: ${when(wa.last_message_at)}</div></div>
        <div class="st-sec"><h4>🧠 מודלים</h4><div class="meta">מנוע: ${esc({ builtin: 'מובנה', lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'כתובת אחרת', cloud: 'ענן בלבד', external: 'לא הוגדר' }[m.engine] || m.engine)} ·פרטיות: ${esc({ local: 'מקומי בלבד', hybrid: 'משולב', manual: 'ידני' }[m.privacy] || m.privacy)}<br>
          ראשי: ${esc(m.main === 'local-model' ? 'לא נבחר' : m.main)}${m.engine === 'builtin' ? ` (${srvLbl(m.servers.main)})` : ''}<br>סוכן: ${esc(m.agent || 'אין')}${m.engine === 'builtin' && m.agent ? ` (${srvLbl(m.servers.agent)})` : ''}<br>
          ${m.cloud.map((c) => `${esc(c.name)}: ${c.ready ? '✓' : '✗'} (${c.ok} הצליחו, ${c.failed} נכשלו)`).join('<br>')}</div></div>
        <div class="st-sec"><h4>💾 אחסון</h4><div class="meta">קובץ העבודה: ${gb(s.storage.work_db)}<br>ארכיון: ${gb(s.storage.archive_db)}${s.storage.archive ? ` · ${Number(s.storage.archive.messages).toLocaleString('he-IL')} הודעות` : ''}<br>זיכרון בשימוש: ${s.memory_mb}MB</div></div>
        <div class="st-sec"><h4>🗄 גיבוי</h4><div class="meta">${s.backup ? (s.backup.ok ? `אחרון: ${when(s.backup.at)} (${gb(s.backup.size)})` : `נכשל: ${esc(s.backup.error || '')}`) : 'עוד לא נעשה גיבוי'}<br>נשמרים 7 גיבויים אחרונים, פעם ביום.</div>
          <button class="btn btn-sm" type="button" data-fix="backup" style="margin-top:8px">גבה עכשיו</button></div>
      </div>
      <div class="st-sec"><h4>פעולות</h4><div class="st-row">
        <button class="btn btn-sm" type="button" data-fix="folder">פתח את תיקיית הנתונים</button>
        <button class="btn btn-sm" type="button" data-fix="restart">הפעל את המנוע מחדש</button>
        <button class="btn btn-ghost btn-sm" type="button" data-fix="clear-archive">מחק את הארכיון (צ׳אטים לא מסומנים)</button></div><div class="st-msg" id="sysMsg"></div></div>`;
    el.onclick = async (e) => {
      const b = e.target.closest('[data-fix]'); if (!b) return;
      const f = b.dataset.fix;
      try {
        if (f === 'models' || f === 'cloud' || f === 'telegram') return show(f);
        if (f === 'link') { dlg.close(); document.getElementById('linkOverlay')?.classList.remove('hidden'); return; }
        if (f === 'sync') { await post('/api/chats/sync'); msg($('#sysMsg', el), '✓ סונכרן', 'ok'); }
        if (f === 'backup') { b.disabled = true; await post('/api/system/backup'); return show('system'); }
        if (f === 'folder') { await post('/api/system/open-folder'); }
        if (f === 'restart' || f === 'restart-ai') { restarting(await post('/api/system/restart'), $('#sysMsg', el)); }
        if (f === 'clear-archive') { if (!confirm('למחוק את כל הארכיון של הצ׳אטים הלא מסומנים? אי אפשר לשחזר.')) return; await post('/api/data/clear-archive'); msg($('#sysMsg', el), '✓ הארכיון נמחק', 'ok'); }
      } catch (err) { msg($('#sysMsg', el), err.message, 'bad'); }
    };
  };

  window.openSettings = open;
})();
