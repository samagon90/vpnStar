// Sonic VPN for Windows: диагностика.
// Чистый Node.js (без Electron) — весь этот файл тестируется в песочнице на живом сервере.
//
// Проверки:
//  T1 — прямой TCP до VPN-сервера (видит блокировку оператора: таймаут = пакеты не доходят)
//  T2 — прямой TLS до VPN-сервера с SNI профиля (Reality: ответит истинный сайт)
//  T3 — DNS телефона/ПК (локальный резолвер)
//  T4 — HTTPS youtube.com СКВОЗЬ туннель (SOCKS5 локального xray, DNS в туннеле)
//  T5 — HTTPS google.com/generate_204 сквозь туннель
//  T6 — статус сервера (RU-сайт сам проверяет себя: TCP/TLS/панель)
'use strict';

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http = require('http');
const https = require('https');

// Базы RU-сайта (где живёт API /api/debug/server)
const SITE_BASES = [
  'http://87.249.49.204',
  'https://87.249.49.204',
];
// Локальный прокси xray (задаётся в xray-config.js)
const SOCKS_HOST = '127.0.0.1';
const SOCKS_PORT = 10808;

// ---------- разбор vless-ссылки ----------

function parseVlessLink(link) {
  const u = {};
  const m = String(link || '').trim().match(/^vless:\/\/([^@]+)@([^:\/]+):(\d+)\?(.*)$/);
  if (!m) return u;
  u.uuid = m[1];
  u.host = m[2];
  u.port = parseInt(m[3], 10);
  for (const kv of m[4].split('#')[0].split('&')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    try {
      u[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    } catch {
      u[kv.slice(0, i)] = kv.slice(i + 1);
    }
  }
  return u;
}

// ---------- примитивы ----------

function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const done = (ok, extra = '') => {
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, extra });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

// TLS-рукопожатие с SNI профиля, сертификат — любой (реальность: ответит истинный сайт)
function tlsProbe(host, port, sni, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (ok, extra = '') => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve({ ok, ms: Date.now() - t0, extra });
    };
    const req = tls.connect(
      { host, port, servername: sni || host, rejectUnauthorized: false },
      () => done(true, req.getPeerCertificate()?.subject?.CN || 'handshake ok'),
    );
    req.setTimeout(timeoutMs);
    req.on('timeout', () => done(false, 'timeout'));
    req.on('error', (e) => done(false, e.code || e.message));
  });
}

function dnsProbe(domain) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dns.resolve4(domain, (err, addrs) => {
      if (err) return resolve({ ok: false, ms: Date.now() - t0, extra: err.code || err.message });
      resolve({ ok: true, ms: Date.now() - t0, extra: (addrs || []).join(', ') });
    });
    setTimeout(() => resolve({ ok: false, ms: Date.now() - t0, extra: 'timeout (заблокирован?)"' }), 10000).unref?.();
  });
}

// ---------- SOCKS5-клиент (DNS — в туннеле, ATYP=domain) ----------
// Критично: ответ сервера может прийти ОДНИМ сегментом (connect-reply 10 байт).
// Читаем строго через буфер: не читаем — не трогаем, прочитанное — не теряем.

function makeReader(stream) {
  const data = { buf: Buffer.alloc(0) };
  const waiters = [];
  const take = (n) => {
    const out = data.buf.slice(0, n);
    data.buf = data.buf.slice(n);
    return out;
  };
  const drain = () => {
    while (waiters.length) {
      const w = waiters[0];
      if (data.buf.length >= w.n) {
        waiters.shift();
        clearTimeout(w.t);
        w.resolve(take(w.n));
      } else break;
    }
  };
  stream.on('data', (chunk) => {
    data.buf = Buffer.concat([data.buf, chunk]);
    process.nextTick(drain);
  });
  const read = (n, timeoutMs) =>
    new Promise((resolve, reject) => {
      const w = {
        n,
        resolve,
        t: setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error('socks timeout'));
        }, timeoutMs),
      };
      waiters.push(w);
      drain();
    });
  return {
    read,
    // остаток после handshake (если сервер что-то прислал сразу) — прокинуть в туннель
    leftover: () => data.buf,
    detach: () => {
      data.buf = Buffer.alloc(0);
    },
  };
}

