/* Sonic VPN: маленький API-хелпер (credentials: same-origin) */
// Если сайт на Cloudflare Pages, а API на отдельном домене — укажите его:
// const API_BASE = 'https://api.sonicvpn.ru';
const API_BASE = '';
const API = {
  async req(method, url, body) {
    const res = await fetch(API_BASE + url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no json */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get: (u) => API.req('GET', u),
  post: (u, b) => API.req('POST', u, b || {}),
};

function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

function msg(el, text, ok) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}
function hideMsg(el) {
  el.className = 'msg';
  el.textContent = '';
}

function fmtMoney(cents) {
  return (cents / 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' ₽';
}
function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
}
