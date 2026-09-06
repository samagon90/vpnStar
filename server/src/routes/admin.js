import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { cfg } from '../config.js';
import { db, q, nowISO, addDays, addMonths, daysLeft } from '../db.js';
import { hashPassword, randomRefCode, money } from '../util.js';
import { provider } from '../vpn/provider.js';

const r = Router();

// Доступ только по ADMIN_TOKEN (заголовок x-admin-token или Authorization: Bearer)
function requireAdmin(req, res, next) {
  const token = cfg.admin_token;
  if (!token) return res.status(503).json({ error: 'ADMIN_TOKEN не задан в .env' });
  const provided =
    (typeof req.headers['x-admin-token'] === 'string' && req.headers['x-admin-token']) ||
    (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7)) ||
    '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
  next();
}
r.use(requireAdmin);

const count = (sql, ...args) => Number(db.prepare(sql).get(...args).c || 0);

// --- Сводка ---
r.get('/stats', (req, res) => {
  const now = nowISO();
  const in3d = addDays(now, 3);
  res.json({
    total_users: count('SELECT COUNT(*) c FROM users'),
    active: count('SELECT COUNT(*) c FROM subscriptions WHERE expires_at > ?', now),
    trial: count("SELECT COUNT(*) c FROM subscriptions WHERE kind = 'trial' AND expires_at > ?", now),
    expiring_soon: count("SELECT COUNT(*) c FROM subscriptions WHERE kind != 'trial' AND expires_at > ? AND expires_at <= ?", now, in3d),
    devices_active: count('SELECT COUNT(*) c FROM devices WHERE enabled = 1'),
    total_paid_cents: Number(db.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE status='paid'").get().s || 0),
    new_today: count("SELECT COUNT(*) c FROM users WHERE created_at >= date('now','start of day')"),
  });
});

// --- База клиентов (поиск по логину/email; 100 последних) ---
r.get('/users', (req, res) => {
  const s = String(req.query.search || '').trim();
  const rows = s
    ? db.prepare('SELECT * FROM users WHERE username LIKE ? OR COALESCE(email,\'\') LIKE ? ORDER BY created_at DESC LIMIT 50').all(`%${s}%`, `%${s}%`)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 100').all();
  const users = rows.map((u) => {
    const sub = q.sub(u.id);
    const devices = q.devicesOf(u.id);
    return {
      id: u.id,
      username: u.username,
      email: u.email || '',
      created_at: u.created_at,
      last_active_at: u.last_active_at || '',
      tg: !!u.tg_id,
      sub: sub ? { kind: sub.kind, expires_at: sub.expires_at } : null,
      days_left: sub ? daysLeft(sub.expires_at) : 0,
      balance_cents: Number(u.balance_cents || 0),
      paid_cents: q.totalPaid(u.id),
      devices_active: devices.filter((d) => d.enabled).length,
      devices_total: devices.length,
      referrals: q.invitedBy(u.id).length,
    };
  });
  res.json({ users });
});

// --- Сгенерировать бесплатный ключ: юзер + gift-подписка (1/3/6 мес) + устройство + QR ---
r.post('/users', async (req, res) => {
  const u = String((req.body || {}).username || '').trim().toLowerCase();
  const pw = String((req.body || {}).password || '');
  const months = [1, 3, 6].includes(Number(req.body?.months)) ? Number(req.body.months) : 3;
  if (!/^[a-z0-9_]{3,20}$/.test(u)) return res.status(400).json({ error: 'Логин: 3–20 символов, строчные a-z, цифры, _' });
  if (q.userByName(u)) return res.status(409).json({ error: 'Такой логин уже есть' });
  if (pw.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
  try {
    const now = nowISO();
    const id = q.insertUser({
      username: u, username_display: u, password_hash: hashPassword(pw),
      email: null, tg_id: null, tg_username: null,
      referral_code: randomRefCode(), referrer_id: null, created_at: now,
    });
    const expiresAt = addMonths(now, months);
    q.upsertSub(id, 'gift', null, expiresAt);
    const deviceId = q.insertDevice(id, 'Основное', 'pending', null);
    const user = q.userById(id);
    await provider.provisionDevice(user, q.device(deviceId));
    const device = q.device(deviceId);
    const prof = await provider.profile(user, device);
    const qr = await provider.qrDataUrl(prof);
    res.json({
      username: u, password: pw, months, expires_at: expiresAt,
      referral_code: user.referral_code,
      device: {
        id: device.id, name: device.name,
        vless_link: prof.vless_link, config_text: prof.config_text,
        qr, demo: !!prof.demo,
      },
    });
  } catch (e) {
    console.error('[admin] create user:', e);
    res.status(500).json({ error: 'Не удалось создать ключ' });
  }
});

// --- Устройства юзера (все, с QR) ---
r.get('/users/:id/devices', async (req, res) => {
  const user = q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  const devices = await Promise.all(
    q.devicesOf(user.id).map(async (d) => {
      const prof = await provider.profile(user, d);
      const qr = await provider.qrDataUrl(prof);
      return {
        id: d.id, name: d.name, enabled: !!d.enabled,
        vless_link: prof.vless_link, config_text: prof.config_text, qr,
      };
    })
  );
  res.json({ username: user.username, devices });
});

// --- Продлить подписку на N дней (от max(сейчас, конец текущей)) ---
r.post('/users/:id/extend', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.body?.days) || 30));
  const user = q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  const sub = q.sub(user.id);
  const base = sub && new Date(sub.expires_at) > new Date() ? sub.expires_at : nowISO();
  const expiresAt = addDays(base, days);
  const kind = sub && sub.kind !== 'trial' ? sub.kind : 'gift';
  q.upsertSub(user.id, kind, sub?.plan_id ?? null, expiresAt);
  res.json({ ok: true, expires_at: expiresAt });
});

// --- Сменить пароль ---
r.post('/users/:id/reset-password', (req, res) => {
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
  const user = q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pw), user.id);
  res.json({ ok: true });
});

// --- Удалить юзера (устройства 3x-ui, сессии, подписки, оплаты, события; referrer_id освобождаем) ---
r.delete('/users/:id', async (req, res) => {
  const user = q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  try {
    for (const d of q.devicesOf(user.id)) {
      try { await provider.deleteDevice(d); } catch (e) { console.error('[admin] deleteDevice:', e.message); }
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM payments WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM events WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET referrer_id = NULL WHERE referrer_id = ?').run(user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[admin] delete user:', e);
    res.status(500).json({ error: 'Не удалось удалить' });
  }
});

export default r;
