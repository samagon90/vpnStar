/**
 * Клиент панели 3x-ui (v3 API). Используется, когда в .env задан XUI_BASE.
 *
 * Особенности v3 (проверено по исходникам MHSanaei/3x-ui):
 *  - вход: GET {base}/csrf-token (создаёт сессию + токен) →
 *    POST {base}/login с cookie сессии и заголовком X-CSRF-Token;
 *  - ВСЕ POST к /panel/api/* тоже требуют X-CSRF-Token (session-сессия);
 *  - клиенты живут в отдельной группе: /panel/api/clients/add,
 *    /panel/api/clients/get/:email, /panel/api/clients/update/:email,
 *    /panel/api/clients/del/:email (старых /inbound/addClient больше нет).
 *
 * Ответы — JSON {success, msg, obj}. Панель на self-signed/LE SSL:
 * отдельный undici-agent с rejectUnauthorized:false (только для панели).
 */
import { Agent, fetch as ufetch } from 'undici';
import crypto from 'node:crypto';
import { cfg } from '../config.js';

// ВАЖНО: fetch и Agent — из ОДНОГО пакета undici. Системный (global) fetch
// отклоняет Agent npm-undici другой версии (UND_ERR_INVALID_ARG),
// поэтому весь трафик к панели идёт через ufetch (undici.fetch).
const xuiAgent = new Agent({ connect: { rejectUnauthorized: false } });

const PANEL_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
let panelOrigin = '';
try {
  panelOrigin = new URL(cfg.xui_base).origin;
} catch { /* пусто */ }

function collectCookies(res, store) {
  const sc = res.headers.get('set-cookie') || '';
  for (const part of sc.split(/,(?=\s*\w+=)/)) {
    const nv = part.split(';')[0].trim();
    if (!nv || !nv.includes('=')) continue;
    store.set(nv.split('=')[0], nv);
  }
}

class Xui {
  cookies = new Map();
  csrf = '';

  cookieHeader() {
    return [...this.cookies.values()].join('; ');
  }

