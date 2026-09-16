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
  setCheck(6, d.t7);
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
  const hero = $('hero-state');
  const power = $('power-btn');
  const map = {
    connected: ['🟢', 'Подключено'],
    connecting: ['🟡', 'Подключаем…'],
    disconnected: ['⚪', 'Не подключено'],
  };
  const m = map[state] || map.disconnected;
  dot.textContent = m[0];
  txt.textContent = m[1] + (message && state === 'disconnected' ? ' — ' + message : '');
  hero.textContent = state === 'connected' ? 'Ты в сети ⚡' : state === 'connecting' ? (message || 'Подключаем…') : 'Нажми кнопку — и ты в сети';
  hero.className = 'hero-state' + (state === 'connected' ? ' ok' : state === 'connecting' ? ' work' : '');
  power.textContent = state === 'connected' ? '⏸' : '🚀';
  power.classList.toggle('on', state === 'connected');
  power.disabled = state === 'connecting';
  $('connect-btn').disabled = state === 'connecting';
  $('disconnect-btn').disabled = state !== 'connected';
  updateServerChip();
}

function updateServerChip() {
  const chip = $('server-chip');
  const m = /^vless:\/\/[^@]+@([^:/?#]+)/i.exec($('link').value.trim());
  if (m) {
    chip.style.display = '';
    chip.innerHTML = 'сервер <b>' + m[1].replace(/[<>&"]/g, '') + '</b>';
  } else {
    chip.style.display = 'none';
  }
}

function updatePingChip(diag) {
  const chip = $('ping-chip');
  const t1 = diag && diag.t1;
  if (t1 && typeof t1.ms === 'number') {
    chip.style.display = '';
    chip.innerHTML = 'пинг <b>' + t1.ms + ' мс</b>';
  } else {
    chip.style.display = 'none';
  }
}

// ---------- сохранённый профиль и автоподключение ----------

async function initProfile() {
  try {
    const p = await window.sonic.getProfile();
    if (p && p.link) $('link').value = p.link;
    $('auto-cb').checked = !!(p && p.autoconnect);
    updateServerChip();
    if (p && p.autoconnect && p.link) addEventListener('load', () => $('connect-btn').click());
  } catch {
    /* ignore */
  }
}

// ---------- кнопки ----------

$('connect-btn').addEventListener('click', async () => {
  const link = $('link').value.trim();
  if (!link) {
    document.getElementById('key-panel').open = true;
    return setMsg('Сначала вставь ссылку vless://', 'err');
  }
  setMsg('Подключаем…');
  setStatus('connecting');
  updateServerChip();
  try {
    const r = await window.sonic.connect(link);
    if (!r.ok) {
      setStatus('disconnected', r.error);
      setMsg(r.error, 'err');
      return;
    }
    setStatus('connected');
    setMsg('Подключено. Проверка идет в фоне — результат появится ниже.', 'ok');
    refreshProxyBtn();
    // диагностика может прийти позже отдельным событием (быстрое подключение)
    if (r.diag) {
      renderDiag(r.diag);
      renderReport(r.report);
      updatePingChip(r.diag);
    }
  } catch (e) {
    setStatus('disconnected', e.message);
    setMsg(e.message, 'err');
  }
});

// гигантская кнопка = тот же коннект/дисконнект
$('power-btn').addEventListener('click', async () => {
  const txt = $('status-text').textContent;
  if (txt.startsWith('Подключено')) {
    $('disconnect-btn').click();
  } else {
    $('connect-btn').click();
  }
});

$('link').addEventListener('input', updateServerChip);

$('disconnect-btn').addEventListener('click', async () => {
  setStatus('connecting', 'Отключаем…');
  const r = await window.sonic.disconnect();
  setStatus('disconnected');
  setMsg(r.ok ? 'Отключено. Системный прокси снят.' : 'Ошибка отключения', r.ok ? 'ok' : 'err');
  refreshProxyBtn();
});

// ---------- системный прокси (кнопка: браузеры идут через канал только когда он вкл) ----------

async function refreshProxyBtn() {
  const btn = $('proxy-btn');
  const hint = $('proxy-hint');
  try {
    const s = await window.sonic.proxyGet();
    if (!s || !s.ok) {
      btn.textContent = '🌐 Системный прокси: ?';
      hint.textContent = 'не удалось прочитать состояние';
      return null;
    }
    const on = !!s.enabled;
    btn.textContent = on ? '🌐 Системный прокси: вкл' : '🌐 Системный прокси: выкл';
    hint.textContent = on ? ('браузеры через защищённый канал (' + (s.server || 'прокси') + ')') : 'браузеры идут напрямую — нажми, чтобы включить защищённый канал';
    return on;
  } catch {
    btn.textContent = '🌐 Системный прокси: ?';
    return null;
  }
}

$('proxy-btn').addEventListener('click', async () => {
  const btn = $('proxy-btn');
  btn.disabled = true;
  try {
    const cur = await window.sonic.proxyGet();
    const target = !(cur && cur.ok && cur.enabled);
    const r = await window.sonic.proxySet(target);
    if (!r || !r.ok) {
      setMsg('Не получилось переключить системный прокси', 'err');
    } else {
      setMsg(target ? 'Системный прокси включён — обнови вкладки браузера.' : 'Системный прокси выключен — браузеры идут напрямую.', 'ok');
    }
  } catch (e) {
    setMsg(e.message, 'err');
  } finally {
    btn.disabled = false;
    refreshProxyBtn();
  }
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
    updatePingChip(r.diag);
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
  if (p.state === 'connected' || p.state === 'disconnected') refreshProxyBtn();
});
window.sonic.onDiag((p) => {
  if (!p) return;
  renderDiag(p.diag);
  renderReport(p.report);
  updatePingChip(p.diag);
  if (p.diag && ((p.diag.t4 && p.diag.t4.ok) || (p.diag.t5 && p.diag.t5.ok))) {
    setMsg('Подключено. Сайты идут через VPN — проверяй браузер.', 'ok');
  }
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
refreshProxyBtn();
updateServerChip();
initProfile();