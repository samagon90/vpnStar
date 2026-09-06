# Деплой Sonic VPN — пошагово (оплата из РФ)

Всё, что нужно для боевого запуска. Оплата хостинга — **картой РФ (МИР) или СБП**.
📖 **Пошаговый вариант «на пальцах» для новичка: `docs/LAUNCH.md` (он основной).**

## Архитектура: ДВА сервера (юридически чистая, 152-ФЗ)

- **RU-сервер (Россия)** — сайт, база клиентов (SQLite), TG-бот, админка. ~150–300 ₽/мес.
- **DE-сервер (Германия)** — только VPN: 3x-ui + xray (VLESS+Reality :443). ~400–700 ₽/мес.

Бэкенд на RU-сервере управляет 3x-ui на DE-сервере через API (`XUI_BASE`).
Клиентские приложения подключаются к VPN напрямую по IP DE-сервера (`XUI_HOST`).

## Шаг 0. Хостинг (оплата из России, без документов)

| Сервер | Провайдер | Локация | Цена | Оплата |
|---|---|---|---|---|
| RU (сайт+база) | **Timeweb Cloud** (или Beget / reg.ru) | Россия | от ~150–300 ₽/мес | МИР, **СБП** |
| DE (VPN) | **Aéza (aeza.net)** ⭐ | Германия (NL/FI/FR/UK) | от ~400–700 ₽/мес | МИР, **СБП**, крипта, почасово |
| DE (запасной) | VDSina | Амстердам | от ~200 ₽/мес | МИР, СБП (мин. 50$) |

Конфигы: RU — 1–2 vCPU / 2 GB / SSD; DE — 2 vCPU / 4 GB / NVMe. Ubuntu **24.04** (или 22.04).
AdminVPS — НЕ берём (требуют документы).

> 💡 Если есть **зарубежная** банковская карта — DE-сервер можно на Oracle Cloud Always Free
> (4 ядра ARM / 24 GB / 10 ТБ — бесплатно навсегда). Провайдер абстрагирован: в `.env`
> указывается только API 3x-ui.

## Шаг 1. Подготовка серверов

```bash
# РУССКИЙ сервер (сайт + база):
ssh root@IP_RU
# копируем vps-setup-ru.sh с GitHub (ветка arena/01a05219-vpnstar) в /root/
bash vps-setup-ru.sh sonicvpn.ru
# ставит: Caddy (авто-SSL), Node.js 22, pm2, UFW, fail2ban, swap. VPN-софта НЕТ.

# НЕМЕЦКИЙ сервер (только VPN):
ssh root@IP_DE
# копируем vps-setup-de.sh в /root/ (IP RU-сервера — для закрытия панели 3x-ui)
bash vps-setup-de.sh IP_RU
# ставит: 3x-ui, UFW (443 tcp/udp + 8443/udp + панель только с IP_RU), fail2ban, swap.
```

В конце DE-скрипта установщик 3x-ui печатает URL панели + логин + пароль.

### В панели 3x-ui (2–10 минут)
1. Зайти по URL, сменить пароли admin/panel
2. **Inbounds → Add**:
   - Тип **VLESS**, транспорт **TCP**, безопасность **Reality**
     - Сгенерировать ключи (Private/Public Key) — **запомнить Public Key**
     - СNI: `www.microsoft.com`, Flow: `xtls-rprx-vision`
     - Порт: `443` (или 2096 — не «типичный»)
   - Тип **Hysteria2** (UDP) — порт `8443` (запомнить CA-ключ)
3. **Portals** не трогаем. Firewall: разрешить выбранные UDP/TCP порты (Caddy уже открыт скриптом)

## Шаг 2. Домен + Cloudflare

1. Купить **sonicvpn.ru** (reg.ru, beget, nic.ru — оплата СБП, ~200–350 ₽/год)
   + запасной **sonic-vpn.com** (~350 ₽/год)