  async login() {
    this.cookies = new Map();
    this.csrf = '';
    // 1) CSRF-токен (заодно создаёт сессию и кладёт cookie)
    const t = await ufetch(`${cfg.xui_base}/csrf-token`, {
      headers: { 'User-Agent': PANEL_UA },
      dispatcher: xuiAgent,
    });
    collectCookies(t, this.cookies);
    const tj = await t.json().catch(() => ({}));
    if (!tj.obj) throw new Error(`3x-ui: csrf-token не получен (${t.status})`);
    this.csrf = String(tj.obj);
    // 2) вход
    const res = await ufetch(`${cfg.xui_base}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PANEL_UA,
        Origin: panelOrigin,
        Cookie: this.cookieHeader(),
        'X-CSRF-Token': this.csrf,
      },
      body: JSON.stringify({ username: cfg.xui_user, password: cfg.xui_password }),
      dispatcher: xuiAgent,
    });
    collectCookies(res, this.cookies);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`3x-ui login failed: ${j.msg || res.status}`);
  }

  async api(path, body, retry = true) {
    if (this.cookies.size === 0) await this.login();
    const res = await ufetch(`${cfg.xui_base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PANEL_UA,
        Origin: panelOrigin,
        Cookie: this.cookieHeader(),
        ...(body ? { 'X-CSRF-Token': this.csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      dispatcher: xuiAgent,
    });
    collectCookies(res, this.cookies);
    // сессия истекла → один повтор после повторного входа
    if ((res.status === 401 || res.status === 403) && retry) {
      await this.login();
      return this.api(path, body, false);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`3x-ui ${path}: ${j.msg || res.status}`);
    return j.obj;
  }

  async inboundId() {
    // первый VLESS inbound с Reality (создаётся deploy/xui-setup.sh)
    const list = await this.api('/panel/api/inbounds/list');
    const rows = Array.isArray(list) ? list : (list?.rows || []);
    const row =
      rows.find((r) => r.protocol === 'vless' && String(r.streamSettings || '').includes('realitySettings')) ||
      rows.find((r) => r.protocol === 'vless');
    if (!row) throw new Error('3x-ui: VLESS inbound не найден (запустите deploy/xui-setup.sh на VPN-сервере)');
    return { id: row.id, port: row.port, row };
  }

  async clientByEmail(email) {
    // v3: клиент вложен: obj = { client: {...} } — достаём внутренний объект
    const o = await this.api(`/panel/api/clients/get/${encodeURIComponent(email)}`);
    return o?.client ?? o;
  }

  /**
   * Reality-параметры (pbk, SNI, shortId, spiderX, порт) берутся НАПРЯМУЮ
   * из панели — это то, с чем реально работает xray. Копия в .env
   * (XUI_PUB_KEY/XUI_SNI) — только последний фолбэк. Кэш 5 минут.
   */
  #params = null;
  async inboundParams(force = false) {
    if (!force && this.#params && Date.now() - this.#params.at < 5 * 60 * 1000) return this.#params;
    const { row, port } = await this.inboundId();
    const ss = typeof row.streamSettings === 'string' ? JSON.parse(row.streamSettings) : row.streamSettings || {};
    const rs = ss.realitySettings || {};
    const pbk = String(rs.publicKey || process.env.XUI_PUB_KEY || '');
    const sni = String(rs.serverNames?.[0] || process.env.XUI_SNI || 'www.microsoft.com');
    const sid = Array.isArray(rs.shortIds) && rs.shortIds.length ? String(rs.shortIds[0]) : '';
    const spx = String(rs.spiderX || '');
    if (!pbk) throw new Error('3x-ui: не найден reality publicKey в инбаунде');
    this.#params = { pbk, sni, sid, spx, port, at: Date.now() };
    return this.#params;
  }

  /**
   * Один клиент 3x-ui = ОДНО устройство (limitIp: 1).
   * email = наш стабильный ref. UUID генерирует сама панель
   * (v3: per-protocol secrets server-side; поле — `uuid`, не `id`).
   */
  async addVlessClient(user, device) {
    const { id } = await this.inboundId();
    const ref = `vs-u${user.id}-d${device.id}-${Date.now().toString(36)}`;
    await this.api('/panel/api/clients/add', {
      client: {
        security: '',
        email: ref,
        flow: 'xtls-rprx-vision',
        limitIp: 1,
        totalGB: 0,
        enable: true,
        comment: `Sonic u${user.id} d${device.id}`,
      },
      inboundIds: [id],
    });
    return ref;
  }

  /** Включить/выключить клиента по ref (блокировка устройства пользователем). */
  async setClientEnabled(ref, enable) {
    const c = await this.clientByEmail(ref);
    if (!c) throw new Error(`client ${ref} not found in 3x-ui`);
    c.enable = !!enable;
    await this.api(`/panel/api/clients/update/${encodeURIComponent(ref)}`, c);
  }

  /** Удалить клиента (свободит слот устройства). */
  async delClient(ref) {
    await this.api(`/panel/api/clients/del/${encodeURIComponent(ref)}`);
  }

  async profileFor(device) {
    if (!device || !device.ref_id) throw new Error('no device ref');
    const c = await this.clientByEmail(device.ref_id);
    if (!c) throw new Error('client not found in 3x-ui');
    // v3 API: uuid — поле `uuid` (объект клиента уже развёрнут в clientByEmail)
    const uuid = String(c.uuid || c.id || '');
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(uuid)) {
      throw new Error(`client uuid not found in 3x-ui (keys: ${Object.keys(c).join(',')})`);
    }
    const { pbk, sni, sid, spx, port: rport } = await this.inboundParams();
    const host = process.env.XUI_HOST || 'vpn.example.com';
    const port = process.env.XUI_PORT || rport || 443;
    const remark = `SonicVPN · ${device.name || 'device'}`.replace(/[#\s]/g, (m) => (m === '#' ? '' : '%20'));
    const extra = [
      sid ? `sid=${encodeURIComponent(sid)}` : '',
      spx ? `spx=${encodeURIComponent(spx)}` : '',
    ].filter(Boolean).join('&');
    const link =
      `vless://${uuid}@${host}:${port}?security=reality&sni=${sni}&pbk=${pbk}&fp=chrome&flow=xtls-rprx-vision&type=tcp${extra ? `&${extra}` : ''}#${remark}`;
    const realityOpts = { publicKey: pbk, serverName: sni, fingerprint: 'chrome' };
    if (sid) realityOpts.shortId = sid;
    if (spx) realityOpts.spiderX = spx;
    const share = { vless: [{ uuid, address: host, port: String(port), security: 'reality', network: 'tcp', flow: 'xtls-rprx-vision', realityOpts }] };
    return {
      vless_link: link,
      config_text: Buffer.from(JSON.stringify(share)).toString('base64'),
      host, port, uuid, demo: false,
    };
  }
}

export const xui = new Xui();
