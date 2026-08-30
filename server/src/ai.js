import { cfg, PLANS, REFERRAL_PERCENT, TRIAL_DAYS, DEVICES_BASE, DEVICE_PACK_PRICE_CENTS } from './config.js';
import { q, daysLeft } from './db.js';
import { money, fmtDate } from './util.js';

const KB = `Ты — вежливый техподдержки VPN-сервиса Sonic VPN (отвечаешь на русском, кратко, по делу).
Информация о сервисе (отвечай ТОЛЬКО исходя из неё):
- Тарифы: ${PLANS.map((p) => `${p.name} — ${(p.price_cents / 100).toFixed(0)} ₽`).join(', ')}.
- Новым пользователям: ${TRIAL_DAYS} дней полного доступа бесплатно, без карты и без подтверждения почты/номера.
- Регистрация: логин + пароль (email и номер не нужны, не подтверждаются). Аккаунт можно синхронизировать с Telegram (кнопка «Войти через Telegram» или /start в боте).
- Оплата: СБП (QR-код в боте или на сайте, сканируете приложением своего банка) и карты РФ (МИР/Visa/MC). Комиссия банка 0%.
- Подписка: ${PLANS.length} тарифа, ${DEVICES_BASE} устройства включены в каждую подписку (и в пробник). Больше устройств можно докупить за деньги: +1 устройство = ${DEVICE_PACK_PRICE_CENTS / 100} ₽ (до 10 всего). Безлимит трафика, серверы в Германии, Финляндии, Турции.
- Устройства: каждое устройство — отдельный профиль (QR). Пользователь САМ управляет устройствами в кабинете или боте: посмотреть список (/devices), заблокировать своё устройство (/block №) и снова включить (/unblock №), удалить (свободит слот).
- Протоколы: VLESS + XTLS-Reality (основной), Hysteria2, VLESS+WS+TLS, AmneziaWG/WireGuard. Профиль (QR/файл) выдаётся в кабинете или в боте после оплаты.
- Подключение без нашего приложения: v2rayNG (Android), Streisand (iOS/Android/Windows), Hiddify, WireGuard, Amnezia.
- Реферальная программа: 20% от ВСЕХ оплат приглашённых (продления тоже) капают на баланс приглашавшего; балансом можно оплатить подписку. Статистика: email, активность, дата подключения каждого.
- No-logs: история посещений не хранится. Серверы за рубежом.
- Гарантия: возврат 3 дня, если сервис не работает по нашей вине.
- Сайт работает в России без VPN.
Вопросы, не по сервису, вежливо переводи на Sonic VPN. Если ответа нет в знаниях — так и скажи и предложи написать человеку в поддержку.
Если в контексте есть «Текущие данные клиента» — используй их, отвечай конкретно (например, «ваша подписка действует до …»). Не выдумывай данные, которых там нет.`;

/** Живые данные клиента для контекста (подписка, устройства, баланс) */
function userContextBlock(user) {
  if (!user) return '';
  const sub = q.sub(user.id);
  const devices = q.devicesOf(user.id);
  const extra = Number(user.devices_extra || 0);
  const lines = [
    '',
    'Текущие данные клиента (источник правды, использовать в ответах):',
    `- Логин: ${user.username}${user.email ? `, email: ${user.email}` : ''}`,
  ];
  if (sub) {
    const active = new Date(sub.expires_at) > new Date();
    lines.push(
      `- Подписка: ${active ? 'активна' : 'не активна'} (${sub.kind === 'trial' ? 'пробный период' : 'оплаченная'}), до ${fmtDate(sub.expires_at)}${active ? `, осталось ${daysLeft(sub.expires_at)} дн.` : ' (истекла)'}`
    );
  } else {
    lines.push('- Подписка: отсутствует');
  }
  lines.push(
    `- Устройства: ${devices.length}/${DEVICES_BASE + extra} (включено ${DEVICES_BASE}, докуплено ${extra}); список: ${devices.map((d, i) => `${i + 1}. ${d.name} — ${d.enabled ? 'активно' : 'заблокировано'}`).join('; ') || 'нет'}`
  );
  lines.push(`- Реферальный баланс: ${money(user.balance_cents)}; реферальный код: ${user.referral_code}`);
  return lines.join('\n');
}

