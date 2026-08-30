import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { cfg } from '../config.js';
import { q, nowISO } from '../db.js';
import { xui } from './xui.js';

/**
 * Профиль = { vless_link, config_text, host, port, uuid, demo:boolean }
 *
 * Mock-провайдер (по умолчанию): детерминированный VLESS+Reality профиль
 * с демо-хостом. Реально: 3x-ui на Oracle Cloud VPS (provider ниже).
 */
function mockProfile(user) {
  const seed = crypto.createHash('sha256').update(`vpnstar:${user.id}`).digest();
  const uuid = [
    seed.subarray(0, 4).toString('hex'), seed.subarray(4, 6).toString('hex'),
    seed.subarray(6, 8).toString('hex'), seed.subarray(8, 10).toString('hex'),
    seed.subarray(10, 14).toString('hex'),
  ].join('-');
  const host = cfg.vpn_demo_host;
  const port = 443;
  const sni = 'www.microsoft.com';
  const pbk = 'sLpYQmH1zX8vT3bN9kJ5dR2fG7wCeUaV4hM6oB8qPy='; // демонстрационный
  const fp = 'chrome';
  const link =
    `vless://${uuid}@${host}:${port}?encryption=none&security=reality&sni=${sni}&pbk=${pbk}&fp=${fp}&type=tcp#VpnStar`;
  // конфиг в base64 (формат share v2ray) — импортируется в v2rayNG / Streisand / Hiddify
  const share = {
    vless: [{
      uuid, address: host, port: String(port), flow: '',
      security: 'reality', realityOpts: { publicKey: pbk, shortId: '', fingerprint: fp, serverName: sni, spiderX: '/' },
      network: 'tcp', type: 'none',
    }],
  };
  const config_text = Buffer.from(JSON.stringify(share), 'utf8').toString('base64');
  return { vless_link: link, config_text, host, port, uuid, demo: true };
}

export const provider = {
  name: () => (cfg.xui_base ? '3x-ui' : 'mock'),

  async provision(user) {
    // если клиент уже есть — не плодим
    const existing = q.client(user.id);
    if (existing && existing.provider === this.name()) return existing.ref_id;

    let refId;
    if (cfg.xui_base) {
      refId = await xui.addVlessClient(user);
    } else {
      refId = `mock-${user.id}`;
    }
    if (existing) q.insertClient(user.id, this.name(), refId);
    else q.insertClient(user.id, this.name(), refId);
    return refId;
  },

  async profile(user) {
    if (cfg.xui_base) {
      try {
        return await xui.profileFor(user);
      } catch (e) {
        console.error('[vpn] xui profile failed, fallback mock:', e.message);
      }
    }
    return mockProfile(user);
  },

  async qrDataUrl(profile) {
    return QRCode.toDataURL(profile.vless_link, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  },

  async qrBuffer(link) {
    return QRCode.toBuffer(link, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
  },

  nowISO,
};
