# ✦ vpnStar

Собственный VPN-сервис: хостинг за рубежом, оплата по **СБП**, себестоимость инфраструктуры **≈ 0 ₽/мес**.

## Документация
- [`docs/ANALYSIS.md`](docs/ANALYSIS.md) — разбор эталона (24hype.ru / HypeVPN) + конкурентов + «best of» список фич
- [`docs/PLAN.md`](docs/PLAN.md) — концепция VpnStar: фичи, тарифы, архитектура «за 0 ₽» (Oracle Cloud Always Free + Cloudflare + ЮKassa СБП), roadmap MVP, риски

## Прототип
- [`index.html`](index.html) — лендинг (открыть в браузере; самодостаточный, без зависимостей)

## Ключевые решения
| Вопрос | Решение |
|---|---|
| Где хостинг | Oracle Cloud Always Free (Frankfurt, Amsterdam) — 0 ₽ навсегда, 4 ядра ARM / 24 GB / 10 ТБ трафика |
| Протоколы | VLESS + Reality (основной), Hysteria2, VLESS+WS+TLS, AmneziaWG — через open-source панель 3x-ui |
| Оплата | ЮKassa: **СБП QR (0,4%)** + карты РФ (3,5%); самозанятый, чеки автоматически |
| Дистрибуция | Telegram-бот (покупка, профили, статус) + конфиги для публичных клиентов (v2rayNG, Streisand, Hiddify) |
| Сайт | Cloudflare Pages + домен .ru (~300 ₽/год) + второй домен от блокировок |
| Хук | 7 дней бесплатно без карты + гарантия возврата 3 дня |