const CANNED = {
  price: 'Тарифы Sonic VPN:\n• 1 месяц — 199 ₽\n• 3 месяца — 499 ₽ (популярный)\n• 12 месяцев — 1 499 ₽\n\n7 дней бесплатно для новых — просто зарегистрируйтесь, карта не нужна.',
  devices: `Устройства: в каждой подписке ${DEVICES_BASE} устройства (у каждого — свой QR). Хочется больше — докупите: +1 устройство = ${DEVICE_PACK_PRICE_CENTS / 100} ₽, максимум 10.\n\nУправлять устройствами можете сами:\n• в кабинете (раздел «Устройства») — добавить, заблокировать, удалить\n• в боте: /devices — список, /block № — заблокировать, /unblock № — включить`,
  pay: 'Оплата: СБП (QR в боте/на сайте — сканируете приложением любого банка) или карта РФ (МИР/Visa/MC). Зачисление мгновенное.',
  connect: 'Подключение: 1) откройте бота и получите профиль (QR) 2) скачайте v2rayNG (Android) / Streisand (iOS, Windows) / Hiddify 3) импортируйте QR или файл конфига. Готово — вы в сети.',
  free: 'Да! 7 дней полного доступа бесплатно: без карты, без подтверждения почты и номера. Просто зарегистрируйтесь на сайте или через /start в этом боте.',
  ref: 'Рефералка: дайте другу свой код (в кабинете «Реферальная программа»). С каждой его оплаты (включая продления) вам капают 20% на баланс. Балансом можно платить за свои подписки.',
  default: 'Не уверен в этом вопросе, но вот главное:\n• 7 дней бесплатно, без карты\n• СБП QR — оплата одним сканированием\n• 2 устройства (до 10 за доплату), no-logs, серверы DE/FI/TR\n\nДля уточнения напишите человеку в поддержку.',
};

function canned(answer) {
  const a = answer.toLowerCase();
  if (/(рефер|друз|приглаш|процент|бонус|кодом|код )/.test(a)) return CANNED.ref;
  if (/(устройств|девайс|лимит устройств|заблокир|блок )/.test(a)) return CANNED.devices;
  if (/(цен|тариф|стоим|сколько)/.test(a)) return CANNED.price;
  if (/(сбп|qr|оплат|карт|деньг|возврат|чек)/.test(a)) return CANNED.pay;
  if (/(бесплат|тест|пробн|7 дней|проба)/.test(a)) return CANNED.free;
  if (/(подключ|настр|конфиг|протокол|клиент|программ)/.test(a)) return CANNED.connect;
  return CANNED.default;
}

/**
 * Ответ ИИ-поддержки.
 * - Нет AI_API_KEY → заранее написанный FAQ (canned).
 * - Есть → запрос к OpenAI-совместимому API (Groq / OpenRouter / Gemini / любой),
 *   в контексте — база знаний о сервисе + живые данные клиента.
 * - 429 (лимит бесплатного тарифа) или ошибка → FAQ-фолбэк, клиент не остаётся без ответа.
 */
export async function aiSupport(message, user = null) {
  if (!cfg.ai_api_base || !cfg.ai_api_key) return canned(message);
  try {
    const res = await fetch(`${cfg.ai_api_base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.ai_api_key}` },
      body: JSON.stringify({
        model: cfg.ai_model,
        temperature: 0.3,
        max_tokens: 500,
        messages: [
          { role: 'system', content: KB + userContextBlock(user) },
          { role: 'user', content: message },
        ],
      }),
    });
    if (res.status === 429) {
      return canned(message) + '\n\n(Сейчас на нейросети перегруз — ответил по базовой базе знаний. Попробуйте ещё раз через минуту.)';
    }
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content?.trim();
    return text || canned(message);
  } catch (e) {
    console.error('[ai]', e.message);
    return canned(message) + '\n\n(Нейросеть временно недоступна — ответил по базовой базе знаний)';
  }
}