2. Завести бесплатный аккаунт **Cloudflare**, добавить домены
3. A-запись: `sonicvpn.ru` → IP узла 1 (прокси **ВКЛ** — оранжевое облако)
   A-запись: `api.sonicvpn.ru` → IP узла 1 (прокси ВКЛ)
   (DE-сервер в DNS не прописывается — VPN-клиенты ходят к нему напрямую по IP.)
4. Cloudflare бесплатно даёт: CDN (быстро в РФ), скрытие origin-IP от РКН, базовую DDoS-защиту

Сайт за Cloudflare **открывается в России без VPN** — это и есть фича №1.

## Шаг 3. Панель и бот (этот репозиторий)

На **RU-сервере**:

```bash
git clone -b arena/01a05219-vpnstar https://github.com/samagon90/vpnStar.git /opt/sonicvpn
cd /opt/sonicvpn/server
npm install
cp .env.example .env
nano .env   # заполнить, см. ниже
npm start   # в продакшене: pm2 start src/index.js --name sonicvpn
```

**`.env` (боевой):**
```
PORT=8080
BASE_URL=https://sonicvpn.ru
SECRET_KEY=<64 случайных символа: openssl rand -hex 32>
PAYMENT_MODE=yookassa
YOOKASSA_SHOP_ID=<id из личного кабинета ЮKassa>
YOOKASSA_SECRET_KEY=<секретный ключ>
YOOKASSA_IS_SANDBOX=false
TG_BOT_TOKEN=<токен от @BotFather>
TG_CHANNEL_URL=https://t.me/sonicvpn_channel
# ИИ-поддержка (любой OpenAI-совместимый API; пусто = FAQ-режим):
AI_API_BASE=https://openrouter.ai/api/v1
AI_API_KEY=sk-or-...
AI_MODEL=openai/gpt-4o-mini
XUI_BASE=http://<IP_DE_СЕРВЕРА>:<порт 3x-ui>   # панель на НЕМЕЦКОМ сервере
XUI_USER=<логин панели>
XUI_PASSWORD=<пароль панели>
XUI_HOST=<IP_DE_СЕРВЕРА>   # VPN-клиенты подключаются к нему напрямую
XUI_PORT=443
XUI_SNI=www.microsoft.com
XUI_PUB_KEY=<Public Key из шага 1>
ADMIN_TOKEN=<случайный токен для возвратов>
CORS_ORIGINS=   # если сайт тоже на Cloudflare Pages — указать https-домен Pages
```

SSL для `sonicvpn.ru` выдаст Caddy автоматически (после того как A-запись пропишется, 5–10 мин):
```
curl -I https://sonicvpn.ru/api/health   # {"ok":true}
```

## Шаг 4. Telegram-бот

1. **@BotFather** → `/newbot`
   - имя: `Sonic VPN`
   - username: `sonicvpn_bot` → получить **токен** → в `.env`
2. **@BotFather → /mybots → sonicvpn_bot → Bot Settings → API URL**:
   - `https://sonicvpn.ru` (для Login Widget — кнопки «Войти через Telegram» на сайте)
3. **Канал**: создать канал `Sonic VPN` (username `sonicvpn_channel`) — новости, статусы, акции. Ссылка уже в футере сайта и меню бота.
4. **Поддержка-нейросеть**: задать `AI_API_BASE/AI_API_KEY/AI_MODEL` (OpenRouter: 5 $ ≈ месячный бюджет поддержки; без ключа бот отвечает по встроенному FAQ)

## Шаг 4.1. Бесплатная нейросеть для поддержки (0 ₽, без карты)

Бот уже умеет «❓ Поддержка (нейросеть)» — нужен только ключ LLM. Все варианты **без банковской карты**:

