import { cfg, PLANS, REFERRAL_PERCENT, TRIAL_DAYS } from './config.js';

const KB = `Ты — вежливый техподдержки VPN-сервиса VpnStar (отвечаешь на русском, кратко, по делу).
Информация о сервисе (отвечай ТОЛЬКО исходя из неё):
- Тарифы: ${PLANS.map((p) => `${p.name} — ${(p.price_cents / 100).toFixed(0)} ₽`).join(', ')}.
- Новым пользователям: ${TRIAL_DAYS} дней полного доступа бесплатно, без карты и без подтверждения почты/номера.
- Регистрация: логин + пароль (email и номер не нужны, не подтверждаются). Аккаунт можно синхронизировать с Telegram (кнопка «Войти через Telegram» или /start в боте).
- Оплата: СБП (QR-код в боте или на сайте, сканируете приложением своего банка) и карты РФ (МИР/Visa/MC). Комиссия банка 0%.
- Подписка: ${PLANS.length} тарифа, 5 устройств на подписку, безлимит трафика, серверы в Германии, Финляндии, Турции.
- Протоколы: VLESS + XTLS-Reality (основной), Hysteria2, VLESS+WS+TLS, AmneziaWG/WireGuard. Профиль (QR/файл) выдаётся в кабинете или в боте после оплаты.
- Подключение без нашего приложения: v2rayNG (Android), Streisand (iOS/Android/Windows), Hiddify, WireGuard, Amnezia.
- Реферальная программа: 20% от ВСЕХ оплат приглашённых (продления тоже) капают на баланс приглашавшего; балансом можно оплатить подписку. Статистика: email, активность, дата подключения каждого.
- No-logs: история посещений не хранится. Серверы за рубежом.
- Гарантия: возврат 3 дня, если сервис не работает по нашей вине.
- Сайт работает в России без VPN.
Вопросы, не по сервису, вежливо переводи на VpnStar. Если ответа нет в знаниях — так и скажи и предложи написать человеку в поддержку.`;

const CANNED = {
  price: 'Тарифы VpnStar:\n• 1 месяц — 199 ₽\n• 3 месяца — 499 ₽ (популярный)\n• 12 месяцев — 1 499 ₽\n\n7 дней бесплатно для новых — просто зарегистрируйтесь, карта не нужна.',
  pay: 'Оплата: СБП (QR в боте/на сайте — сканируете приложением любого банка) или карта РФ (МИР/Visa/MC). Зачисление мгновенное.',
  connect: 'Подключение: 1) откройте бота и получите профиль (QR) 2) скачайте v2rayNG (Android) / Streisand (iOS, Windows) / Hiddify 3) импортируйте QR или файл конфига. Готово — вы в сети.',
  free: 'Да! 7 дней полного доступа бесплатно: без карты, без подтверждения почты и номера. Просто зарегистрируйтесь на сайте или через /start в этом боте.',
  ref: 'Рефералка: дайте другу свой код (в кабинете «Реферальная программа»). С каждой его оплаты (включая продления) вам капают 20% на баланс. Балансом можно платить за свои подписки.',
  default: 'Не уверен в этом вопросе, но вот главное:\n• 7 дней бесплатно, без карты\n• СБП QR — оплата одним сканированием\n• 5 устройств, no-logs, серверы DE/FI/TR\n\nДля уточнения напишите человеку в поддержку.',
};

function canned(answer) {
  const a = answer.toLowerCase();
  if (/(рефер|друз|приглаш|процент|бонус|кодом|код )/.test(a)) return CANNED.ref;
  if (/(цен|тариф|стоим|сколько)/.test(a)) return CANNED.price;
  if (/(сбп|qr|оплат|карт|деньг|возврат|чек)/.test(a)) return CANNED.pay;
  if (/(бесплат|тест|пробн|7 дней|проба)/.test(a)) return CANNED.free;
  if (/(подключ|настр|конфиг|включ|протокол|клиент|программ)/.test(a)) return CANNED.connect;
  return CANNED.default;
}

/** Ответ ИИ-поддержки. Если AI_API_KEY не задан — отвечает по заранее написанному FAQ. */
export async function aiSupport(message) {
  if (!cfg.ai_api_base || !cfg.ai_api_key) return canned(message);
  try {
    const res = await fetch(`${cfg.ai_api_base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ai_api_key}` },
      body: JSON.stringify({
        model: cfg.ai_model,
        temperature: 0.3,
        max_tokens: 400,
        messages: [
          { role: 'system', content: KB },
          { role: 'user', content: message },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || canned(message);
  } catch (e) {
    console.error('[ai]', e.message);
    return canned(message) + '\n\n(ИИ временно недоступен — ответил по FAQ)';
  }
}
