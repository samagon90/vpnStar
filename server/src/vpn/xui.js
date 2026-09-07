/**
 * Клиент панели 3x-ui (API). Используется, когда в .env задан XUI_BASE
 * (панель должна быть развёрнута на VPS: Oracle Cloud, см. docs/PLAN.md).
 *
 * Ожидаемый ответ API — JSON {success, msg, obj}. Авторизация: POST /login → cookie.
 * Конфигурация inbound (VLESS+Reality) создаётся при первоначальной настройке VPS
 * (docs/PLAN.md, этап 1); здесь добавляем/удаляем clients в готовом inbound.
 */
import { Agent } from 'undici';
import { cfg } from '../config.js';

// Панель 3x-ui работает по self-signed SSL. Отключаем проверку сертификата ТОЛЬКО
// для соединения с нашей же панелью (отдельный dispatcher; остальные HTTPS-запросы
// приложения — Groq и т.п. — продолжают проверять сертификаты).
const xuiAgent = new Agent({ connect: { rejectUnauthorized: false } });

class Xui {
  cookie = '';

  async login() {
    const res = await fetch(`${cfg.xui_base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: cfg.xui_user, password: cfg.xui_password }),
      dispatcher: xuiAgent,
    });
    const setc = res.headers.get('set-cookie') || '';
    const m = setc.match(/^(x-ui-[a-z]+-auth|auth)=([^;]+)/i);
    if (m) this.cookie = `${m[1]}=${m[2]}`;
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`3x-ui login failed: ${j.msg || res.status}`);
  }

  async api(path, body) {
    if (!this.cookie) await this.login();
    const res = await fetch(`${cfg.xui_base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.cookie,
        'x-client-token': this.cookie.split('=')[1] || '',
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: xuiAgent,
    });
    if (res.status === 401) { this.cookie = ''; return this.api(path, body); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`3x-ui ${path}: ${j.msg || res.status}`);
    return j.obj;
  }

  async inboundId() {
    // первый VLESS inbound с Reality (см. подготовка VPS)
    const list = await this.api('/panel/api/inbound/list');
    for (const row of list.rows || []) {
      const it = row.flow || row.settings;
      if (String(it).includes('vless')) {
        const net = row.settings ? JSON.parse(row.settings) : null;
        if (net && net.clients) return { id: row.id, net };
      }
      if (row.remark && /vless/i.test(row.remark)) return { id: row.id, net: null };
    }
    throw new Error('3x-ui: VLESS inbound не найден (создайте inbound при подготовке VPS)');
  }

  /**
   * Один клиент 3x-ui = ОДНО устройство (limitIp: 1).
   * Блокировка устройства = enable: false у его клиента.
   */
  async addVlessClient(user, device) {
    const { id } = await this.inboundId();
    const ref = `vs-u${user.id}-d${device.id}-${Date.now().toString(36)}`;
    // email-поле клиента у 3x-ui — уникальный идентификатор
    await this.api('/panel/api/inbound/addClient', {
      inboundId: id,
      settings: JSON.stringify({
        clients: [
          {
            id: ref,
            email: ref,
            flow: 'xtls-rprx-vision',
            limitIp: 1,
            totalGB: 0,
            enable: true,
          },
        ],
      }),
    });
    return ref;
  }

  /** Включить/выключить клиента по ref (блокировка устройства пользователем). */
  async setClientEnabled(ref, enable) {
    const { id, net } = await this.inboundId();
    const settings = net || JSON.parse((await this.api(`/panel/api/inbound/list`)).rows.find((r) => r.id === id)?.settings || '{}');
    const c = (settings.clients || []).find((x) => x.id === ref || x.email === ref);
    if (!c) throw new Error(`client ${ref} not found in 3x-ui`);
    c.enable = !!enable;
    await this.api('/panel/api/inbound/updateClient', { inboundId: id, settings: JSON.stringify(settings) });
  }

  /** Удалить клиента (свободит слот устройства). */
  async delClient(ref) {
    const { id } = await this.inboundId();
    await this.api('/panel/api/inbound/delClient', {
      inboundId: id,
      settings: JSON.stringify({ clients: [{ id: ref, email: ref }] }),
    });
  }

  async profileFor(device) {
    if (!device || !device.ref_id) throw new Error('no device ref');
    const { id, net } = await this.inboundId();
    const list = net ? net.clients : (await this.api('/panel/api/inbound/list')).rows.find((r) => r.id === id)?.settings;
    const clients = list && !Array.isArray(list) && list.clients ? list.clients : (typeof list === 'string' ? JSON.parse(list).clients : list);
    const c = (clients || []).find((x) => x.id === device.ref_id || x.email === device.ref_id);
    if (!c) throw new Error('client not found in 3x-ui');
    const host = process.env.XUI_HOST || 'vpn.example.com';
    const port = process.env.XUI_PORT || 443;
    const sni = process.env.XUI_SNI || 'www.microsoft.com';
    const pbk = process.env.XUI_PUB_KEY || '';
    const remark = `SonicVPN · ${device.name || 'device'}`.replace(/[#\s]/g, (m) => (m === '#' ? '' : '%20'));
    const link =
      `vless://${c.id}@${host}:${port}?encryption=none&security=reality&sni=${sni}&pbk=${pbk}&fp=chrome&flow=xtls-rprx-vision&type=tcp/#${remark}`;
    const share = { vless: [{ uuid: c.id, address: host, port: String(port), security: 'reality', network: 'tcp', flow: 'xtls-rprx-vision', realityOpts: { publicKey: pbk, serverName: sni, fingerprint: 'chrome' } }] };
    return {
      vless_link: link,
      config_text: Buffer.from(JSON.stringify(share)).toString('base64'),
      host, port, uuid: c.id, demo: false,
    };
  }
}

export const xui = new Xui();