| Провайдер | Регистрация | Лимит бесплатно | Скорость | Рекомендация |
|---|---|---|---|---|
| **Groq** ⭐ | console.groq.com (email/GitHub/Google) | Llama 3.3 70B: ~30 req/мин, **~1000 req/день** | 300–800 ток/с (ответ за 1–2 с) | **основной** |
| OpenRouter | openrouter.ai (email) | модели `:free`: 20 req/мин, 50/день (1000/день после разовой пополнения $10) | средняя | запасной |
| Google Gemini (AI Studio) | aistudio.google.com | Flash-модели: сотни req/день (лимиты видны после входа) | ~100 ток/с | запасной |
| Cloudflare Workers AI | dash.cloudflare.com | 10 000 «нейронов»/день | средняя | запасной |

**За 5 минут:**
1. **Groq**: войдите на console.groq.com → *API Keys* → *Create API Key* → скопируйте `gsk_...`
2. В `server/.env`:
   ```
   AI_API_BASE=https://api.groq.com/openai/v1
   AI_API_KEY=gsk_ваш_ключ
   AI_MODEL=llama-3.3-70b-versatile
   ```
3. Перезапустите: `pm2 restart sonicvpn`
4. Тест в боте: «❓ Поддержка» → «До когда действует моя подписка?»

**Как это работает под капотом** (`server/src/ai.js`):
- Бот шлёт модели: (1) **база знаний** о Sonic VPN (тарифы, СБП, устройства, рефералка, гарантия — правится в `KB`), (2) **живые данные клиента** (подписка, устройства, баланс — берутся из БД), (3) вопрос. Модель обязана отвечать только по этим данным.
- Лимит исчерпан (429) или API лежит → **авто-фолбэк на встроенный FAQ** — клиент не остаётся без ответа.
- Ключ не нужен вообще → бот и так работает на FAQ (текущий mock-режим).

**Экономика:** 1000 вопросов/день ≈ все клиенты сервиса на старте. Если вы вырастете — платный Groq Llama 70B стоит ~$0.6/млн токенов (≈ 1000 коротких ответов за 1 ₽).

## Шаг 5. ЮKassa (приём СБП от клиентов)

1. «Мой налог» → самозанятый (15 минут, налог 4% с оплат физлиц)
2. yookassa.ru → подключить (самозанятые подключаются онлайн, 1 день – 5 рабочих)
3. В кабинете: **Shop ID + Secret Key** → в `.env` (`PAYMENT_MODE=yookassa`)
4. **Webhook**: URL `https://sonicvpn.ru/api/webhooks/yookassa`, события `payment.succeeded`, `payment.canceled`
   (токен webhook = ваш Secret Key — проверка уже в коде)
5. Проверить в **песочнице** (`YOOKASSA_IS_SANDBOX=true`) → переключить на бой

Комиссия: **СБП 0,4%** (до 1500 ₽ с платежа), карты ~3,5%. Клиенту комиссия 0%.

## Шаг 6. Запуск и проверки

1. `curl https://sonicvpn.ru/api/health`
2. Зарегистрироваться на сайте → получить 7-дневный пробник → QR-профиль
3. Подключиться через **v2rayNG** (Android) / **Streisand** (iOS/Windows) → проверка YouTube
4. Оплатить тестовым платёжем 1 ₽ (если есть) / в песочнице ЮKassa
5. В боте: `/start` → покупка → QR → подключиться со второго устройства
6. Рефералка: второй аккаунт по вашему коду → его оплата → проверка 20% на балансе
7. Uptime Kuma (панель: http://IP:3001): статусы узлов → ссылка в футере сайта (v2)

## Эксплуатация (обычный уход)
- Автоплатёж VPS включён у провайдера
- Bots/панель под pm2: `pm2 startup && pm2 save`
- Лог 3x-ui при проблемах: панель → Logs
- Блокировка IP узла (бывает): новый IP у провайдера (бесплатно/дёшево) + сменить `XUI_HOST` в `.env` + бот пересаживает клиентов (v2: кнопкой)
- Бэкап: `tar czf sonicvpn-backup.tgz /opt/sonicvpn/data /opt/sonicvpn/server/.env` — раз в неделю на disk
