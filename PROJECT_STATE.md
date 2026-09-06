# 🧠 PROJECT_STATE.md — карта памяти проекта (читай ПЕРВЫМ)

> **Для любого агента/разработчика, открывающего этот репозиторий впервые (в т.ч. при пустой песочнице):**
> клонируй репо → прочитай ЭТОТ файл → поднимай окружение по «Локальный запуск» →
> продолжай работу из раздела «Что дальше». Весь контекст проекта ниже, без потерь.

---

## 1. Что это

**Sonic VPN** (ранее назывался «VpnStar» — все вхождения в новом коде уже переименованы) —
собственный VPN-сервис для РФ: сайт + личный кабинет + Telegram-бот + AI-поддержка +
оплата по СБП (ЮKassa). Ключевое коммерческое ограничение владельца: **весь хостинг
покупается у российских провайдеров с EU-дата-центрами (оплата МИР/СБП из РФ)**,
приём денег от клиентов — СБП.

- Репозиторий: `github.com/samagon90/vpnStar`
- **Рабочая ветка: `arena/01a05219-vpnstar`** (актуальная; `main` — более старая, смержить в main когда владелец решит)
- Стадия: **код 100% готов и протестирован (mock-режим). Продакшен-деплой НЕ сделан** — ждёт действий владельца (VPS, домен, токен бота, ЮKassa, ключ Groq). Инструкция для владельца: `docs/LAUNCH.md` («на пальцах», 10 шагов) + `deploy/README.md` (техническая).

## 2. Стек и структура

Node.js 22, Express, **встроенный `node:sqlite`** (без нативных зависимостей), Grammy (TG-бот),
qrcode (QR), frontend — чистый HTML/CSS/JS без сборки.

