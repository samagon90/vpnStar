# Sonic VPN для Windows

Приложение для Windows 10/11 (64-bit): пользователь вставляет vless-ссылку из Кабинета
(или QR со скриншота) → приложение подключается к VPN (xray-core) → **показывает,
работает ли VPN реально** (проверки) + **режим отладки** с полным отчётом для поддержки.

## Архитектура

- **Electron** (v43.7.0) — оболочка. UI = HTML/JS в `renderer/`.
- **Ядро — xray-core v26.7.28** (та же версия, что на сервере DE): приложение
  скачивает `Xray-windows-64.zip` с GitHub-релизов при первом запуске
  (в `%APPDATA%\SonicVPN\core\`), запускает `xray.exe run -c config.json`.
- Локальные inbound: **socks 127.0.0.1:10808** (для диагностики) + **http 10809**
  (системный прокси, HKCU\...\Internet Settings — без прав администратора).
- DNS: 1.1.1.1/8.8.8.8, сами DNS-запросы уходят сквозь туннель
  (routing: `network=dns -> proxy`) — анти-отравлению.
- geoip:private → direct (LAN не трогает).

## Файлы

| Файл | Назначение |
|---|---|
| `public/install-sonicvpn.bat` | **Одно-двойной-клик сборщик на ПК пользователя.** Скачивает файлы приложения с **RU-сайта** (http://87.249.49.204/windows-app/, фолбэк — GitHub Pages), Electron (144 МБ) с GitHub, собирает `%USERPROFILE%\SonicVPN\`, создаёт ярлык. **Только ASCII + CRLF** (cmd.exe ломается на LF и на non-ASCII в консоли-CP437). Распаковка: `tar` (bsdtar, Win10+) → Expand-Archive. Скачивание: curl → iwr, RU → Pages. |
| `public/windows-app/main.js` | Electron main: загрузка/запуск/остановка xray, системный прокси, IPC, лог. |
| `public/windows-app/preload.js` | Мост UI↔main (contextIsolation). |
| `public/windows-app/diagnostics.js` | **Чистый Node.js (без Electron)**: T1 tcp, T2 tls(sni), T3 dns, T4/T5 https сквозь локальный socks5 (собственный SOCKS5-клиент, DNS в туннеле), T6 `/api/debug/server` RU-сайта. Парсинг vless://, вердикты, текст отчёта. |
| `public/windows-app/xray-config.js` | vless-ссылка → JSON-конфиг xray. |
| `public/windows-app/renderer/` | UI (index.html, style.css, ui.js, js/jsQR.js — QR-декодер, vendored через npm). |
| `public/windows-app/package.json` | `main: main.js`, версия. |

## Как доставляется пользователю (важно)

**Первичный канал — НАШ САЙТ (RU VPS, 87.249.49.204, без VPN)**. GitHub — фолбэк.
В песочнице нет доступа к CDN GitHub (objects.githubusercontent.com и др. — SSL 35/000),
поэтому **бинарники скачиваются на ПК пользователя**:

1. Страница `public/win-download.html` живёт на САЙТЕ (http://87.249.49.204/win-download.html
   — после деплоя) и на Pages. Кнопка «Скачать» — same-origin fetch `install-sonicvpn.bat`
   (рядом в public/), нормализует CRLF, сохраняет через Blob как `sonicvpn-windows.bat`.
   Ссылки: шапки index/account/help (`🖥 Windows`), блок #app, help.html.
2. **Деплой на RU-сайт — через `.\diag.bat`** (deploy/diag-ru.sh v15: git fetch + reset --hard
   + pm2 restart, порт берётся из .env на сервере; Т0-проверки /api/debug/server + windows-файлы
   → потом EXT-проверка пути телефона). Песочница в RU-сервер НЕ лезет (SSH/HTTP заблокированы
   egress'ом).
3. Bat скачивает **файлы приложения поштучно** с RU-сайта
   (http://87.249.49.204/windows-app/<file>), фолбэк — Pages
   (https://samagon90.github.io/vpnStar/public/windows-app/<file>). zip НЕ используется.
4. Electron zip: `https://github.com/electron/electron/releases/download/v43.7.0/electron-v43.7.0-win32-x64.zip` (с GitHub — со стороны ПК пользователя).

Порядок на ПК: `resources/app/` рядом с переименованным `electron.exe` → `SonicVPN.exe`.

## Проверено в песочнице (Linux)

- `node --check` всех JS.
- `diagnostics.js` **на живом сервере DE** (185.125.102.135:443): T1 TCP OK,
  T2 TLS (из песочницы — ECONNRESET: egress-фильтр песочницы, с телефона/ПК ожидается 200),
  T3 DNS OK, T6 RU (из песочницы RU-сайт недоступен — норма).
- **SOCKS5-клиент + HTTPS-через-туннель** — полный прогон на локальном
  SOCKS5-сервере (тест-харнесс в песочнице): 200/204/404 распознаются,
  одосегментный connect-reply (10 байт одним пакетом) обрабатывается
  (был баг readFully, который терял хвост чанка — исправлено buffered reader'ом).
- `main.js` с мок-модулем electron: 5 IPC-хендлеров, `app:diagnose` отдаёт отчёт.
- Структура сборки (electron + resources/app) проверена симуляцией.

## НЕ проверено (требует запуска на Windows)

- Запуск Electron-окна, reg.exe (системный прокси), taskkill, tar/curl на конкретном ПК.
- xray.exe с этим конфигом (reality-туннель на Windows), wintun НЕ используется
  (режима TUN нет — только socks/http + системный прокси; TUN v2, если понадобится).

## Обновление кода приложения

Поменял файл в `public/windows-app/` → push → пользователь: 1) `.\diag.bat`
(деплой на RU-сайт) 2) заново запускает `sonicvpn-windows.bat` (bat скачает
свежие файлы с RU-сайта). Никаких артефактов собирать не нужно.
⚠️ .bat-файлы: только ASCII + CRLF (см. .gitattributes: *.bat -text).

## Формат отчёта для поддержки

`SONIC-WIN-DEBUG <time>` / app+node / mode / xray-состояние / profile
(type server:port security sni pbk sid flow) / uuid / T1..T6 с таймингами /
xray-log-tail (последние 12 строк) / verdict (простым языком, что делать).
