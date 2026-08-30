import { Bot, InlineKeyboard } from 'grammy';
import { cfg, PLANS, REFERRAL_PERCENT, TRIAL_DAYS, DEVICES_BASE, DEVICE_PACK_PRICE_CENTS } from './config.js';
import { q, createSession, nowISO, addDays } from './db.js';
import { randomRefCode, money, fmtDate } from './util.js';
import { provider } from './vpn/provider.js';
import { yk } from './yookassa.js';
import { findPlan, applyPayment } from './routes/pay.js';
import { aiSupport } from './ai.js';

/**
 * Telegram-бот Sonic VPN:
 *  - регистрация/синхронизация аккаунта (/start, /link)
 *  - статус подписки + профиль (QR)
 *  - покупка (СБП QR / карта)
 *  - реферальная программа: код + статистика (email, активность, дата подключения)
 *  - поддержка с нейронкой (AI-режим)
 */
export function startBot() {
  if (!cfg.tg_bot_token) {
    console.log('[bot] TG_BOT_TOKEN не задан — бот не запущен');
    return null;
  }
  const bot = new Bot(cfg.tg_bot_token);
  const supportMode = new Map(); // chatId -> true

  const menu = new InlineKeyboard()
    .text('📶 Моя подписка', 'sub')
    .text('📱 Мои устройства', 'devices')
    .text('💳 Купить VPN', 'buy')
    .text('🤝 Реферальная программа (20%)', 'ref')
    .text('❓ Поддержка (нейросеть)', 'support')
    .text('📣 Канал сервиса', 'channel');

  const devicesLimit = (user) => DEVICES_BASE + Number(user.devices_extra || 0);
  const firstActiveDevice = (user) => q.devicesOf(user.id).find((d) => d.enabled);

  /** Список устройств для бота: кнопки-QR + командами /block /unblock блокировка */
  function devicesMessage(user) {
    const list = q.devicesOf(user.id);
    const limit = devicesLimit(user);
    let txt = `📱 Ваши устройства: ${list.length}/${limit}\n` +
      (DEVICES_BASE === 2 ? `В подписке ${DEVICES_BASE} устройства. ` : '') +
      `+1 устройство — ${money(DEVICE_PACK_PRICE_CENTS)}.\n\n`;
    if (!list.length) txt += 'Пока нет устройств — добавьте на сайте (кабинет) или нажмите ниже.\n';
    list.forEach((d, i) => {
      txt += `${i + 1}. ${d.enabled ? '✅' : '🚫'} <b>${d.name}</b>\n`;
    });
    txt += `\nБлокировка устройства (самостоятельно): <code>/block №</code> и <code>/unblock №</code>\nУдаление устройства (свободит слот) — в кабинете на сайте.`;
    const kb = new InlineKeyboard();
    list.slice(0, 6).forEach((d, i) => kb.text(`📷 QR — ${i + 1}. ${d.name}`, `devqr_${d.id}`));
    kb.text(`🛒 Устройство +1 — ${money(DEVICE_PACK_PRICE_CENTS)}`, 'dev1');
    kb.text('⬅ Меню', 'menu');
    return { txt, kb };
  }

  async function ensureAccount(from, refCode) {
    let user = q.userByTg(from.id);
    let created = false;
    if (!user) {
      let referrerId = null;
      if (refCode) {
        const refUser = q.userByRefCode(String(refCode).toLowerCase());
        if (refUser) referrerId = refUser.id;
      }
      const uname = String(from.username || `user${from.id}`)
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '')
        .slice(0, 18) || `tg${from.id}`;
      const taken = q.userByName(uname);
      const finalName = taken && taken.tg_id !== from.id ? `${uname.slice(0, 14)}_${String(from.id).slice(-4)}` : uname;
      const id = q.insertUser({
        username: finalName,
        username_display: from.first_name || finalName,
        tg_id: from.id,
        tg_username: from.username || null,
        referral_code: randomRefCode(),
        referrer_id: referrerId,
        created_at: nowISO(),
      });
      user = q.userById(id);
      created = true;
      q.upsertSub(user.id, 'trial', null, addDays(nowISO(), TRIAL_DAYS));
      const firstDevice = q.insertDevice(user.id, 'Основное', 'pending', null);
      await provider.provisionDevice(user, q.device(firstDevice)).catch((e) => console.error('[bot] provision', e.message));
    } else {
      q.linkTg(user.id, from.id, from.username || user.tg_username);
    }
    q.touch(user.id);
    q.event(user.id, created ? 'register' : 'login');
    return { user, created };
  }

  bot.command('start', async (ctx) => {
    const ref = ctx.message?.text?.split(/\s+/)[1] || '';
    const { user, created } = await ensureAccount(ctx.from, ref);
    const hello = created
      ? `✦ Добро пожаловать в Sonic VPN, ${ctx.from.first_name}!\n\nВаш аккаунт создан и синхронизирован с Telegram.\n🎁 Вам начислено ${TRIAL_DAYS} дней бесплатного доступа — карта и подтверждение почты/номера не нужны.\n\n${created && user.referrer_id ? '🤝 Включён реферальный код: приглашавший получает 20% от ваших оплат.\n\n' : ''}`
      : `✦ С возвращением, ${ctx.from.first_name}! Аккаунт синхронизирован с Telegram.\n`;
    await ctx.reply(hello, { reply_markup: menu });
  });

  bot.command('cancel', async (ctx) => {
    supportMode.delete(ctx.chat.id);
    await ctx.reply('Выход из режима поддержки.', { reply_markup: menu });
  });

  bot.command('link', async (ctx) => {
    const uname = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase();
    if (!uname) return ctx.reply('Использование: /link ваш_логин (логин с сайта).');
    const siteUser = q.userByName(uname);
    if (!siteUser) return ctx.reply('Пользователь с таким логином не найден.');
    if (siteUser.tg_id && siteUser.tg_id !== ctx.from.id) return ctx.reply('Этот аккаунт уже связан с другим Telegram.');
    q.linkTg(siteUser.id, ctx.from.id, ctx.from.username || null);
    const { user } = await ensureAccount(ctx.from);
    if (user.id !== siteUser.id) return ctx.reply('Уже есть другой аккаунт с этим Telegram. Ссылка не применена.');
    await ctx.reply(`✅ Аккаунт ${siteUser.username} синхронизирован с вашим Telegram.`, { reply_markup: menu });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `Sonic VPN — быстрый VPN:
• 7 дней бесплатно, без карты
• СБП QR + карты РФ
• ${DEVICES_BASE} устройства в подписке (+1 за ${money(DEVICE_PACK_PRICE_CENTS)}, до 10)
• ${REFERRAL_PERCENT}% от оплат друзей — вам

Меню:`,
      { reply_markup: menu }
    );
  });

  // --- управление устройствами (пользователь сам блокирует свои) ---
  bot.command('devices', async (ctx) => {
    const { user } = await ensureAccount(ctx.from);
    const { txt, kb } = devicesMessage(user);
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
  });

  bot.command('block', async (ctx) => {
    const { user } = await ensureAccount(ctx.from);
    const n = Number(ctx.message?.text?.split(/\s+/)[1] || 0);
    const device = q.devicesOf(user.id)[n - 1];
    if (!device) return ctx.reply(`Нет устройства №${n}. Список: /devices`);
    if (!device.enabled) return ctx.reply(`${device.name} уже заблокировано.`);
    await provider.setDeviceEnabled(device, false);
    q.event(user.id, 'device_blocked');
    await ctx.reply(`🚫 Устройство «${device.name}» заблокировано — оно больше не подключится.\nВключить: /unblock ${n}`);
  });

  bot.command('unblock', async (ctx) => {
    const { user } = await ensureAccount(ctx.from);
    const n = Number(ctx.message?.text?.split(/\s+/)[1] || 0);
    const device = q.devicesOf(user.id)[n - 1];
    if (!device) return ctx.reply(`Нет устройства №${n}. Список: /devices`);
    if (device.enabled) return ctx.reply(`${device.name} уже активно.`);
    await provider.setDeviceEnabled(device, true);
    q.event(user.id, 'device_unblocked');
    await ctx.reply(`✅ Устройство «${device.name}» снова активно.`, { reply_markup: new InlineKeyboard().text('📱 Мои устройства', 'devices') });
  });

  // --- режим ИИ-поддержки: обычные сообщения идут в нейронку ---
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!supportMode.has(chatId)) {
      await ctx.reply('Нажмите «❓ Поддержка (нейросеть)» в меню — и просто пишите вопрос.', { reply_markup: menu });
      return;
    }
    const { user } = await ensureAccount(ctx.from); // живые данные клиента в контекст нейросети
    const answer = await aiSupport(ctx.message.text, user);
    await ctx.reply(answer, { link_preview_options: { is_disabled: true } });
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const { user } = await ensureAccount(ctx.from);

    if (data === 'sub') {
      const sub = q.sub(user.id);
      const active = !!(sub && new Date(sub.expires_at) > new Date());
      if (!active) {
        await ctx.editMessageText(
          '⛔ Подписка не активна.\n\nОформите тариф — доступ включится сразу после оплаты (СБП QR или карта).',
          { reply_markup: new InlineKeyboard().text('💳 Купить VPN', 'buy') }
        );
        return;
      }
      const devices = q.devicesOf(user.id);
      const first = firstActiveDevice(user);
      const info = first ? await provider.profile(user, first) : null;
      await ctx.editMessageText(
        `📶 Подписка активна\nИстекает: ${fmtDate(sub.expires_at)} (${Math.max(0, Math.ceil((new Date(sub.expires_at) - Date.now()) / 86400000))} дн.)\nУстройств: ${devices.length}/${devicesLimit(user)} (в подписке ${DEVICES_BASE}, +1 за ${money(DEVICE_PACK_PRICE_CENTS)})\nПровайдер: ${provider.name()}\n\n${info ? 'Конфиг основного устройства (импорт в v2rayNG / Streisand / Hiddify):' : '⚠️ Нет активных устройств — добавьте на сайте или в «📱 Мои устройства».'}`,
        { reply_markup: new InlineKeyboard().text('📱 Мои устройства', 'devices').text('💳 Продлить', 'buy') }
      );
      if (info) await ctx.reply(`\`\`\`${info.config_text}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    if (data === 'devices') {
      const { txt, kb } = devicesMessage(user);
      await ctx.editMessageText(txt, { parse_mode: 'HTML', reply_markup: kb });
    }

    if (data.startsWith('devqr_')) {
      const device = q.device(Number(data.split('_')[1]));
      if (!device || device.user_id !== user.id) return;
      const info = await provider.profile(user, device);
      const buf = await provider.qrBuffer(info.vless_link);
      await ctx.replyPhoto(buf, { caption: `${device.name} — отсканируйте в v2rayNG / Streisand / Hiddify` });
    }

    if (data === 'dev1') {
      // покупка +1 устройства (99 ₽)
      if (Number(user.devices_extra || 0) >= 8) return ctx.answerCallbackQuery('Уже максимум 10 устройств');
      const balance = q.userById(user.id).balance_cents;
      const balanceUsed = Math.min(balance, DEVICE_PACK_PRICE_CENTS);
      const rest = DEVICE_PACK_PRICE_CENTS - balanceUsed;
      const checkoutId = `co_${Math.random().toString(36).slice(2, 14)}`;
      q.insertPayment({ id: checkoutId, user_id: user.id, plan_id: 0, amount_cents: DEVICE_PACK_PRICE_CENTS, balance_used_cents: balanceUsed, status: 'pending', kind: 'devices', item: '+1 устройство', qty: 1 });
      if (balanceUsed > 0) q.setBalance(user.id, user.balance_cents - balanceUsed);
      if (rest === 0) {
        applyPayment(q.payment(checkoutId));
        await ctx.editMessageText(`✅ Устройство +1 оплачено с реферального баланса (${money(balanceUsed)})! Лимит теперь ${devicesLimit(q.userById(user.id))}.`, {
          reply_markup: new InlineKeyboard().text('📱 Мои устройства', 'devices').text('⬅ Меню', 'menu'),
        });
        return;
      }
      if (!yk.enabled()) {
        await ctx.editMessageText(
          `Тестовый режим: устройство +1 за ${money(rest)}. Нажмите кнопку ниже, чтобы подтвердить.`,
          { reply_markup: new InlineKeyboard().text(`✅ Я оплатил ${money(rest)}`, `mockdevpay_${checkoutId}`).text('⬅ Меню', 'menu') }
        );
        return;
      }
      const { ykId, confirmationUrl } = await yk.createPayment({
        amountCents: rest,
        description: 'Sonic VPN — устройство +1',
        returnUrl: `${cfg.base_url}/account.html`,
        idempotencyKey: checkoutId,
      });
      q.updatePaymentStatus(checkoutId, 'pending', { yk_payment_id: ykId });
      await ctx.editMessageText(
        `Оплатите ${money(rest)} по СБП (QR в приложении банка) или картой — и слот устройства появится.`,
        { reply_markup: new InlineKeyboard().url('💳 Оплатить (СБП / карта)', confirmationUrl).text('✅ Я оплатил — проверить', `chek_${checkoutId}`) }
      );
    }

    if (data.startsWith('mockdevpay_')) {
      const checkoutId = data.split('_').slice(1).join('_');
      const p = q.payment(checkoutId);
      if (!p || p.user_id !== user.id) return;
      if (p.status === 'pending') applyPayment(p);
      await ctx.editMessageText(`✅ Готово! Лимит устройств теперь ${devicesLimit(q.userById(user.id))}.`, {
        reply_markup: new InlineKeyboard().text('📱 Мои устройства', 'devices'),
      });
    }

    if (data === 'buy') {
      const kb = new InlineKeyboard();
      for (const p of PLANS) kb.text(`${p.name} — ${money(p.price_cents)}`, `plan_${p.id}`);
      kb.text('⬅ Меню', 'menu');
      const balance = q.userById(user.id).balance_cents;
      await ctx.editMessageText(
        `💳 Выбрать тариф${balance > 0 ? `\n(ваш реферальный баланс: ${money(balance)} — можно оплатить им)` : ''}`,
        { reply_markup: kb }
      );
    }

    if (data.startsWith('plan_')) {
      const plan = PLANS.find((p) => p.id === Number(data.split('_')[1]));
      if (!plan) return;
      const balance = q.userById(user.id).balance_cents;
      const balanceUsed = Math.min(balance, plan.price_cents);
      const rest = plan.price_cents - balanceUsed;
      const checkoutId = `co_${Math.random().toString(36).slice(2, 14)}`;
      q.insertPayment({ id: checkoutId, user_id: user.id, plan_id: plan.id, amount_cents: plan.price_cents, balance_used_cents: balanceUsed, status: 'pending' });
      if (balanceUsed > 0) q.setBalance(user.id, user.balance_cents - balanceUsed);

      if (rest === 0) {
        applyPayment(q.payment(checkoutId));
        const sub = q.sub(user.id);
        await ctx.editMessageText(
          `✅ Оплачено с реферального баланса (${money(balanceUsed)})!\nПодписка продлена до ${fmtDate(sub.expires_at)}.`,
          { reply_markup: new InlineKeyboard().text('📶 Моя подписка', 'sub') }
        );
        return;
      }
      if (!yk.enabled()) {
        await ctx.editMessageText(
          `Тестовый режим: тариф «${plan.name}» за ${money(rest)}. Нажмите кнопку ниже, чтобы подтвердить.`,
          { reply_markup: new InlineKeyboard().text(`✅ Я оплатил ${money(rest)}`, `mockpay_${checkoutId}`) }
        );
        return;
      }
      const { ykId, confirmationUrl } = await yk.createPayment({
        amountCents: rest,
        description: `Sonic VPN — ${plan.name}`,
        returnUrl: `${cfg.base_url}/checkout.html?plan=${plan.key}`,
        idempotencyKey: checkoutId,
      });
      q.updatePaymentStatus(checkoutId, 'pending', { yk_payment_id: ykId });
      await ctx.editMessageText(
        `Оплатите ${money(rest)} по СБП (QR в приложении банка) или картой.`,
        { reply_markup: new InlineKeyboard().url('💳 Оплатить (СБП / карта)', confirmationUrl).text('✅ Я оплатил — проверить', `chek_${checkoutId}`) }
      );
    }

    if (data.startsWith('mockpay_')) {
      const checkoutId = data.split('_').slice(1).join('_');
      const p = q.payment(checkoutId);
      if (!p || p.user_id !== user.id) return;
      if (p.status === 'pending') applyPayment(p);
      const sub = q.sub(user.id);
      await ctx.editMessageText(`✅ Готово! Подписка активна до ${fmtDate(sub.expires_at)}.`, {
        reply_markup: new InlineKeyboard().text('📶 Моя подписка', 'sub'),
      });
    }

    if (data.startsWith('chek_')) {
      const checkoutId = data.split('_').slice(1).join('_');
      const p = q.payment(checkoutId);
      if (!p || p.user_id !== user.id) return;
      if (p.yk_payment_id && yk.enabled()) {
        try {
          const remote = await yk.getPayment(p.yk_payment_id);
          if (remote.status === 'succeeded' && p.status === 'pending') applyPayment(p);
        } catch { /* сеть */ }
      }
      const row = q.payment(checkoutId);
      if (row.status === 'paid') {
        const sub = q.sub(user.id);
        await ctx.editMessageText(`✅ Оплата получена! Подписка активна до ${fmtDate(sub.expires_at)}.`, {
          reply_markup: new InlineKeyboard().text('📶 Моя подписка', 'sub'),
        });
      } else {
        await ctx.answerCallbackQuery('Оплата ещё не зачислена. Попробуйте через минуту.');
      }
    }

    if (data === 'ref') {
      const inv = q.invitedBy(user.id);
      const total = q.earnSum(user.id);
      let txt = `🤝 Ваш реферальный код: <b>${user.referral_code}</b>\n\nС каждой оплаты приглашённых (включая продления) вы получаете ${REFERRAL_PERCENT}% на баланс. Балансом можно оплатить свои подписки.\n\n👥 Приглашено: ${inv.length} | Заработано: ${money(total)} | Баланс: ${money(q.userById(user.id).balance_cents)}\n`;
      if (inv.length) {
        txt += '\nСтатистика:\n';
        for (const u of inv.slice(0, 15)) {
          txt += `• <b>${u.username}</b> — ${u.email || 'без email'}\n  подключён ${fmtDate(u.created_at)}, активен ${fmtDate(u.last_active_at)}\n`;
        }
      }
      txt += `\nПоделитесь ссылкой: ${cfg.base_url}/auth.html?ref=${user.referral_code}`;
      await ctx.editMessageText(txt, { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('⬅ Меню', 'menu') });
    }

    if (data === 'support') {
      supportMode.set(ctx.chat.id, true);
      await ctx.editMessageText(
        '❓ Режим поддержки включён. Спросите меня о тарифах, оплате, подключении или рефералке — отвечаю нейросеть. Выход: /cancel'
      );
    }

    if (data === 'channel') {
      await ctx.editMessageText('📣 Новости, статусы серверов и акции:', {
        reply_markup: new InlineKeyboard().url('Открыть канал', cfg.tg_channel_url).text('⬅ Меню', 'menu'),
      });
    }

    if (data === 'menu') {
      await ctx.editMessageText('✦ Sonic VPN — что делаем?', { reply_markup: menu });
    }
  });

  // fallback: неизвестная кнопка
  bot.catch((err) => console.error('[bot]', err));

  bot.start();
  console.log('[bot] Telegram-бот запущен');
  return bot;
}