function socks5Tunnel(domain, port, socksHost = SOCKS_HOST, socksPort = SOCKS_PORT, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: socksHost, port: socksPort });
    const fail = (e) => {
      try { s.destroy(); } catch { /* ignore */ }
      reject(e);
    };
    s.once('error', (e) => fail(new Error(e.code || e.message)));
    s.once('connect', async () => {
      try {
        const reader = makeReader(s);
        s.write(Buffer.from([0x05, 0x01, 0x00]));
        const r1 = await reader.read(2, timeoutMs);
        if (r1[0] !== 0x05) throw new Error('not socks5');
        if (r1[1] !== 0x00) throw new Error('socks method rejected: ' + r1[1]);
        const db = Buffer.from(domain, 'utf8');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03]),
          Buffer.from([db.length]),
          db,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        s.write(req);
        const r2 = await reader.read(4, timeoutMs);
        if (r2[1] !== 0x00) throw new Error('socks connect reply: ' + r2[1]);
        if (r2[3] === 1) await reader.read(6, timeoutMs);
        else if (r2[3] === 4) await reader.read(18, timeoutMs);
        else if (r2[3] === 3) {
          const lenBuf = await reader.read(1, timeoutMs);
          await reader.read(lenBuf[0] + 2, timeoutMs);
        } else throw new Error('socks unknown atyp: ' + r2[3]);
        const left = reader.leftover();
        reader.detach();
        if (left.length) {
          // tls-сокет, которому мы отдадим s, должен увидеть эти байты
          process.nextTick(() => s.emit('data', left));
        }
        resolve(s);
      } catch (e) {
        fail(e);
      }
    });
  });
}

// HTTPS GET через туннель: SOCKS5 -> TLS -> HTTP-статус
function httpsGetViaSocks(domain, port, path, timeoutMs = 12000, socksHost = SOCKS_HOST, socksPort = SOCKS_PORT) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const done = (ok, extra = '') => resolve({ ok, ms: Date.now() - t0, extra });
    socks5Tunnel(domain, port, socksHost, socksPort, timeoutMs)
      .then((raw) => {
        const tlsReq = tls.connect({ socket: raw, servername: domain, rejectUnauthorized: false }, () => {
          tlsReq.write(
            `GET ${path} HTTP/1.1\r\nHost: ${domain}\r\nUser-Agent: SonicVPN-Windows-Debug\r\nConnection: close\r\n\r\n`,
          );
        });
        tlsReq.setTimeout(timeoutMs);
        let data = '';
        tlsReq.on('data', (c) => {
          data += c.toString('utf8');
          if (data.indexOf('\r\n') >= 0 && data.startsWith('HTTP/')) {
            const status = data.split(' ')[1] || '?';
            try { tlsReq.destroy(); } catch { /* ignore */ }
            done(status !== '404' && Number(status) >= 200 && Number(status) < 400, 'HTTP ' + status);
          }
        });
        tlsReq.on('timeout', () => { try { tlsReq.destroy(); } catch { /* ignore */ } done(false, 'timeout (TLS/ответ)'); });
        tlsReq.on('error', (e) => done(false, e.code || e.message));
      })
      .catch((e) => done(false, e.message));
    setTimeout(() => done(false, 'timeout (общий)'), timeoutMs + 2000).unref?.();
  });
}

// ---------- повтор с паузой ----------
// Часть сетей (ТСПУ/роутеры) при пачке новых соединений прибивают первые
// попытки; повтор без пары секунд проходит. Одиночная попытка даёт ложный FAIL.

