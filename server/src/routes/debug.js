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
import tls from 'node:tls';
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
// (200/301/403), если туннель/сервер мёртв — 000 (timeout/reset/ssl-ошибка)
function tlsProbe(host, port, serverName, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (code, extra = '') => {
      if (settled) return;
      settled = true;
      try { req.end(); } catch { /* ignore */ }
      req.destroy();
      resolve(`${code} ${Date.now() - t0}ms ${extra}`.trim());
    };
    const req = tls.connect(
      { host, port, servername: serverName, rejectUnauthorized: false },
      () => req.end(),
    );
    req.setTimeout(timeoutMs, () => done('000', 'timeout'));
    req.on('response', (res) => done(String(res.statusCode)));
    req.on('error', (e) => done('000', e.code || e.message));
  });
}

async function runServerChecks() {
  const out = {
    time: new Date().toISOString(),
    from: 'ru-server',
    target: `${DE_HOST}:${DE_PORT}`,
  };
  if (!DE_HOST) {
    return { ...out, error: 'XUI_HOST/XUI_PORT не настроены' };
  }

  // 1) TCP до порта VPN
  out.tcp = await tcpProbe(DE_HOST, DE_PORT, 5000);

  // 2) Параметры инбоунда из панели (чтобы сравнить с профилем пользователя)
  try {
    const p = await xui.inboundParams();
    out.panel = { port: p.port, sni: p.sni, pbk: p.pbk, sid: p.sid };
    // 3) Reality-проба с реальным SNI
    if (p.sni) out.tls = await tlsProbe(DE_HOST, DE_PORT, p.sni, 10000);
  } catch (e) {
    out.panel = { error: `панель недоступна: ${e.message}` };
  }

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
  res.json(await runServerChecks());
});

export default router;
