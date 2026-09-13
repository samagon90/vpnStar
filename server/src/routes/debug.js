// Диагностика: серверные проверки (с RU-сервера).
// Всё, что можно проверить БЕЗ участия пользователя: TCP/TLS до DE:443,
// Reality-проба с реальным SNI, параметры инбоунда из панели 3x-ui.
//
//  /check  — для страницы /debug.html (нужен вход, req.user)
//  /server — ПУБЛИЧНЫЙ (без auth): его зовёт режим отладки в APK Sonic VPN.
//            Отдаёт только статусы + параметры инбоунда (pbk/sni/sid не секреты:
//            они уже есть в профиле клиента), никаких личных данных.
import { Router } from 'express';
import net from 'node:net';

import https from 'node:https';
import { xui } from '../vpn/xui.js';

const router = Router();

const DE_HOST = process.env.XUI_HOST || '';
const DE_PORT = Number(process.env.XUI_PORT || 443);

// Сырой TCP-пинг: порт принимает соединения или нет
function tcpProbe(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok, extra = '') => {
      sock.destroy();
      resolve(`${ok ? 'ok' : 'fail'} ${Date.now() - t0}ms ${extra}`.trim());
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

// TLS-проба с SNI реальнового сайта: если Reality жив — ответит ИСТИННЫЙ сайт
// (200/301/403), если туннель/сервер мёртв — 000 (timeout/reset/ssl-ошибка).
// ВАЖНО: https.request (а не голый tls.connect): реально шлём GET и ждём ответ.
// Голый сокет без HTTP-запроса не даёт ни 'response', ни таймаута после end() —
// промис зависал вечно (найден по pm2-логам 13.09).
function tlsProbe(host, port, serverName, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let req;
    const done = (code, extra = '') => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve(`${code} ${Date.now() - t0}ms ${extra}`.trim());
    };
    req = https.request(
      {
        host, port, servername: serverName,
        rejectUnauthorized: false,
        method: 'GET', path: '/',
        headers: { 'User-Agent': 'sonicvpn-diagnostics/1.0', Host: serverName },
      },
      (res) => done(String(res.statusCode)),
    );
    req.setTimeout(timeoutMs, () => done('000', 'timeout'));
    req.on('error', (e) => done('000', e.code || e.message));
    req.end();
  });
}

async function runServerChecks() {
  const t0 = Date.now();
  const lg = (m) => console.log(`[debug/server] ${m} (${Date.now() - t0}ms)`);
  const out = {
    time: new Date().toISOString(),
    from: 'ru-server',
    target: `${DE_HOST}:${DE_PORT}`,
  };
  if (!DE_HOST) {
    return { ...out, error: 'XUI_HOST/XUI_PORT не настроены' };
  }

  // 1) TCP до порта VPN
  lg('tcp probe start');
  out.tcp = await tcpProbe(DE_HOST, DE_PORT, 5000);
  lg(`tcp: ${out.tcp}`);

  // 2) Параметры инбоунда из панели (чтобы сравнить с профилем пользователя)
  try {
    lg('panel inboundParams start');
    const p = await Promise.race([
      xui.inboundParams(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('панель: timeout 15s')), 15000)),
    ]);
    lg('panel ok');
    out.panel = { port: p.port, sni: p.sni, pbk: p.pbk, sid: p.sid };
    // 3) Reality-проба с реальным SNI
    if (p.sni) {
      lg('tls probe start');
      out.tls = await tlsProbe(DE_HOST, DE_PORT, p.sni, 10000);
      lg(`tls: ${out.tls}`);
    }
  } catch (e) {
    lg(`panel error: ${e.message}`);
    out.panel = { error: `панель недоступна: ${e.message}` };
  }

  lg('done');
  return out;
}

// Для страницы /debug.html (auth: req.user ставит общий middleware в index.js)
router.get('/check', (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
  next();
}, async (req, res) => {
  res.json(await runServerChecks());
});

// Публичный: для режима отладки в APK (телефон, без сессии)
router.get('/server', async (req, res) => {
  const t0 = Date.now();
  console.log('[debug/server] >>> request arrived');
  try {
    const r = await runServerChecks();
    res.json(r);
    console.log(`[debug/server] <<< response sent (${Date.now() - t0}ms)`);
  } catch (e) {
    console.log(`[debug/server] !!! handler error: ${e && e.message}`);
    try { res.status(500).json({ error: String(e && e.message || e) }); } catch { /* уже ушло */ }
  }
});

export default router;