```
public/                 сайт (статика): index (лендинг), auth, account (кабинет), checkout,
                        help.html («Как подключиться»: APK Sonic VPN, Streisand/Hiddify iOS, v2rayN)
  img/logo.png          логотип. ⚠️ ГЕНЕРИРОВАННЫЙ плейсхолдер (твой исходник так и не прилетел
                        в песочницу) — заменить файл = обновить бренд везде (шапки, favicon)
android/                наше Android-приложение «Sonic VPN»: ребрендинг v2rayNG 2.2.6 (GPLv3).
                        branding/ (иконки+цвета, overlay), icon-source.png, resize-icons.js,
                        workflow/sonicvpn-android.yml (зеркало для пуша в песочнице).
                        ⚠️ АКТИВНЫЙ воркфлоу — .github/workflows/main.yml (создан владельцем
                        через GitHub Web 2026-09-06; имя файла не важно, в Actions =
                        «Sonic VPN Android APK»). Песочница НЕ МОЖЕТ пушить create/update
                        файлов .github/workflows/ (GitHub App без workflows-прав), но
                        удалять — может. Ветка по умолчанию репозитория = arena/...
                        (Settings → General → Default branch), иначе Actions пустой.
                        Сборка: Actions → Run workflow → APK в Release sonicvpn-android;
                        стабильные ссылки releases/latest/download/SonicVPN-arm64-v8a.apk
                        ✅ Готово (2026-09-06): сборка успешна (run на d6a4ee9), релиз
                        «Sonic VPN Android v1.0.0» с 3 APK (33.4/33.8/74.9 MB); ссылки
                        на help.html/боте/лендинге ЖИВЫЕ. История бага: в sed NDK-шага
                        потерялась backslash-строка → фикс 7cc4ef6 (мержить ТОЛЬКО этот
                        вид файла, не ломать строку `          \` перед ndkVersion).
  css/site.css          дизайн-система: Sonic-синий #1e6fff / #45b8ff
  js/api.js             API-хелпер (fetch, API_BASE='' — для split-хостинга на CF Pages)
server/                 бэкенд (npm start; package.json name=sonic-vpn-server)
  .env.example          шаблон всех переменных (с примерами Groq/OpenRouter/Gemini)
  src/index.js          Express: cookie-сессии, CORS (CORS_ORIGINS), статика, роутеры, запуск бота/cron
  src/config.js         ВСЕ бизнес-констанТЫ: PLANS (199/499/1499), DEVICES_BASE=2,
                        DEVICE_PACK_PRICE_CENTS=9900, DEVICE_PACK_MAX=8, REFERRAL_PERCENT=20, TRIAL_DAYS=7
  src/db.js             схема SQLite + миграции (addColumn try/catch) + все запросы (объект q)
  src/util.js           money() (39,80 ₽), хеши, parseCookies, randomRefCode
  src/ai.js             AI-поддержка: KB (база знаний) + userContextBlock (живые данные клиента)
                        + canned FAQ-фолбэк + обработка 429; любой OpenAI-совместимый API
  src/bot.js            TG-бот: меню, покупка (планы + устройство +1), QR по устройствам,
                        /devices /block N /unblock N, /link, /start, AI-поддержка
  src/cron.js           напоминания о конце подписки 5/2/1 день (TG + SMTP-опц)
  src/yookassa.js       ЮKassa REST (create/get/refund, webhook-токен) + mock-режим
  src/botref.js         мост бота для реф-статистики
  src/routes/auth.js    register (БЕЗ подтверждения почты/номера, транзакция, первое устройство
                        «Основное»), login, /auth/telegram (Login Widget + data.ref), /me, /logout
  src/routes/pay.js     /plans, POST / (checkout: план, use_balance), /:id/confirm-mock,
                        /history (ДО /:id — порядок важен!), /:id (поллинг), /:id/refund (X-Admin-Token)
                        applyPayment(): plan → продление подписки; devices → devices_extra++;
                        рефереру 20% от (amount + balance_used)
  src/routes/account.js /subscription (сводка устройств), /referrals (статистика рефералов), /email
  src/routes/devices.js / (список+лимиты), POST / (добавить, чек лимита), POST /buy (+1 устройство,
                        ДО /:id!), /:id (профиль+QR), /:id PATCH (name/enabled), DELETE (свободит слот)
  src/routes/webhooks.js ЮKassa webhook (payment.succeeded/canceled)
  src/vpn/provider.js   провайдер: mock (детерминированные VLESS+Reality, uuid от user+device,
                        remark #SonicVPN·имя) / 3x-ui; provisionDevice, profile, setDeviceEnabled, deleteDevice
  src/vpn/xui.js        API-клиент 3x-ui: 1 устройство = 1 клиент (limitIp:1), add/update/delClient
                        ⚠️ в песочнице НЕ тестировался (mock), проверить на боевом VPS
data/                   sonicvpn.db (runtime; в .gitignore; создаётся сам)
deploy/vps-setup.sh     автоподготовка VPS: 3x-ui + Caddy (авто-SSL) + UFW + fail2ban + Node22 + pm2
deploy/README.md        технический деплой (вкл. шаг 4.1 — бесплатная нейросеть Groq)
docs/LAUNCH.md          📘 ЧЁТКАЯ ИНСТРУКЦИЯ ДЛЯ ВЛАДЕЛЬЦА «с нуля» (10 шагов, на пальцах)
docs/PLAN.md            концепция: тарифы, инфраструктура под оплату из РФ, риски
docs/ANALYSIS.md        анализ 24hype.ru и конкурентов (рынок РФ)
```

## 3. Что уже реализовано (всё, без заглушек)

1. Сайт работает в РФ без VPN (архитектура: Cloudflare-прокси, origin скрыт; CORS для CF Pages)
2. Регистрация без почты/номера (email опционален, без верификации)
3. Оплата СБП: ЮKassa (sbp+card, webhook, 0,4%) + `PAYMENT_MODE=mock` для разработки
4. **Ровно 3 тарифа**: 1 мес 199 ₽ / 3 мес 499 ₽ / 12 мес 1 499 ₽ + **7 дней пробника** новым
5. **Рефералка 20%** со ВСЕХ оплат приглашённых (вкл. продления И докупку устройств) →
   на внутренний баланс, балансом можно платить (в т.ч. частично, `use_balance`)
