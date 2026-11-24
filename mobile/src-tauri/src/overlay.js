// Injected by the app into every page; does something only on the dashboard served by the app's local proxy.
(() => {
  if (location.origin !== '__ORIGIN__') return;
  const CSS = `
    body { padding-top: env(safe-area-inset-top); }
    #wa-net { position: fixed; inset-inline: 12px; top: calc(env(safe-area-inset-top) + 10px); z-index: 2147483647;
      display: none; direction: rtl; text-align: right; background: #23272f; color: #f1f3f5; border-radius: 16px;
      padding: 14px 16px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.4); }
    #wa-net.show { display: block; }
    #wa-net b { display: block; font-size: 16px; margin-bottom: 2px; }
    #wa-net .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    #wa-net button { border: 0; border-radius: 10px; padding: 9px 14px; font: inherit; cursor: pointer; }
    #wa-net .retry { background: #22c55e; color: #06200f; font-weight: 600; }
    #wa-net .switch { background: transparent; color: #cbd5e1; text-decoration: underline; }`;
  const TEXT = {
    offline: ['המחשב לא זמין כרגע — מנסה להתחבר מחדש...', 'ודא שהמחשב דלוק ושהתוכנה פועלת בו.'],
    connecting: ['מתחבר למחשב...', ''],
    revoked: ['המחשב ביטל את הגישה של הטלפון הזה', 'כדי להתחבר שוב, צמד את הטלפון מחדש מהגדרות התוכנה במחשב.'],
  };
  const post = (path) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  function init() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const box = document.createElement('div');
    box.id = 'wa-net';
    box.setAttribute('role', 'status');
    box.innerHTML = '<b></b><span></span><div class="row"><button class="retry" type="button">נסה שוב</button><button class="switch" type="button">החלף מחשב / נתק חיבור</button></div>';
    document.body.appendChild(box);
    box.querySelector('.retry').onclick = async () => { box.querySelector('b').textContent = TEXT.connecting[0]; try { await post('/__wa/retry'); } catch { /* shown again below */ } setTimeout(check, 1500); };
    box.querySelector('.switch').onclick = async () => {
      if (!confirm('לנתק את הטלפון מהמחשב הזה? כדי להתחבר שוב צריך לסרוק קוד חדש.')) return;
      try { await post('/__wa/unpair'); } catch { /* the app navigates away */ }
    };

    let since = 0; // when the connection stopped being "connected"
    let wasDown = false;
    async function check() {
      let state = 'offline';
      try { state = (await (await fetch('/__wa/status', { cache: 'no-store' })).json()).state; } catch { /* proxy unreachable */ }
      if (state === 'connected') {
        since = 0;
        box.classList.remove('show');
        if (wasDown && document.body.hasAttribute('data-wa-offline')) location.replace('/');
        wasDown = false;
        return;
      }
      if (!since) since = Date.now();
      // A short "connecting" (e.g. right after waking up) is not worth a banner.
      if (state === 'connecting' && Date.now() - since < 4000) return;
      wasDown = true;
      const [title, sub] = TEXT[state] || TEXT.offline;
      box.querySelector('b').textContent = title;
      box.querySelector('span').textContent = sub;
      box.classList.add('show');
    }
    check();
    setInterval(check, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { post('/__wa/retry').catch(() => {}); check(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
