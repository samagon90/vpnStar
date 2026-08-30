import { Bot, InlineKeyboard } from 'grammy';
import { cfg, PLANS, REFERRAL_PERCENT, TRIAL_DAYS } from './config.js';
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
    .text('💳 Купить VPN', 'buy')
    .text('🤝 Реферальная программа (20%)', 'ref')
    .text('❓ Поддержка (нейросеть)', 'support')
    .text('📣 Канал сервиса', 'channel');

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
      await provider.provision(user).catch((e) => console.error('[bot] provision', e.message));
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
• 5 устройств, no-logs
• ${REFERRAL_PERCENT}% от оплат друзей — вам

Меню:`,
      { reply_markup: menu }
    );
  });

  // --- режим ИИ-поддержки: обычные сообщения идут в нейронку ---
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!supportMode.has(chatId)) {
      await ctx.reply('Нажмите «❓ Поддержка (нейросеть)» в меню — и просто пишите вопрос.', { reply_markup: menu });
      return;
    }
    const answer = await aiSupport(ctx.message.text);
    await ctx.reply(answer);
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
      const info = await provider.profile(user);
      await ctx.editMessageText(
        `📶 Подписка активна\nИстекает: ${fmtDate(sub.expires_at)} (${Math.max(0, Math.ceil((new Date(sub.expires_at) - Date.now()) / 86400000))} дн.)\nУстройств: 5\nПровайдер: ${provider.name()}\n\nКонфиг (импорт в v2rayNG / Streisand / Hiddify):`,
        { reply_markup: new InlineKeyboard().text('📄 QR-код', 'sub_qr').text('💳 Продлить', 'buy') }
      );
      await ctx.reply(`\`\`\`${info.config_text}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    if (data === 'sub_qr') {
      const info = await provider.profile(user);
      const buf = await provider.qrBuffer(info.vless_link);
      await ctx.replyPhoto(buf, { caption: 'Отсканируйте — и подключитесь в v2rayNG / Streisand / Hiddify' });
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
