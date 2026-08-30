# Деплой Sonic VPN — пошагово (оплата из РФ)

Всё, что нужно для боевого запуска. Оплата хостинга — **картой РФ (МИР) или СБП**.

---

## Шаг 0. Хостинг (оплата из России)

Зарубежные провайдеры (Hetzner, DO, Vultr) с российской картой не платятся — используем российских с EU-ДЦ:

| Провайдер | Локация | Цена | Оплата |
|---|---|---|---|
| **AdminVPS.ru** (рекомендую) | Германия / Нидерланды / Финляндия | от 219–299 ₽/мес | МИР, **СБП**, автоплатёж по МИР |
| **Timeweb Cloud** | Франкфурт / Амстердам | от 150–300 ₽/мес | карты РФ, **СБП**, почасовой биллинг |
| FirstVDS | Европа | от 199 ₽/мес | МИР, СБП |

**Покупаем 2 узла** (можно у разных провайдеров — страховка от сбоев):
- Узел 1: **Германия** (Франкфурт) — основная локация
- Узел 2: **Нидерланды или Финляндия** — резерв + вторая страна

Конфиг: **2 vCPU / 4 GB RAM / 40–60 GB NVMe**, Ubuntu **24.04** (или 22.04). Стоимость ~300–600 ₽/мес за узел.
Включите **автоплатёж по МИР** в личном кабинете провайдера, чтобы сервер не отключился.

> 💡 Если есть **зарубежная** банковская карта — можно стартовать с Oracle Cloud Always Free
> (4 ядра ARM / 24 GB / 10 ТБ — бесплатно навсегда, ДЦ Frankfurt/Amsterdam). Но верификация
> требует не-российскую карту. В этом репо провайдер абстрагирован: в `.env` просто указываете
> API 3x-ui — какой VPS не важен.

## Шаг 1. Подготовка каждого VPS

```bash
ssh root@IP_УЗЛА
# копируем скрипт с GitHub (ветка arena/01a05219-vpnstar) или через scp:
# scp deploy/vps-setup.sh root@IP_УЗЛА:/root/
bash vps-setup.sh
```

Скрипт ставит: 3x-ui (панель VPN), Caddy (авто-SSL), UFW (22 + порты), swap, мониторинг логинов.
В конце печатает URL панели 3x-ui.

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
   A-запись: `node2.sonicvpn.ru` → IP узла 2 (прокси **ВЫКЛ** — только DNS, чтобы Cloudflare не трогал UDP-трафик)
4. Cloudflare бесплатно даёт: CDN (быстро в РФ), скрытие origin-IP от РКН, базовую DDoS-защиту

Сайт за Cloudflare **открывается в России без VPN** — это и есть фича №1.

## Шаг 3. Панель и бот (этот репозиторий)

На узле 1 (или на узле 2 — как удобнее):

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
XUI_BASE=http://127.0.0.1:<порт 3x-ui>   # если 3x-ui на этом же VPS
XUI_USER=<логин панели>
XUI_PASSWORD=<пароль панели>
XUI_HOST=sonicvpn.ru
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