function retried(fn, attempts = 2, pauseMs = 1600) {
  let last;
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      last = await fn();
      if (last && last.ok) return last;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, pauseMs));
    }
    return last;
  })();
}

// ---------- T6: статус сервера с RU-сайта ----------

function siteStatus(timeoutMs = 8000) {
  const tryBase = (base) =>
    new Promise((resolve) => {
      const lib = base.startsWith('https') ? https : http;
      const req = lib.get(
        base + '/api/debug/server',
        {
          timeout: timeoutMs,
          rejectUnauthorized: false,
          headers: { 'User-Agent': 'SonicVPN-Windows-Debug' },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () =>
            resolve({ ok: res.statusCode === 200, extra: `http=${res.statusCode} ${body.slice(0, 220)}` }),
          );
        },
      );
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => resolve({ ok: false, extra: `(${base}) ${e.code || e.message}` }));
    });
  return (async () => {
    for (const base of SITE_BASES) {
      const r = await tryBase(base);
      if (r.ok) return { ok: true, extra: r.extra.replace(/^\(\S+\) /, '') };
      // сайт отдал ошибку (не 200) — тоже показываем
      if (r.extra.startsWith('http=')) return r;
    }
    return { ok: false, extra: 'RU-сайт недоступен с этой сети' };
  })();
}

// ---------- сборка отчёта ----------

function formatLine(r) {
  if (!r) return 'n/a';
  const ms = typeof r.ms === 'number' ? r.ms + 'ms' : '?';
  if (r.ok) return `OK ${ms}${r.extra ? ' (' + r.extra + ')' : ''}`;
  return `FAIL ${r.extra || 'ошибка'} (${ms})`;
}

async function runDiagnostics(profile, opts = {}) {
  const t0 = Date.now();
  const P = profile || parseVlessLink(opts.link || '');
  const out = {
    time: new Date().toLocaleString('ru-RU'),
    profile: P && P.host ? P : null,
    t1: null, t2: null, t3: null, t4: null, t5: null, t6: null,
    ms: 0,
  };
  if (P && P.host && P.port) {
    out.t1 = await tcpProbe(P.host, P.port, 8000);
    out.t2 = await retried(() => tlsProbe(P.host, P.port, P.sni, 10000));
  }
  out.t3 = await dnsProbe('www.youtube.com');
  // T4/T5 — только если локальный прокси (xray) запущен
  const sHost = opts.socksHost || SOCKS_HOST;
  const sPort = opts.socksPort || SOCKS_PORT;
  if (opts.proxyUp === false) {
    out.t4 = { ok: false, ms: 0, extra: 'xray не запущен (нажмите «Подключить»)' };
    out.t5 = { ok: false, ms: 0, extra: 'xray не запущен (нажмите «Подключить»)' };
  } else {
    out.t4 = await retried(() => httpsGetViaSocks('www.youtube.com', 443, '/', 12000, sHost, sPort));
    out.t5 = await retried(() => httpsGetViaSocks('www.google.com', 443, '/generate_204', 10000, sHost, sPort));
  }
  out.t6 = await siteStatus(45000);
  out.ms = Date.now() - t0;
  return out;
}

