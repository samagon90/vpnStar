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

// Запасной вход sonic-alt (тот же DE-сервер, другой порт/SNI/ключи).
// Тот же uuid клиента действует и там (панель создаёт клиента сразу на всех
// входах). При смене параметров alt-входа в панели — обновить здесь и на сайте.
const ALT_INBOUND = {
  port: 4433,
  sni: 'samsung.com',
  pbk: '92yqpOl-dWgszURGvvZSi0SZSSBQAzZ5ovm7gafZ42U',
  sid: '77c1e0',
};
// RU-мост в балансировщик НЕ входит: у него другой uuid — его нельзя вывести
// из вставленной ссылки. RU-ссылка остаётся ручным запасным вариантом.

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

  const vlessUser = {
    id: p.uuid,
    encryption: 'none',
    flow: p.flow || '',
  };
  const mainStream = {
    network: p.type === 'ws' ? 'ws' : 'tcp',
    security: p.security || 'reality',
    realitySettings,
    sockopt: { tcpFastOpen: true },
  };

  const outbounds = [
    {
      tag: 'proxy-main',
      protocol: 'vless',
      settings: { vnext: [{ address: p.host, port: p.port, users: [vlessUser] }] },
      streamSettings: mainStream,
    },
  ];

  // Автобалансировщик: второй выход на запасной вход того же сервера.
  // xray сам меряет пинг и шлёт трафик через живой выход (стратегия leastping).
  // Условие: ссылка — на DE-вход (а не RU-мост: там другой uuid и нет :4433).
  const isRuBridge = /^(87\.249\.49\.204|.*\.ru)$/i.test(p.host || '');
  const wantAlt = !isRuBridge && Number(p.port) === 443 && p.host && p.uuid;
  if (wantAlt) {
    outbounds.push({
      tag: 'proxy-alt',
      protocol: 'vless',
      settings: { vnext: [{ address: p.host, port: ALT_INBOUND.port, users: [vlessUser] }] },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          show: false,
          serverName: ALT_INBOUND.sni,
          fingerprint: p.fp || 'safari',
          publicKey: ALT_INBOUND.pbk,
          shortId: ALT_INBOUND.sid,
        },
        sockopt: { tcpFastOpen: true },
      },
    });
  }
  outbounds.push({ tag: 'direct', protocol: 'freedom' });

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
    outbounds,
    // DNS: резолвим у 1.1.1.1/8.8.8.8, а сами DNS-запросы уводим сквозь туннель (routing ниже)
    dns: {
      servers: ['1.1.1.1', '8.8.8.8'],
    },
    // Сплит-маршрутизация: RU/СНГ + локалки идут НАПРЯМУЮ (быстрее, без капч банков/
    // госуслуг, меньше нагрузка на туннель), весь остальной мир — через балансировщик.
    // domain-правило безопасно всегда; ip-правило (geoip:ru) — только если в папке ядра
    // есть geoip.dat (иначе xray не стартует): main.js передаёт opts.geoip=false.
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', network: 'dns', outboundTag: 'proxy-main' },
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
        // всё остальное — через автобалансировщик (если он есть) или напрямую в main
        ...(wantAlt
          ? [{ type: 'field', network: 'tcp,udp', balancerTag: 'auto' }]
          : [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy-main' }]),
      ],
      ...(wantAlt
        ? {
            balancers: [
              {
                tag: 'auto',
                selector: ['proxy-main', 'proxy-alt'],
                fallbackTag: 'proxy-main',
                strategy: { type: 'leastping' },
              },
            ],
          }
        : {}),
    },
    // Наблюдатель меряет живость выходов раз в 30с — балансировщик всегда знает,
    // какой выход реально отвечает, и переключается сам без участия пользователя.
    ...(wantAlt
      ? {
          observatory: {
            subjectSelector: ['proxy-main', 'proxy-alt'],
            probeUrl: 'https://www.google.com/generate_204',
            probeInterval: '30s',
          },
        }
      : {}),
  };
  if (opts.errorLogPath) cfg.log.error = opts.errorLogPath;
  return { cfg, parsed: p, balancer: wantAlt };
}

module.exports = { buildXrayConfig, SOCKS_PORT, HTTP_PORT };
