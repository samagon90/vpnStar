import { Router } from 'express';
import { REFERRAL_PERCENT, DEVICES_PER_PLAN, TRIAL_DAYS, cfg } from '../config.js';
import { q, daysLeft, db } from '../db.js';
import { money, fmtDate } from '../util.js';
import { provider } from '../vpn/provider.js';

const r = Router();

/** Статус подписки + готовый профиль (QR + конфиг) */
r.get('/subscription', async (req, res) => {
  const user = req.user;
  const sub = q.sub(user.id);
  const active = !!(sub && new Date(sub.expires_at) > new Date());
  let profile = null;
  if (active) {
    try {
      profile = await provider.profile(user);
      profile.qr = await provider.qrDataUrl(profile);
      delete profile.demo;
    } catch (e) {
      console.error('profile', e.message);
    }
  }
  res.json({
    active,
    kind: sub ? sub.kind : null,
    expires_at: sub ? sub.expires_at : null,
    expires_str: sub ? fmtDate(sub.expires_at) : null,
    days_left: sub ? daysLeft(sub.expires_at) : 0,
    trial_days: TRIAL_DAYS,
    devices: DEVICES_PER_PLAN,
    provider: provider.name(),
    profile,
  });
});

function earningsByInvitee(referrerId) {
  return db.prepare(`
    SELECT u.username, COALESCE(SUM(p.bonus_cents),0) s
    FROM payments p JOIN users u ON u.id = p.user_id
    WHERE u.referrer_id = ? AND p.status = 'paid' AND p.bonus_cents > 0
    GROUP BY u.id
  `).all(referrerId);
}

/**
 * Реферальная программа: 20% от ВСЕХ оплат приглашённых (включая продления).
 * Статистика: email (если указал), TG, дата подключения, активность, оплачено, его бонус.
 */
r.get('/referrals', (req, res) => {
  const me = req.user;
  const inv = q.invitedBy(me.id).map((u) => ({
    username: u.username,
    email: u.email || '—',
    tg: u.tg_username ? `@${u.tg_username}` : '—',
    connected_at: u.created_at,
    connected_str: fmtDate(u.created_at),
    last_active_str: fmtDate(u.last_active_at),
    total_paid: money(q.totalPaid(u.id)),
    earned: '0 ₽',
  }));
  const earned = earningsByInvitee(me.id);
  for (const e of earned) {
    const it = inv.find((x) => x.username === e.username);
    if (it) it.earned = money(e.s);
  }
  res.json({
    code: me.referral_code,
    percent: REFERRAL_PERCENT,
    invited_count: inv.length,
    total_earned: money(q.earnSum(me.id)),
    balance: money(q.userById(me.id).balance_cents),
    share_url: `${cfg.base_url}/auth.html?ref=${me.referral_code}`,
    invited: inv,
  });
});

/** email опционален: можно добавить/сменить в любой момент, без подтверждения */
r.post('/email', (req, res) => {
  const email = String((req.body || {}).email || '').trim();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' });
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email || null, req.user.id);
  res.json({ ok: true });
});

export default r;
