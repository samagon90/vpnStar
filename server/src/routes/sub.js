import { Router } from 'express';
import { q } from '../db.js';
import { provider } from '../vpn/provider.js';

/**
 * Подписки «несколько точек в одном подключении»:
 *  - GET /api/sub/v2ray   — base64-список всех ссылок юзера (основные + запасные),
 *    импорт в v2rayNG / Streisand / Hiddify как Subscription;
 *  - GET /api/sub/singbox — sing-box JSON с автовыбором (selector + urltest):
 *    клиент сам меряет пинг и сидит на живой точке (Hiddify / Streisand).
 */

const r = Router();

function parseVless(link) {
  const m = String(link || '').match(/^vless:\/\/([^@]+)@([^:/]+):(\d+)\?(.*)$/);
  if (!m) return null;
  const q = {};
  for (const kv of m[4].split('#')[0].split('&')) {
    const i = kv.indexOf('=');
    if (i > -1) {
      try { q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch { q[kv.slice(0, i)] = kv.slice(i + 1); }
    }
  }
  return { uuid: m[1], host: m[2], port: Number(m[3]), q };
}

async function userLinks(user) {
  // параллельно: у пользователя обычно 1–3 устройства, каждое — 2 запроса к панели
  const perDevice = await Promise.all(
    q.devicesOf(user.id).map(async (d) => {
      if (!d.enabled) return [];
      try {
        const p = await provider.profile(user, d);
        const out = p?.vless_link ? [{ name: d.name, link: p.vless_link, reserve: false }] : [];
        const alt = await provider.altLink(user, d);
        if (alt) out.push({ name: `${d.name} резерв`, link: alt, reserve: true });
        return out;
      } catch {
        return []; // устройство без профиля — пропускаем
      }
    })
  );
  return perDevice.flat();
}

r.get('/v2ray', async (req, res) => {
  const links = await userLinks(req.user);
  if (!links.length) return res.status(404).type('text/plain').send('no devices');
  res.type('text/plain').send(Buffer.from(links.map((l) => l.link).join('\n')).toString('base64'));
});

r.get('/singbox', async (req, res) => {
  const links = await userLinks(req.user);
  if (!links.length) return res.status(404).json({ error: 'Нет устройств' });
  const outbounds = [];
  for (const { name, link } of links) {
    const p = parseVless(link);
    if (!p) continue;
    outbounds.push({
      type: 'vless',
      tag: `Sonic ${name}`,
      server: p.host,
      server_port: p.port,
      uuid: p.uuid,
      flow: 'xtls-rprx-vision',
      network: 'tcp',
      tls: {
        enabled: true,
        server_name: p.q.sni,
        utls: { enabled: true, fingerprint: p.q.fp || 'safari' },
        reality: { enabled: true, public_key: p.q.pbk, short_id: p.q.sid || '' },
      },
    });
  }
  if (!outbounds.length) return res.status(404).json({ error: 'Нет валидных ссылок' });
  const tags = outbounds.map((o) => o.tag);
  res.json({
    dns: {
      servers: [{ tag: 'google', address: 'tls://8.8.8.8' }],
      final: 'google',
    },
    outbounds: [
      ...outbounds,
      {
        type: 'selector', tag: '🚀 Sonic Auto', outbounds: tags,
        default: tags[0],
      },
      {
        type: 'urltest', tag: '⚡ Sonic Best', outbounds: tags,
        url: 'https://www.google.com/generate_204', interval: '10m', tolerance: 100,
      },
      { type: 'direct', tag: 'direct' },
    ],
    route: {
      rules: [{ protocol: 'dns', outbound: '⚡ Sonic Best' }],
      final: '🚀 Sonic Auto',
      auto_detect_interface: true,
    },
  });
});

export default r;
