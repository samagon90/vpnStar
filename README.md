# ✦ vpnStar

Собственный VPN-сервис: хостинг за рубежом, оплата по **СБП**, себестоимость инфраструктуры **≈ 0 ₽/мес**.

## Ключевые фишки (MVP)
1. **Сайт работает в РФ без VPN** — фронт на Cloudflare Pages, API за Cloudflare-прокси (скрывает origin)
2. **Регистрация без подтверждения почты и номера** — логин + пароль; email опционален (без верификации)
3. **Оплата по СБП QR** — ЮKassa (комиссия 0,4% для самозанятых) + карты РФ; тестовый режим `PAYMENT_MODE=mock`
4. **Три тарифа** — 1 мес 199 ₽ / 3 мес 499 ₽ / 12 мес 1 499 ₽ (+ 7 дней бесплатно новым)
5. **Реферальная программа 20%** — с каждой оплаты приглашённых (включая продления); балансом можно платить
6. **Telegram**: бот (покупка, профиль, статистика), канал, **поддержка с нейронкой** (любой OpenAI-совместимый API, фолбэк на FAQ)
7. **Статистика рефералов** — email, TG, дата подключения, активность, сумма оплат, заработок 20%
8. **Синхронизация аккаунта с TG** — Telegram Login Widget на сайте + `/start` и `/link` в боте

## Структура
```
public/           — сайт (лендинг, вход/регистрация, кабинет, чекаут) — без сборки
server/           — Node.js 20+ / Express + SQLite (better-sqlite3) + Grammy (бот)
  src/routes/     — auth, pay (ЮKassa + mock), account (подписка, рефералка), webhooks
  src/vpn/        — провайдеры: mock (демо VLESS+Reality) и 3x-ui (реальный VPS)
  src/bot.js      — TG-бот: меню, покупка СБП, рефералка, AI-поддержка
  src/ai.js       — нейросетевая поддержка (OpenAI-совместимый API / FAQ-фолбэк)
  src/cron.js     — напоминания об окончании подписки (5/2/1 день: TG + email)
data/             — SQLite-база (создаётся автоматически)
docs/             — ANALYSIS.md (24hype + конкуренты), PLAN.md (концепция, 0₽-архитектура, риски)
```

## Запуск (локально, тестовый режим)
```bash
cd server
npm install
cp .env.example .env        # PAYMENT_MODE=mock по умолчанию — «Я оплатил» работает сразу
npm start                   # http://localhost:8080
```
- Регистрация → 7 дней пробного → QR-профиль (демо VLESS+Reality)
- Оплата: `POST /api/payments {plan_id}` → mock-подтверждение → подписка + бонус рефереру

## Боевой запуск (кратко)
1. Oracle Cloud Always Free VPS (Франкфурт/Амстердам) + 3x-ui: `XUI_BASE/XUI_USER/XUI_PASSWORD` в `.env`
2. Самозанятый → ЮKassa: `PAYMENT_MODE=yookassa`, `YOOKASSA_SHOP_ID/SECRET_KEY`
3. BotFather → `TG_BOT_TOKEN`; канал → `TG_CHANNEL_URL`
4. ИИ-поддержка: `AI_API_BASE/AI_API_KEY/AI_MODEL` (OpenRouter/Groq/OpenAI/LM-Studio)
5. Деплой: `public/` → Cloudflare Pages; `/api/*` → reverse proxy на VPS за Cloudflare; домен .ru
6. Доменные детали и риски — в `docs/PLAN.md`
