// Sonic VPN for Windows — main process (Electron).
// Запускает xray-core (локальный socks/http-прокси), ставит системный прокси,
// IPC с UI, загрузка core при первом запуске, логирование.
'use strict';

const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const https = require('https');
const http = require('http');
const {
  runDiagnostics,
  buildReport,
  parseVlessLink,
  tcpProbe,
} = require('./diagnostics.js');
const { buildXrayConfig, SOCKS_PORT, HTTP_PORT } = require('./xray-config.js');

const XRAY_VERSION = 'v26.7.28'; // та же версия core, что на сервере
const XRAY_ZIP_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-windows-64.zip`;

const APP_DIR = path.join(app.getPath('appData'), 'SonicVPN');
const CORE_DIR = path.join(APP_DIR, 'core');
const XRAY_EXE = path.join(CORE_DIR, 'xray.exe');
const CONFIG_PATH = path.join(CORE_DIR, 'config.json');
const ERROR_LOG = path.join(CORE_DIR, 'xray-error.log');
const PROFILE_FILE = path.join(APP_DIR, 'profile.link');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');

let win = null;
let xrayProc = null;
let xrayLogTail = '';
let state = 'disconnected'; // disconnected | connecting | connected
let currentLink = '';
let autoconnect = false;

// ---------- автопереподключение (обрывы TSPU, смена сети, сон) ----------
let manualStop = true; // true — пользователь сам отключил/выходит, переподключаться не надо
let reconnectTimer = null;
let reconnectAttempt = 0;
let watchdogMiss = 0;
const RECONNECT_BACKOFF = [2000, 5000, 15000, 30000, 60000];

function clearReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect(reason) {
  clearReconnect();
  if (manualStop || !currentLink) return;
  lastFailReason = reason;
  reconnectAttempt += 1;
  if (reconnectAttempt > 5) {
    reconnectAttempt = 0;
    state = 'disconnected';
    send('status', { state: 'disconnected', message: 'Не переподключается после 5 попыток (' + reason + ') — обновите ссылку из Кабинета и нажмите «Подключить»' });
    return;
  }
  const delay = RECONNECT_BACKOFF[Math.min(reconnectAttempt - 1, RECONNECT_BACKOFF.length - 1)];
  state = 'connecting';
  send('status', { state: 'connecting', message: `Соединение потеряно (${reason}). Переподключение — попытка ${reconnectAttempt}…` });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startProxy(currentLink, { auto: true }).catch(() => scheduleReconnect(lastFailReason));
  }, delay);
}

let lastFailReason = 'обрыв соединения';

// сторож: раз в 20с проверяем локальный SOCKS; дважды мимо — пересоздаём туннель
setInterval(async () => {
  if (state !== 'connected' || manualStop || !currentLink) { watchdogMiss = 0; return; }
  try {
    const r = await tcpProbe('127.0.0.1', SOCKS_PORT, 3000);
    if (r.ok) { watchdogMiss = 0; return; }
  } catch { /* мимо */ }
  watchdogMiss += 1;
  if (watchdogMiss >= 2) {
    watchdogMiss = 0;
    reconnectAttempt = 0;
    stopXrayProcess();
    scheduleReconnect('локальный прокси не отвечает');
  }
}, 20000);

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ---------- сохранённый профиль (ключ подключается автоматически) ----------

function saveProfile(link) {
  try {
    ensureDir(APP_DIR);
    fs.writeFileSync(PROFILE_FILE, String(link || ''), 'utf8');
  } catch (e) {
    console.warn('saveProfile:', e.message);
  }
}

function loadProfile() {
  try {
    return fs.existsSync(PROFILE_FILE) ? fs.readFileSync(PROFILE_FILE, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function saveSettings() {
  try {
    ensureDir(APP_DIR);
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ autoconnect: !!autoconnect }), 'utf8');
  } catch (e) {
    console.warn('saveSettings:', e.message);
  }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      autoconnect = !!s.autoconnect;
    }
  } catch {
    /* ignore */
  }
}

// ---------- загрузка core (первый запуск) ----------

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 0) => {
      if (redirects > 5) return reject(new Error('слишком много редиректов'));
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, { headers: { 'User-Agent': 'SonicVPN-Windows' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return get(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('http ' + res.statusCode + ' при загрузке core'));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (onProgress && total) onProgress(Math.min(100, Math.round((got / total) * 100)));
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', (e) => {
          fs.unlink(dest, () => {});
          reject(e);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('timeout загрузки')));
    };
    get(url);
  });
}

function extractZip(zipPath, destDir) {
  // Windows: встроженный PowerShell Expand-Archive (без зависимостей)
  return new Promise((resolve, reject) => {
    const ps = [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ];
    execFile('powershell.exe', ps, { timeout: 300000 }, (err, so, se) => {
      if (err) return reject(new Error('Expand-Archive: ' + (se || err.message)));
      resolve();
    });
  });
}

async function ensureCore() {
  if (fs.existsSync(XRAY_EXE)) return { ok: true, installed: false };
  ensureDir(CORE_DIR);
  send('core-progress', { pct: 0, text: 'Скачиваем xray-core (≈40 МБ)…' });
  const zipPath = path.join(CORE_DIR, 'Xray-windows-64.zip');
  await downloadFile(
    XRAY_ZIP_URL,
    zipPath,
    (pct) => send('core-progress', { pct, text: 'Скачиваем xray-core… ' + pct + '%' }),
  );
  send('core-progress', { pct: 100, text: 'Распаковываем…' });
  await extractZip(zipPath, CORE_DIR);
  fs.unlink(zipPath, () => {});
  if (!fs.existsSync(XRAY_EXE)) throw new Error('xray.exe не найден после распаковки');
  return { ok: true, installed: true };
}

// ---------- системный прокси (HKCU — без прав администратора) ----------
// Важно: ProxyEnable обязан быть REG_DWORD (со строкой WinINET его игнорирует),
// каждый `reg add` — отдельный вызов (reg.exe выполняет только одну команду),
// после смены — рассылка SETTINGS_CHANGED/REFRESH, иначе Chrome/Edge подхватят
// настройки только после перезапуска.

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const PROXY_OVERRIDE = 'localhost;127.*;10.*;172.16.*;192.168.*;<local>';
const PROXY_SERVER = `http=127.0.0.1:${HTTP_PORT};https=127.0.0.1:${HTTP_PORT}`;

function regAdd(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['add', REG_PATH, ...args, '/f'], { timeout: 15000 }, (err) => {
      resolve(!err);
    });
  });
}

function notifyProxyChanged() {
  // fire-and-forget: без этого браузеры не замечают смену прокси без перезапуска
  return new Promise((resolve) => {
    const ps = 'Add-Type -MemberDefinition \'[DllImport("wininet.dll")] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\' -Name W -Namespace P;'
      + ' [P.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null;'
      + ' [P.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 }, () => resolve());
  });
}

async function setSystemProxy(on) {
  if (on) {
    const a = await regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1']);
    const b = await regAdd(['/v', 'ProxyServer', '/t', 'REG_SZ', '/d', PROXY_SERVER]);
    const c = await regAdd(['/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', PROXY_OVERRIDE]);
    if (!(a && b && c)) return false;
  } else {
    const a = await regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0']);
    if (!a) return false;
  }
  await notifyProxyChanged();
  return true;
}

function getSystemProxy() {
  const query = (name) => new Promise((resolve) => {
    execFile('reg.exe', ['query', REG_PATH, '/v', name], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
  return (async () => {
    const en = await query('ProxyEnable');
    const srv = await query('ProxyServer');
    const m = en.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
    const enabled = m ? parseInt(m[1], 16) === 1 : false;
    const sm = srv.match(/ProxyServer\s+REG_SZ\s+(.+)/);
    return { enabled, server: sm ? sm[1].trim() : '' };
  })();
}

// ---------- жизненный цикл xray ----------

async function waitForSocks(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await tcpProbe('127.0.0.1', SOCKS_PORT, 1500);
    if (r.ok) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

async function startProxy(link, opts = {}) {
  manualStop = false;
  clearReconnect();
  state = 'connecting';
  send('status', { state, message: 'Подключаем…' });
  try {
    const hasGeoip = fs.existsSync(path.join(CORE_DIR, 'geoip.dat'));
    const { cfg, parsed } = buildXrayConfig(link, { errorLogPath: ERROR_LOG, geoip: hasGeoip });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    // чистый error-лог
    fs.writeFileSync(ERROR_LOG, '', 'utf8');

    if (xrayProc) {
      try { xrayProc.kill(); } catch { /* ignore */ }
      xrayProc = null;
    }

    xrayLogTail = '';
    xrayProc = spawn(XRAY_EXE, ['run', '-c', CONFIG_PATH], {
      cwd: CORE_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onChunk = (buf) => {
      xrayLogTail = (xrayLogTail + buf.toString('utf8')).slice(-8000);
    };
    xrayProc.stdout.on('data', onChunk);
    xrayProc.stderr.on('data', onChunk);
    xrayProc.on('error', (e) => {
      send('status', { state: 'disconnected', message: 'xray не стартовал: ' + e.message });
      state = 'disconnected';
    });
    xrayProc.on('exit', (code) => {
      if (manualStop || !currentLink) {
        if (state === 'connected' || state === 'connecting') {
          state = 'disconnected';
          send('status', { state: 'disconnected', message: 'Отключено' });
        }
        return;
      }
      // упал сам (обрыв сети/TSPU/сон) — переподключаемся, а не висим мёртвым
      stopXrayProcess();
      scheduleReconnect('xray завершился, код ' + code);
    });

    const up = await waitForSocks(15000);
    if (!up) {
      const tail = (fs.existsSync(ERROR_LOG) ? fs.readFileSync(ERROR_LOG, 'utf8') : '') + xrayLogTail;
      throw new Error('локальный прокси не поднялся за 15с. ' + (tail.slice(-400) || 'без логов — возможно, порт занят другим приложением'));
    }
    const proxyOk = await setSystemProxy(true);
    currentLink = link;
    state = 'connected';
    reconnectAttempt = 0;
    watchdogMiss = 0;
    send('status', {
      state: 'connected',
      message: proxyOk
        ? 'Подключено. Системный прокси: ' + PROXY_SERVER
        : 'Подключено, НО системный прокси НЕ включился — нажми кнопку «🌐 Системный прокси» ниже',
      sysproxy: proxyOk,
    });
  } catch (e) {
    state = 'disconnected';
    stopXrayProcess();
    await setSystemProxy(false).catch(() => {});
    send('status', { state: 'disconnected', message: e.message });
    if (opts.auto) {
      // авто-попытка не удалась — продолжаем цикл переподключения
      scheduleReconnect(lastFailReason);
    } else {
      // ручная попытка провалилась — стоим, ждём пользователя (без самодеятельности)
      manualStop = true;
      clearReconnect();
    }
    throw e;
  }
}

function stopXrayProcess() {
  if (!xrayProc) return;
  const proc = xrayProc;
  xrayProc = null;
  try {
    if (process.platform === 'win32') {
      execFile('taskkill.exe', ['/F', '/T', '/PID', String(proc.pid)], () => {});
    } else {
      proc.kill();
    }
  } catch { /* ignore */ }
}

async function stopProxy() {
  manualStop = true;
  clearReconnect();
  reconnectAttempt = 0;
  watchdogMiss = 0;
  stopXrayProcess();
  await setSystemProxy(false).catch(() => {});
  state = 'disconnected';
  currentLink = '';
  send('status', { state: 'disconnected', message: 'Отключено' });
}

// ---------- диагностика ----------

function xrayStateText() {
  if (!xrayProc) return 'не запущен';
  if (xrayProc.exitCode !== null && xrayProc.exitCode !== undefined) return 'завершился (код ' + xrayProc.exitCode + ')';
  if (xrayProc.signalCode) return 'завершился (' + xrayProc.signalCode + ')';
  return 'работает (pid ' + xrayProc.pid + ')';
}

async function runDiag() {
  const profile = currentLink ? parseVlessLink(currentLink) : null;
  const proxyUp = state === 'connected';
  const d = await runDiagnostics(profile, { proxyUp, link: currentLink });
  let sysproxy = null;
  try { sysproxy = await getSystemProxy(); } catch { /* ignore */ }
  const report = buildReport(d, {
    appVersion: app.getVersion ? app.getVersion() : '?',
    mode: 'proxy ' + SOCKS_PORT + '/' + HTTP_PORT,
    xrayState: xrayStateText(),
    sysproxy: sysproxy ? `enabled=${sysproxy.enabled ? 1 : 0} server=${sysproxy.server || '—'}` : 'не прочитано',
    logTail: xrayLogTail.trim() ? xrayLogTail.trim().split('\n').slice(-20).join('\n') : '(пусто)',
  });
  return { diag: d, report, sysproxy };
}

// ---------- окно и IPC ----------

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 760,
    title: 'Sonic VPN — Windows',
    backgroundColor: '#0d1420',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('app:connect', async (_e, link) => {
  try {
    if (!/vless:\/\//i.test(String(link || '').trim())) {
      return { ok: false, error: 'Вставьте vless://-ссылку из Кабинета (кнопка «Скопировать» у устройства на сайте)' };
    }
    const core = await ensureCore();
    if (core.installed) send('core-progress', null);
    const trimmed = String(link).trim();
    await startProxy(trimmed);
    saveProfile(trimmed);
    const { diag, report } = await runDiag();
    return { ok: true, diag, report };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:disconnect', async () => {
  await stopProxy();
  return { ok: true };
});

ipcMain.handle('app:diagnose', async () => {
  const { diag, report, sysproxy } = await runDiag();
  return { ok: true, diag, report, sysproxy };
});

ipcMain.handle('app:proxy-get', async () => {
  try {
    const s = await getSystemProxy();
    return { ok: true, ...s };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:proxy-set', async (_e, on) => {
  try {
    const ok = await setSystemProxy(!!on);
    return { ok, ...(await getSystemProxy().catch(() => ({}))) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('app:get-profile', async () => {
  return { link: loadProfile(), autoconnect: !!autoconnect };
});

ipcMain.handle('app:set-autoconnect', async (_e, v) => {
  autoconnect = !!v;
  saveSettings();
  return { ok: true };
});

ipcMain.handle('app:copy-report', async (_e, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('app:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  return { ok: true };
});

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopXrayProcess();
  app.quit();
});

app.on('before-quit', () => {
  manualStop = true;
  clearReconnect();
  stopXrayProcess();
  try { setSystemProxy(false); } catch { /* ignore */ }
});