// Вердикт простым языком
function makeVerdict(d) {
  const v = [];
  const p = d.profile;
  const tunnelOk = (d.t4 && d.t4.ok) || (d.t5 && d.t5.ok);
  const directOk = d.t1 && d.t1.ok;
  if (!p) {
    v.push('Профиль не разобран — вставьте корректную vless://-ссылку из Кабинета.');
  }
  if (p) {
    if (tunnelOk) {
      v.push('Туннель РАБОТАЕТ: сайты через VPN грузятся. Если в браузере не грузится — включите системный прокси в приложении (кнопка) и перезапустите браузер.');
    } else if (directOk && d.t2 && d.t2.ok) {
      v.push('Сервер из вашей сети достижим, но туннель НЕ работает: xray не запущен, профиль не соответствует серверу или ключи старые. Возьмите свежий QR/ссылку из Кабинета.');
    } else if (directOk && d.t2 && d.t2.ok === false) {
      v.push('TCP до сервера есть, но TLS-соединение рвётся (' + d.t2.extra + '): похоже, провайдер/сеть распознаёт и рвёт Reality-соединения (DPI/TSPU), либо параметры профиля устарели. Возьмите свежий QR и проверьте ещё раз; если повторится — сообщите, поменяем протокол.');
    } else if (d.t1 && d.t1.ok === false && String(d.t1.extra).includes('timeout')) {
      v.push('СЕРВЕР НЕДОСТИЖИМ ИЗ ВАШЕЙ СЕТИ (таймаут прямого подключения): оператор/сеть блокирует или роняет пакеты до VPN-сервера. Это блокировка провайдером — нужен смена протокола/узла.');
    } else if (d.t1 && d.t1.ok === false) {
      v.push('Прямое подключение к серверу упало: ' + d.t1.extra + '. Сервер может быть временно недоступен.');
    } else {
      v.push('Проверки не дали однозначного ответа — отправьте отчёт в поддержку.');
    }
    if (d.t3 && !d.t3.ok) v.push('DNS на вашем ПК/сети работает плохо: ' + d.t3.extra + ' (если ОС не находит обычные сайты — проверьте DNS роутера/ОС, рекомендуем 1.1.1.1 или 8.8.8.8; через туннель это не влияет, DNS резолвит VPN-сервер)');
  }
  if (d.t6 && d.t6.ok) {
    v.push('Сервер (со стороны RU) в порядке: ' + String(d.t6.extra).slice(0, 120));
  } else if (d.t6) {
    v.push('Статус сервера не получен: ' + d.t6.extra);
  }
  return v;
}

// Текст отчёта для копирования
function buildReport(d, extra = {}) {
  const p = d.profile || {};
  const s = [];
  s.push(`SONIC-WIN-DEBUG ${d.time}`);
  s.push(`app: ${extra.appVersion || '?'} / ${process.platform} ${process.arch} / node ${process.version}`);
  s.push(`mode: ${extra.mode || '?'}`);
  s.push(`xray: ${extra.xrayState || '?'}`);
  if (p.host) {
    s.push(`profile: type=vless server=${p.host}:${p.port} security=${p.security || 'reality'} sni=${p.sni || '?'} pbk=${(p.pbk || '?').slice(0, 14)}… sid=${p.sid || '?'} flow=${p.flow || '?'}`);
    s.push(`uuid: ${p.uuid || '?'}`);
  } else {
    s.push('profile: НЕ РАЗОБРАН (нет валидной vless-ссылки)');
  }
  s.push(`T1 direct-tcp ${p.host ? p.host + ':' + p.port : 'n/a'}: ${formatLine(d.t1)}`);
  s.push(`T2 direct-tls (sni=${p.sni || '?'}): ${formatLine(d.t2)}`);
  s.push(`T3 dns (local) youtube.com: ${formatLine(d.t3)}`);
  s.push(`T4 tunnel->www.youtube.com (dns via tunnel): ${formatLine(d.t4)}`);
  s.push(`T5 tunnel->google/generate_204: ${formatLine(d.t5)}`);
  s.push(`T6 site-status (RU): ${formatLine(d.t6)}`);
  if (extra.logTail) s.push('xray-log-tail:\n' + extra.logTail);
  s.push('verdict:');
  for (const line of makeVerdict(d)) s.push('  ' + line);
  return s.join('\n');
}

module.exports = {
  parseVlessLink,
  tcpProbe,
  tlsProbe,
  dnsProbe,
  retried,
  socks5Tunnel,
  httpsGetViaSocks,
  siteStatus,
  runDiagnostics,
  makeVerdict,
  buildReport,
  formatLine,
  SOCKS_HOST,
  SOCKS_PORT,
  SITE_BASES,
};
