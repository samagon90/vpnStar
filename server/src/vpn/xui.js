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

  async api(path, body, retry = true, method) {
    if (this.cookies.size === 0) await this.login();
    const m = method ?? (body !== undefined ? 'POST' : 'GET');
    const hasBody = body !== undefined && body !== null;
    const res = await ufetch(`${cfg.xui_base}${path}`, {
      method: m,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': PANEL_UA,
        Origin: panelOrigin,
        Cookie: this.cookieHeader(),
        ...(hasBody || m === 'POST' ? { 'X-CSRF-Token': this.csrf } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
      dispatcher: xuiAgent,
    });
    collectCookies(res, this.cookies);
    // сессия истекла → один повтор после повторного входа
    if ((res.status === 401 || res.status === 403) && retry) {
      await this.login();
      return this.api(path, body, false, method);
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) throw new Error(`3x-ui ${path}: ${j.msg || res.status}`);
    return j.obj;
  }

  /** Список клиентов с трафиком из панели (online/total). */
  async clientStats() {
    const list = await this.api('/panel/api/inbounds/list');
    const rows = Array.isArray(list) ? list : (list?.rows || []);
    const vless = rows.find((r) => r.protocol === 'vless' && String(r.streamSettings || '').includes('realitySettings'))
      || rows.find((r) => r.protocol === 'vless');
    if (!vless) return [];
    const stats = vless.clientStats || [];
    return stats.map((s) => ({
      email: s.email,
      up: Number(s.up || 0),
      down: Number(s.down || 0),
      total: Number(s.up || 0) + Number(s.down || 0),
      last_ip: s.last_ip || '',
      enable: !!s.enable,
      limit_ip: s.limit_ip ?? -1,
    }));
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
    await this.reload();
    return ref;
  }

  /**
   * Применить изменения к работающему xray.
   *
   * 3x-ui v3 пишет клиентов в свою БД, но НЕ применяет их к работающему
   * процессу xray (config.json не пересоздаётся, gRPC-применение после
   * рестарта панели не срабатывает) — такой клиент «фантом»: в панели есть,
   * но не подключается, пока x-ui не перезапустят. Проверено вживую на
   * 3x-ui 3.7: /panel/api/clients/add и даже round-trip /inbounds/{get,update}
   * не регенерируют конфиг; полный рестарт x-ui пересобирает его из БД.
   *
   * Поэтому после каждого CRUD перезапускаем x-ui по SSH (иначе — «VPN
   * перестал работать» для каждого нового устройства). Доступ задаётся в .env:
   * XUI_REMOTE_HOST / XUI_REMOTE_PASSWORD (пароль root VPN-сервера).
   */
  async reload() {
    const host = cfg.xui_remote_host;
    const pass = cfg.xui_remote_password;
    if (!host || !pass) {
      console.warn('[xui] reload() пропущен: XUI_REMOTE_HOST или XUI_REMOTE_PASSWORD не заданы');
      return;
    }
    const p = String(pass).replace(/'/g, `'\\''`);
    const cmd = ["sshpass", "-p", p, "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=8",
      "root@" + host, "systemctl restart x-ui"].map((a) => `'${a}'`).join(' ');
    const execCmd = (await import('node:child_process')).exec;
    await new Promise((res, rej) =>
      execCmd(cmd, { timeout: 20000 }, (err) => (err ? rej(err) : res())),
    );
    // дать панели подняться и пересобрать config.json (проверено: ~5 сек)
    await new Promise((r) => setTimeout(r, 9000));
    this.cookies = new Map();
    this.csrf = ''; // сессия панели умерла — перелогинимся при следующем вызове
  }

  /** Включить/выключить клиента по ref (блокировка устройства пользователем).
   *
   *  3x-ui 3.7: /panel/api/clients/update НАДЁЖНО работает только с полным объектом
   *  (id + uuid), но при этом panel ИСПОРТИЛ uuid у клиента (в get после update
   *  вернулся uuid="75" = id) — такие клиенты перестают подключаться. Поэтому
   *  переключаем enable штатным round-trip /inbounds/{get,update}: берём inbound,
   *  меняем флаг у одного клиента, отправляем объект обратно (uuid не трогаем).
   *  Если состояние и так целевое — restart x-ui не делаем (лишние обрывы сессий). */
  async setClientEnabled(ref, enable) {
    const { id } = await this.inboundId();
    const obj = await this.api(`/panel/api/inbounds/get/${id}`);
    const clients = Array.isArray(obj?.settings?.clients) ? obj.settings.clients : null;
    if (!clients) throw new Error('3x-ui: в inbound нет settings.clients');
    const target = clients.find((c) => c.email === ref);
    if (!target) throw new Error(`client ${ref} not found in 3x-ui`);
    if (!!target.enable === !!enable) return; // уже в нужном состоянии — без рестарта
    target.enable = enable ? true : false;
    await this.api(`/panel/api/inbounds/update/${id}`, obj);
    await this.reload();
  }

  /** Удалить клиента (свободит слот устройства). */
  async delClient(ref) {
    // 3x-ui 3.x: del принимает ТОЛЬКО POST (GET → 404)
    await this.api(`/panel/api/clients/del/${encodeURIComponent(ref)}`, undefined, true, 'POST');
    await this.reload();
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
    const fp = process.env.REALITY_FP || 'safari';
    const link =
      `vless://${uuid}@${host}:${port}?security=reality&sni=${sni}&pbk=${pbk}&fp=${fp}&flow=xtls-rprx-vision&type=tcp${extra ? `&${extra}` : ''}#${remark}`;
    const realityOpts = { publicKey: pbk, serverName: sni, fingerprint: fp };
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
