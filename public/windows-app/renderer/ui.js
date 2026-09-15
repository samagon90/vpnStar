// Sonic VPN for Windows — UI логика (renderer).
'use strict';

const $ = (id) => document.getElementById(id);
let lastReport = '';

function setMsg(text, cls) {
  const el = $('msg');
  el.textContent = text || '';
  el.className = cls || 'hint';
}

function setCheck(n, r) {
  const dot = $('c' + n + '-dot');
  const det = $('c' + n + '-detail');
  if (!r) {
    dot.textContent = '⚪';
    det.textContent = '—';
    det.className = 'detail';
    return;
  }
  if (r.ok) {
    dot.textContent = '🟢';
    det.textContent = (r.extra || 'OK') + (typeof r.ms === 'number' ? ' · ' + r.ms + ' мс' : '');
    det.className = 'detail ok';
  } else {
    dot.textContent = '🔴';
    det.textContent = r.extra || 'ошибка';
    det.className = 'detail bad';
  }
}

function renderDiag(d) {
  if (!d) return;
  const direct = d.t1 && d.t2
    ? { ok: d.t1.ok && d.t2.ok, ms: (d.t1.ms || 0) + (d.t2.ms || 0),
        extra: (d.t1.ok ? 'tcp ' + d.t1.ms + 'мс' : 'tcp: ' + d.t1.extra) + ' · ' +
               (d.t2.ok ? 'tls ' + d.t2.ms + 'мс' : 'tls: ' + d.t2.extra) }
    : null;
  setCheck(1, direct);
  setCheck(2, d.t4);
  setCheck(3, d.t5);
  setCheck(4, d.t3);
  setCheck(5, d.t6);
  if (d.verdict && d.verdict.length) {
    $('verdict').textContent = d.verdict.join('\n');
    $('verdict').style.display = 'block';
  } else {
    $('verdict').style.display = 'none';
  }
}

function renderReport(text) {
  lastReport = text || '';
  $('report').textContent = lastReport || '(пусто)';
}

function setStatus(state, message) {
  const pill = $('status-pill');
  const dot = $('status-dot');
  const txt = $('status-text');
  const map = {
    connected: ['🟢', 'Подключено'],
    connecting: ['🟡', 'Подключаем…'],
    disconnected: ['⚪', 'Не подключено'],
  };
  const m = map[state] || map.disconnected;
  dot.textContent = m[0];
  txt.textContent = m[1] + (message && state === 'disconnected' ? ' — ' + message : '');
  $('connect-btn').disabled = state === 'connecting';
  $('disconnect-btn').disabled = state !== 'connected';
}

// ---------- сохранённый профиль и автоподключение ----------

async function initProfile() {
  try {
    const p = await window.sonic.getProfile();
    if (p && p.link) $('link').value = p.link;
    $('auto-cb').checked = !!(p && p.autoconnect);
    if (p && p.autoconnect && p.link) addEventListener('load', () => $('connect-btn').click());
  } catch {
    /* ignore */
  }
}

// ---------- кнопки ----------

$('connect-btn').addEventListener('click', async () => {
  const link = $('link').value.trim();
  if (!link) return setMsg('Сначала вставь ссылку vless://', 'err');
  setMsg('Подключаем (первый запуск — скачиваем ядро, это может занять время)…');
  setStatus('connecting');
  try {
    const r = await window.sonic.connect(link);
    if (!r.ok) {
      setStatus('disconnected', r.error);
      setMsg(r.error, 'err');
      return;
    }
    setStatus('connected');
    setMsg('Подключено. Теперь открой сайты в браузере (Chrome/Edge) — они пойдут через VPN.', 'ok');
    renderDiag(r.diag);
    renderReport(r.report);
  } catch (e) {
    setStatus('disconnected', e.message);
    setMsg(e.message, 'err');
  }
});

$('disconnect-btn').addEventListener('click', async () => {
  setStatus('connecting', 'Отключаем…');
  const r = await window.sonic.disconnect();
  setStatus('disconnected');
  setMsg(r.ok ? 'Отключено. Системный прокси снят.' : 'Ошибка отключения', r.ok ? 'ok' : 'err');
});

$('auto-cb').addEventListener('change', () => {
  window.sonic.setAutoconnect($('auto-cb').checked);
});

$('recheck-btn').addEventListener('click', async () => {
  setMsg('Проверяем… (до минуты)');
  try {
    const r = await window.sonic.diagnose();
    if (!r.ok) return setMsg(r.error, 'err');
    renderDiag(r.diag);
    renderReport(r.report);
    setMsg('Проверка завершена.', 'ok');
  } catch (e) {
    setMsg(e.message, 'err');
  }
});

$('copy-btn').addEventListener('click', async () => {
  if (!lastReport) return setMsg('Сначала подключись или нажми «Проверить ещё раз».', 'err');
  await window.sonic.copyReport(lastReport);
  $('copy-hint').textContent = 'Скопировано — вставь в чат поддержки (Ctrl+V).';
  setTimeout(() => { $('copy-hint').textContent = ''; }, 4000);
});

// ---------- события из main ----------

window.sonic.onStatus((p) => {
  setStatus(p.state, p.message);
});
window.sonic.onCoreProgress((p) => {
  const bar = $('core-progress-bar');
  const wrap = $('core-progress');
  if (!p) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = 'block';
  bar.style.width = p.pct + '%';
  setMsg(p.text);
});

setStatus('disconnected');
initProfile();