6. TG: канал (ссылки в футере/боте), бот (покупка СБП, QR, рефералка, синхронизация),
   **AI-поддержка**: нейросеть (Groq бесплатно ~1000 q/день) + живые данные клиента в промпте
   + FAQ-фолбэк + 429-фолбэк
7. Статистика рефералов: email, TG, дата подключения, активность, сумма оплат, 20%
8. Синхронизация с TG: Login Widget (нужен API URL у BotFather) + `/start` + `/link <логин>`
9. **Устройства**: 2 включено (свой QR/uuid на каждое; в 3x-ui — отдельный клиент limitIp:1),
   докупка +1 = 99 ₽ (до 8 доп. слотов, всего до 10), **пользователь сам блокирует/включает/
   удаляет** устройства (кабинет + `/block N` `/unblock N` в боте); возврат откатывает слот
10. Напоминания 5/2/1 день (TG + email), гарантия возврата 3 дня (admin-токен), no-logs
11. **Своё Android-приложение «Sonic VPN»**: ребрендинг v2rayNG 2.2.6 (GPLv3) — приложение
    `ru.sonicvpn.app`, наша иконка/цвета; сборка — GitHub Actions (workflow sonicvpn-android),
    APK падает в GitHub Release. Сборка в песочнице НЕПРОВЕРЕНА (нет доступа к Maven/SDK) —
    запустить workflow вручную и убедиться, что APK выложился
12. **Страница «Как подключиться»** (`public/help.html`): Android (наш APK + инструкция),
    iOS (Streisand/Hiddify из App Store + инструкция), Windows (v2rayN), macOS/Linux (Hiddify),
    FAQ по подключению; ссылки на неё: шапка/футер лендинга, кабинет (раздел устройств),
    бот (/start, /help), AI-поддержка (ответы про подключение/устройства)

## 4. Бизнес-правила (меняются только в `server/src/config.js`)

| Правило | Значение |
|---|---|
| Тарифы | 19900 / 49900 / 149900 коп (1/3/12 мес), 5 устройств — НЕТ: 2 устройства в каждом |
| Пробник | 7 дней, автоматически при регистрации, без карты |
| Рефералка | 20% от (amount_cents + balance_used_cents) каждой paid-оплаты → balance_cents реферера |
| Устройства | DEVICES_BASE=2; +1 за 9900 коп; DEVICE_PACK_MAX=8; слот = строка devices (в т.ч. заблокированная) |
| Деньги | всегда в копейках; отображение `money()` → «39,80 ₽» |
| Лимиты | devices_extra ≤ 8; max devices = 10 |

## 5. База данных (SQLite, `data/sonicvpn.db`)

users (balance_cents, devices_extra, referral_code, referrer_id, tg_id, last_active_at),
sessions, subscriptions (kind trial/plan, expires_at), payments (kind plan/devices, item, qty,
bonus_cents, yk_payment_id), **devices** (user_id, name, provider, ref_id, enabled, blocked_at),
vpn_clients (legacy; миграция vpn_clients→devices выполняется автоматически при старте),
events, notifications.
Миграции старых БД — try/catch `ALTER TABLE ADD COLUMN` в `db.js` (безопасно повторять).

## 6. Переменные окружения (`.env`, шаблон `.env.example`)

`BASE_URL`, `SECRET_KEY`, `PAYMENT_MODE=mock|yookassa`, `YOOKASSA_*`, `TG_BOT_TOKEN`,
`TG_CHANNEL_URL`, `AI_API_BASE/KEY/MODEL` (Groq: api.groq.com/openai/v1 + llama-3.3-70b-versatile),
`SMTP_*` (опц), `XUI_BASE/USER/PASSWORD/HOST/PORT/SNI/PUB_KEY` (3x-ui; пусто → mock),
`VPN_DEMO_HOST`, `ADMIN_TOKEN` (возвраты), `CORS_ORIGINS` (split-хостинг на CF Pages).

