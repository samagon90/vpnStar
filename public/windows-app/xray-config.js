// Sonic VPN for Windows: генерация конфига xray из vless-ссылки.
// Чистый Node.js — тестируется в песочнице.
//
// Локальные inbound: socks 10808 + http 10809 (127.0.0.1) — для системного прокси
// и для диагностики. Всё трафик (вкл. DNS) уходит сквозь туннель:
//   routing: network=dns -> proxy (DNS-запросы резолвятся уже на сервере).
'use strict';

const { parseVlessLink } = require('./diagnostics.js');

const SOCKS_PORT = 10808;
const HTTP_PORT = 10809;

function buildXrayConfig(link, opts = {}) {
  const p = parseVlessLink(link);
  if (!p.host || !p.port || !p.uuid) throw new Error('Не удалось разобрать vless-ссылку');

  // reality-настройки ровно в форме, проверенной на v26.7.28 (см. deploy/diag-ru.sh):
  // serverName — СТРОКА (не serverNames-массив!), fingerprint, publicKey, shortId, show.
  // fingerprint по умолчанию safari: chrome-hello (>MTU) режется на путях из РФ (проверено
  // вживую 15.09.2026: chrome=таймаут, safari=ОК на том же маршруте).
  const realitySettings = {
    show: false,
    serverName: p.sni,
    fingerprint: p.fp || 'safari',
    publicKey: p.pbk || '',
    shortId: p.sid || '',
  };
  if (p.spx) realitySettings.spiderX = p.spx;
  // пустые serverNames — невалидно для reality
  if (!p.sni) throw new Error('В ссылке нет sni= (SNI) — проверьте ссылку из Кабинета');
  if (!p.pbk) throw new Error('В ссылке нет pbk= (публичный ключ) — проверьте ссылку из Кабинета');

  const cfg = {
    log: { loglevel: 'debug' },
    inbounds: [
      {
        tag: 'socks',
        listen: '127.0.0.1',
        port: SOCKS_PORT,
        protocol: 'socks',
        settings: { auth: 'noauth', udp: true },
      },
      {
        tag: 'http',
        listen: '127.0.0.1',
        port: HTTP_PORT,
        protocol: 'http',
        settings: { allowTransparent: false },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: p.host,
              port: p.port,
              users: [
                {
                  id: p.uuid,
                  encryption: 'none',
                  flow: p.flow || '',
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: p.type === 'ws' ? 'ws' : 'tcp',
          security: p.security || 'reality',
          realitySettings,
        },
      },
      { tag: 'direct', protocol: 'freedom' },
    ],
    // DNS: резолвим у 1.1.1.1/8.8.8.8, а сами DNS-запросы уводим сквозь туннель (routing ниже)
    dns: {
      servers: ['1.1.1.1', '8.8.8.8'],
    },
    // Сплит-маршрутизация: RU/СНГ + локалки идут НАПРЯМУЮ (быстрее, без капч банков/
    // госуслуг, меньше нагрузка на туннель), весь остальной мир — сквозь VPN.
    // domain-правило безопасно всегда; ip-правило (geoip:ru) — только если в папке ядра
    // есть geoip.dat (иначе xray не стартует): main.js передаёт opts.geoip=false.
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', network: 'dns', outboundTag: 'proxy' },
        {
          type: 'field',
          domain: [
            '.ru', '.xn--p1ai', '.su',
            '.by', '.kz', '.uz', '.az', '.ge', '.am', '.md', '.kg', '.tj', '.tm',
          ],
          outboundTag: 'direct',
        },
        ...(opts.geoip === false
          ? [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }]
          : [{ type: 'field', ip: ['geoip:private', 'geoip:ru'], outboundTag: 'direct' }]),
      ],
    },
  };
  if (opts.errorLogPath) cfg.log.error = opts.errorLogPath;
  return { cfg, parsed: p };
}

module.exports = { buildXrayConfig, SOCKS_PORT, HTTP_PORT };
