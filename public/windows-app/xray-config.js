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

  const realitySettings = {
    show: false,
    xver: 0,
    serverNames: p.sni ? [p.sni] : [],
    fingerprint: p.fp || 'chrome',
    publicKey: p.pbk || '',
    shortId: p.sid || '',
    spiderX: p.spx || '',
  };
  // пустые serverNames — невалидно для reality
  if (!p.sni) throw new Error('В ссылке нет sni= (SNI) — проверьте ссылку из Кабинета');
  if (!p.pbk) throw new Error('В ссылке нет pbk= (публичный ключ) — проверьте ссылку из Кабинета');

  const cfg = {
    log: { loglevel: 'warning' },
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
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', network: 'dns', outboundTag: 'proxy' },
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
      ],
    },
  };
  if (opts.errorLogPath) cfg.log.error = opts.errorLogPath;
  return { cfg, parsed: p };
}

module.exports = { buildXrayConfig, SOCKS_PORT, HTTP_PORT };