## 7. Локальный запуск (30 секунд)

```bash
cd server && npm install && cp .env.example .env && npm start   # http://localhost:8080
```
Mock-режим сразу: регистрация → 7 дней + QR; «Я оплатил» активирует платёж; рефералка видна.
E2E-приёмка (curl): register → /api/devices (1/2) → add (2/2) → 3-е 400 {code:limit} →
devices/buy + confirm-mock (лимит 3) → PATCH enabled=false/true → DELETE (слот) →
реферал платит → +20% (у устройства — 19,80 ₽ с 99 ₽) → history строка «+X ₽ рефереру».

## 8. Ключевые технические решения (не ломать)

- **1 устройство = 1 VPN-клиент** (uuid): только так работает «блокировка конкретного устройства»
- Express: литеральные маршруты (`,/history`, `/buy`) регистрируются **ДО** параметрических `/:id`
- Реферальный бонус считается от `amount + balance_used` (полная стоимость, а не остаток)
- При отмене/сбое оплаты balance_used возвращается на баланс
- `parseCookies` ОБЯЗАН звать next() (иначе HTTP-ханги)
- ESM: `crypto` из `node:crypto` импортировать явно; SQLite — `node:sqlite` (без better-sqlite3)
- Бот: поддержка-режим по chatId; AI получает user-контекст (подписка/устройства/баланс)
- Логотип/палитра: плейсхолдер логотипа заменить → всё обновится (шапки, favicon, 4 страницы)

## 9. Ограничения / что НЕ проверено в песочнице

- 3x-ui-ветка (xui.js) — только mock протестирован; на VPS проверить add/update/delClient и shape настроек inbound
- ЮKassa — только mock; проверить в песочнице (YOOKASSA_IS_SANDBOX=true) и в бою
- SMTP/email — необязательный путь (уведомления уходят в TG без SMTP)
- Cron — проверен синтаксически; тайминги 5/2/1 день — по коду
- Логотип — плейсхолдер (см. §2)

## 10. Что дальше (план действий)

**Владелец (по `docs/LAUNCH.md`, всё уже написано):** 0 «Мой налог»+ЮKassa → 1 VPS Германия
(AdminVPS/Timeweb, МИР/СБП, автоплатёж) → 2 ssh → 3 `deploy/vps-setup.sh` → 4 3x-ui inbound
(VLESS Reality 443 + Hy2 8443) → 5 домен sonicvpn.ru + Cloudflare → 6 деплой `.env`+pm2 →
7 BotFather (sonicvpn_bot, API URL) → 8 Groq-ключ → 9 ЮKassa боевая → 10 чек-лист запуска.
**Агент:** (0) APK ПОПУБЛИКОВАН (2026-09-06, релиз sonicvpn-android) — ссылки живые;
при смене иконки/версии: push в песочницу + напомнить владельцу Actions → Run workflow
(новым раном, НЕ «Re-run jobs» — re-run крутит старый коммит);
(1) после деплоя VPS — проверить 3x-ui-ветку вживую (add/update/delClient, shape API);
(2) v2 из PLAN.md: вывод реферального баланса, автопродление, 2-й узел, YouTube-узел, Smart TV.

## 11. Постоянные ограничения владельца (нельзя нарушать)

- Хостинг: только провайдеры, принимающие **МИР/СБП из РФ** (AdminVPS, Timeweb); Oracle Free —
  только при наличии зарубежной карты
- Сайт: должен открываться в РФ **без VPN** (Cloudflare)
- Регистрация: **без** подтверждения почты/номера
- Тарифов **ровно 3**; рефералка **20%**; устройства: 2 включено + докупка
- Бренд: **Sonic VPN**, логотип — картинка владельца (сейчас плейсхолдер), синий #1e6fff
- Язык продукта: русский
