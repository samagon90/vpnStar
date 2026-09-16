import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { cfg } from '../config.js';
import { q, nowISO } from '../db.js';
import { xui } from './xui.js';

/**
 * Профиль = { vless_link, config_text, host, port, uuid, demo:boolean }
 *
 * Модель: ОДНО УСТРОЙСТВО = ОДИН VPN-клиент (uuid). Подписка включает DEVICES_BASE
 * устройства; докупка слотов — за деньги (payment kind='devices').
 * Блокировка устройства — пользователь сам включает/выключает своё устройство.
 *
 * Mock-провайдер (по умолчанию): детерминированный VLESS+Reality профиль
 * с демо-хостом. Реально: 3x-ui на VPS (xui.js).
 */
function uuidFrom(seedText) {
  const seed = crypto.createHash('sha256').update(seedText).digest();
  return [
    seed.subarray(0, 4).toString('hex'), seed.subarray(4, 6).toString('hex'),
    seed.subarray(6, 8).toString('hex'), seed.subarray(8, 10).toString('hex'),
    seed.subarray(10, 14).toString('hex'),
  ].join('-');
}

function mockProfileFor(user, device) {
  const uuid = uuidFrom(`sonicvpn:u${user.id}:d${device.id}`);
  const host = cfg.vpn_demo_host;
  const port = 443;
  const sni = 'www.microsoft.com';
  const pbk = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='; // демонстрационный (валидный X25519-формат, реальную пару даёт 3x-ui)
  const fp = cfg.reality_fp || 'chrome';
  const remark = `Sonic · ${device.name || 'device'}`.replace(/[#\s]/g, (m) => (m === '#' ? '' : '%20'));
  const link =
    `vless://${uuid}@${host}:${port}?security=reality&sni=${sni}&pbk=${pbk}&fp=${fp}&type=tcp#${remark}`;
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

  /** Создать VPN-клиент для устройства (1 устройство = 1 клиент). Обновляет device.ref_id.
   *  opts.force=true — пересоздать клиент в панели, даже если ref уже есть (клиент пропал). */
  async provisionDevice(user, device, opts = {}) {
    if (!opts.force && device.ref_id && device.provider === this.name() && device.provider !== 'pending') return device.ref_id;
    let refId;
    if (cfg.xui_base) {
      refId = await xui.addVlessClient(user, device);
    } else {
      refId = `mock-u${user.id}-d${device.id}`;
    }
    q.setDeviceRef(device.id, this.name(), refId);
    return refId;
  },

  /** Профиль устройства (VLESS-ссылка + конфиг).
   *
   *  Важно: в боевом режиме (cfg.xui_base) mock-профиль НЕ отдаём — поддельная ссылка
   *  не подключится и введёт пользователя в заблуждение. Если клиент пропал из панели
   *  (/clients/get -> record not found), автоматически пересоздаём его (новый ref + reload),
   *  а если панель недоступна — возвращаем понятную ошибку. */
  async profile(user, device) {
    if (!cfg.xui_base) return mockProfileFor(user, device);
    let d = device;
    try {
      if (d.provider === 'pending' || !d.ref_id) {
        await this.provisionDevice(user, d);
        d = q.device(d.id);
      }
      return await xui.profileFor(d);
    } catch (e) {
      console.warn('[vpn] xui profile failed, re-ensuring client:', e.message);
      try {
        await this.provisionDevice(user, q.device(d.id), { force: true });
        return await xui.profileFor(q.device(d.id));
      } catch (e2) {
        console.error('[vpn] xui profile failed even after re-ensure:', e2.message);
        throw new Error('Профиль временно недоступен — попробуйте ещё раз через минуту');
      }
    }
  },

  /** Запасная ссылка (второй вход панели). Нет второго входа — null, это нормально. */
  async altLink(user, device) {
    if (!cfg.xui_base) return null;
    try {
      let d = device;
      if ((d.provider === 'pending' || !d.ref_id)) {
        await this.provisionDevice(user, d);
        d = q.device(d.id);
      }
      const alt = await xui.profileForAlt(d);
      return alt ? alt.vless_link : null;
    } catch (e) {
      console.warn('[vpn] alt link unavailable:', e.message);
      return null;
    }
  },

  /** Блокировка/включение устройства пользователем */
  async setDeviceEnabled(device, enable) {
    if (cfg.xui_base && device.provider === '3x-ui' && device.ref_id) {
      try {
        await xui.setClientEnabled(device.ref_id, enable);
      } catch (e) {
        console.error('[vpn] xui setClientEnabled failed:', e.message);
      }
    }
    q.setDeviceEnabled(device.id, enable);
  },

  /** Удаление устройства (свободит слот) */
  async deleteDevice(device) {
    if (cfg.xui_base && device.provider === '3x-ui' && device.ref_id) {
      try {
        await xui.delClient(device.ref_id);
      } catch (e) {
        console.error('[vpn] xui delClient failed:', e.message);
      }
    }
    q.deleteDevice(device.id);
  },

  async qrDataUrl(profile) {
    return QRCode.toDataURL(profile.vless_link, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
  },

  async qrBuffer(link) {
    return QRCode.toBuffer(link, { width: 480, margin: 1, errorCorrectionLevel: 'M' });
  },

  nowISO,
};
