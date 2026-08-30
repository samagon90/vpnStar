import { Router } from 'express';
import { cfg, PLANS, REFERRAL_PERCENT } from '../config.js';
import { q, nowISO, addMonths } from '../db.js';
import { newId, money } from '../util.js';
import { yk } from '../yookassa.js';
import { provider } from '../vpn/provider.js';

const r = Router();

export const findPlan = (id) => PLANS.find((p) => p.id === Number(id));

/** Начислить подписку + бонус рефереру (20% от оплаты) */
export function applyPayment(payment) {
  const plan = findPlan(payment.plan_id);
  if (!plan) throw new Error('unknown plan');
  const sub = q.sub(payment.user_id);
  const base = sub && new Date(sub.expires_at) > new Date() ? sub.expires_at : nowISO();
  q.upsertSub(payment.user_id, 'plan', plan.id, addMonths(base, plan.months));
  q.event(payment.user_id, 'payment');

  let bonus = 0;
  const user = q.userById(payment.user_id);
  if (user && user.referrer_id) {
    bonus = Math.round((payment.amount_cents + payment.balance_used_cents) * REFERRAL_PERCENT) / 100;
    q.addBalance(user.referrer_id, bonus);
  }
  q.updatePaymentStatus(payment.id, 'paid', { paid_at: nowISO(), bonus_cents: bonus });
  return bonus;
}

r.get('/plans', (req, res) => res.json({ plans: PLANS, referral_percent: REFERRAL_PERCENT }));

/**
 * Создать оплату. body: { plan_id, use_balance (bool) }
 * use_balance: списать со «реферального баланса» (начисляется 20% от оплат приглашённых)
 */
r.post('/', async (req, res) => {
  const user = req.user;
  const plan = findPlan((req.body || {}).plan_id);
  if (!plan) return res.status(400).json({ error: 'Неизвестный тариф' });

  const useBalance = !!req.body.use_balance;
  const balance = q.userById(user.id).balance_cents;
  const balanceUsed = useBalance ? Math.min(balance, plan.price_cents) : 0;
  const rest = plan.price_cents - balanceUsed;
  if (balanceUsed > 0) q.setBalance(user.id, user.balance_cents - balanceUsed);

  const checkoutId = newId('co_');
  q.insertPayment({ id: checkoutId, user_id: user.id, plan_id: plan.id, amount_cents: plan.price_cents, balance_used_cents: balanceUsed, status: 'pending' });

  // Полный оплат от баланса
  if (rest === 0) {
    applyPayment(q.payment(checkoutId));
    return res.json({ ok: true, paid: true, checkout_id: checkoutId, balance_used: balanceUsed });
  }

  // mock-режим: «Я оплатил»
  if (!yk.enabled()) {
    return res.json({ ok: true, paid: false, checkout_id: checkoutId, mode: 'mock', price_cents: rest, balance_used: balanceUsed });
  }

  try {
    const { ykId, confirmationUrl } = await yk.createPayment({
      amountCents: rest,
      description: `VpnStar — ${plan.name}`,
      returnUrl: `${cfg.base_url}/checkout.html?plan=${plan.key}`,
      idempotencyKey: checkoutId,
    });
    q.updatePaymentStatus(checkoutId, 'pending', { yk_payment_id: ykId });
    const qr = await provider.qrDataUrl(confirmationUrl);
    res.json({
      ok: true,
      paid: false,
      checkout_id: checkoutId,
      mode: 'yookassa',
      confirmation_url: confirmationUrl,
      qr,
      price_cents: rest,
      balance_used: balanceUsed,
    });
  } catch (e) {
    console.error('yookassa create', e.message);
    res.status(502).json({ error: `Платёжный сервис недоступен: ${e.message}` });
  }
});

/** mock: подтвердить оплату (тестовый режим) */
r.post('/:id/confirm-mock', async (req, res) => {
  const p = q.payment(req.params.id);
  if (!p || p.user_id !== req.user.id) return res.status(404).json({ error: 'Платёж не найден' });
  if (p.status !== 'pending') return res.json({ ok: true, paid: true });
  if (yk.enabled()) return res.status(400).json({ error: 'Не тестовый режим' });
  applyPayment(p);
  const sub = q.sub(p.user_id);
  res.json({ ok: true, paid: true, expires_at: sub.expires_at });
});

r.get('/history', (req, res) => {
  const rows = q.paymentsOf(req.user.id);
  res.json({
    history: rows.map((p) => ({
      id: p.id,
      plan: findPlan(p.plan_id)?.name || '?',
      amount: money(p.amount_cents),
      balance_used: money(p.balance_used_cents),
      status: p.status,
      bonus: p.bonus_cents ? `+${money(p.bonus_cents)} рефереру` : null,
      created_at: p.created_at,
      paid_at: p.paid_at,
    })),
  });
});

/** Статус оплаты (поллинг чекаута; в боевом режиме сверяется с ЮKassa) */
r.get('/:id', async (req, res) => {
  const p = q.payment(req.params.id);
  if (!p || (p.user_id !== req.user.id)) return res.status(404).json({ error: 'Платёж не найден' });
  if (p.status === 'pending' && p.yk_payment_id && yk.enabled()) {
    try {
      const remote = await yk.getPayment(p.yk_payment_id);
      if (remote.status === 'succeeded') applyPayment(p);
      else if (['canceled', 'expired', 'failed'].includes(remote.status)) {
        // вернём средства с баланса пользователю
        if (p.balance_used_cents > 0) q.addBalance(p.user_id, p.balance_used_cents);
        q.updatePaymentStatus(p.id, 'failed');
      }
    } catch (e) {
      console.error('yookassa get', e.message);
    }
  }
  const row = q.payment(p.id);
  const sub = q.sub(p.user_id);
  res.json({
    status: row.status,
    price_cents: row.amount_cents,
    balance_used: row.balance_used_cents,
    bonus_cents: row.bonus_cents,
    referral_percent: REFERRAL_PERCENT,
    subscription: sub ? { active: new Date(sub.expires_at) > new Date(), kind: sub.kind, expires_at: sub.expires_at } : null,
  });
});

/** Возврат (гарантия 3 дня) — только админ */
r.post('/:id/refund', async (req, res) => {
  const admin = req.headers['x-admin-token'] === cfg.admin_token;
  if (!admin) return res.status(403).json({ error: 'forbidden' });
  const p = q.payment(req.params.id);
  if (!p || p.status !== 'paid') return res.status(400).json({ error: 'Нельзя вернуть этот платёж' });
  if (p.yk_payment_id && yk.enabled()) {
    await yk.refund(p.yk_payment_id, p.amount_cents);
  }
  q.updatePaymentStatus(p.id, 'refunded');
  // откат подписки: если до конца оплаченного периода >30 дней — отнимаем оплаченные месяцы
  const plan = findPlan(p.plan_id);
  const sub = q.sub(p.user_id);
  if (sub && sub.kind === 'plan' && plan) {
    q.upsertSub(p.user_id, 'trial', null, addMonths(nowISO(), 0));
  }
  res.json({ ok: true });
});

export default r;
