import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { cfg } from '../config.js';
import { db, q, qAdmin, nowISO, addDays, addMonths, daysLeft, createAdminSession, getAdminSession, destroyAdminSession } from '../db.js';
import { hashPassword, verifyPassword, randomRefCode, money, newId } from '../util.js';
import { applyPayment, findPlan } from './pay.js';
import { provider } from '../vpn/provider.js';
import { xui } from '../vpn/xui.js';

const r = Router();

const ADMIN_COOKIE = 'vs_admin';
const adminCookieHeader = (token) =>
  `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`;
const clearAdminCookieHeader = () => `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

const ADMIN_RE = /^[a-zA-Z0-9_]{3,20}$/;
const validAdminCreds = (username, password) =>
  ADMIN_RE.test(String(username || '')) && String(password || '').length >= 8
    ? null
    : 'Логин: 3–20 символов (латиница, цифры, _). Пароль: минимум 8 символов.';

// --- ПУБЛИЧНОЕ: состояние, первичная настройка, вход/выход (ДО requireAdmin!) ---
r.get('/auth-state', (req, res) => {
  res.json({ setup_needed: qAdmin.count() === 0, logged_in: !!getAdminSession(req) });
});

// Создание ПЕРВОГО админа — только пока таблица пуста (одноразово).
r.post('/setup', (req, res) => {
  if (qAdmin.count() > 0) return res.status(403).json({ error: 'Администратор уже создан — войдите' });
  const { username, password } = req.body || {};
  const err = validAdminCreds(username, password);
  if (err) return res.status(400).json({ error: err });
  const id = qAdmin.insert(String(username), hashPassword(String(password)));
  const token = createAdminSession(id);
  res.setHeader('Set-Cookie', adminCookieHeader(token));
  res.json({ ok: true, username: String(username) });
});

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const a = qAdmin.byName(String(username || ''));
  if (!a || !verifyPassword(String(password || ''), a.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  const token = createAdminSession(a.id);
  res.setHeader('Set-Cookie', adminCookieHeader(token));
  res.json({ ok: true, username: a.username });
});

r.post('/logout', (req, res) => {
  destroyAdminSession(req);
  res.setHeader('Set-Cookie', clearAdminCookieHeader());
  res.json({ ok: true });
});

// Доступ: сессия админа ИЛИ ADMIN_TOKEN (заголовок x-admin-token / Bearer).
// Токен остаётся мастер-ключом (скрипты, curl), вход — для браузера.
function requireAdmin(req, res, next) {
  const a = getAdminSession(req);
  if (a) {
    req.admin = { id: a.id, username: a.username };
    return next();
  }
  const token = cfg.admin_token;
  if (!token) return res.status(401).json({ error: 'Войдите как администратор' });
  const provided =
    (typeof req.headers['x-admin-token'] === 'string' && req.headers['x-admin-token']) ||
    (req.headers.authorization?.startsWith('Bearer ') && req.headers.authorization.slice(7)) ||
    '';
  const x = Buffer.from(String(provided));
  const y = Buffer.from(token);
  if (x.length !== y.length || !timingSafeEqual(x, y)) {
    return res.status(401).json({ error: 'Неверный токен' });
  }
  req.admin = null; // вход по токену, без имени
  next();
}
r.use(requireAdmin);

r.get('/me', (req, res) => {
  res.json({ ok: true, admin: req.admin, token_mode: !req.admin });
});

// Управление админами (только для вошедших; создание — только через сессию, не по токену,
// чтобы утечка токена не давала плодить админов).
r.get('/admins', (req, res) => {
  res.json({ admins: qAdmin.all(), me: req.admin });
});
r.post('/admins', (req, res) => {
  if (!req.admin) return res.status(403).json({ error: 'Только для вошедшего администратора' });
  const { username, password } = req.body || {};
  const err = validAdminCreds(username, password);
  if (err) return res.status(400).json({ error: err });
  if (qAdmin.byName(String(username))) return res.status(409).json({ error: 'Такой логин уже есть' });
  const id = qAdmin.insert(String(username), hashPassword(String(password)));
  res.json({ ok: true, id, username: String(username) });
});
r.delete('/admins/:id', (req, res) => {
  if (!req.admin) return res.status(403).json({ error: 'Только для вошедшего администратора' });
  const id = Number(req.params.id);
  if (id === req.admin.id) return res.status(400).json({ error: 'Нельзя удалить себя' });
  if (qAdmin.count() <= 1) return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
  if (!qAdmin.byId(id)) return res.status(404).json({ error: 'Не найден' });
  db.prepare('DELETE FROM admin_sessions WHERE admin_id = ?').run(id);
  qAdmin.del(id);
  res.json({ ok: true });
});

const count = (sql, ...args) => Number(db.prepare(sql).get(...args).c || 0);

// --- Блокировать/разблокировать устройство панели (по 3x-ui email/ref) ---
r.post('/client/toggle', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email пустой' });
  const enable = !!req.body?.enable;
  try {
    await xui.setClientEnabled(email, enable);
    const row = db.prepare('SELECT id FROM devices WHERE ref_id = ?').get(email);
    if (row) db.prepare('UPDATE devices SET enabled = ? WHERE id = ?').run(enable ? 1 : 0, row.id);
    res.json({ ok: true, email, enable });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось обновить клиента панели: ' + e.message });
  }
});

// --- Удалить устройство панели (по email/ref) + освободить слот в БД ---
r.delete('/client/:email', async (req, res) => {
  const email = String(req.params.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email пустой' });
  try {
    await xui.delClient(email);
    const row = db.prepare('SELECT * FROM devices WHERE ref_id = ?').get(email);
    if (row) q.deleteDevice(row.id);
    res.json({ ok: true, email });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось удалить клиента панели: ' + e.message });
  }
});

// --- Активные подключения клиентов (из панели 3x-ui, онлайн-статистика) ---
r.get('/online', async (req, res) => {
  if (!cfg.xui_base) return res.json({ online: [] });
  try {
    const stats = await xui.clientStats();
    // last_ip != '' → у 3x-ui v3 не всегда заполняется; считаем «активными» тех,
    // у кого есть трафик за всё время и enable=1. Реально-онлайн показывает панель,
    // мы отдаём отсортированными по трафику (порт 443 = VLESS+Reality).
    const online = stats
      .filter((s) => s.enable)
      .sort((a, b) => b.total - a.total)
      .map((s) => s);
    res.json({ online });
  } catch (e) {
    res.status(502).json({ error: 'Не удалось получить данные панели: ' + e.message });
  }
});

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
  // months: 1 | 3 | 6 | 999 (999 = безлимитный подарок, ~83 года)
  const months = [1, 3, 6, 999].includes(Number(req.body?.months)) ? Number(req.body.months) : 3;
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

// --- Ручная оплата (наличные / перевод / СБП мимо кассы): создаёт paid-запись,
// продлевает подписку по тарифу и начисляет 20% рефереру — как обычная оплата ---
const MANUAL_METHODS = { cash: 'Наличные', transfer: 'Перевод/безнал', sbp: 'СБП вручную' };
r.post('/users/:id/payment', (req, res) => {
  const user = q.userById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Юзер не найден' });
  const method = String(req.body?.method || '');
  if (!MANUAL_METHODS[method]) return res.status(400).json({ error: 'Способ: cash | transfer | sbp' });
  const plan = findPlan(req.body?.plan_id);
  if (!plan) return res.status(400).json({ error: 'Неизвестный тариф' });
  const rub = Math.round(Number(req.body?.amount_rub));
  if (!rub || rub < 1 || rub > 1000000) return res.status(400).json({ error: 'Сумма: 1–1000000 ₽' });
  try {
    const pid = newId('mn_');
    q.insertPayment({
      id: pid, user_id: user.id, plan_id: plan.id,
      amount_cents: rub * 100, balance_used_cents: 0, status: 'pending',
      yk_payment_id: null, kind: 'plan', item: 'manual:' + method, qty: 1,
    });
    const bonus = applyPayment(q.payment(pid));
    const sub = q.sub(user.id);
    res.json({
      ok: true, payment_id: pid, amount: money(rub * 100), method: MANUAL_METHODS[method],
      plan: plan.name, expires_at: sub?.expires_at || null,
      referrer_bonus_cents: bonus,
    });
  } catch (e) {
    console.error('[admin] manual payment:', e.message);
    res.status(500).json({ error: 'Не удалось провести оплату' });
  }
});

// --- Учёт оплат: последние (включая ручные), с именами и способом ---
r.get('/payments', (req, res) => {
  const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 100));
  const rows = db.prepare(
    `SELECT p.*, u.username FROM payments p LEFT JOIN users u ON u.id = p.user_id
     ORDER BY COALESCE(p.paid_at, p.created_at) DESC LIMIT ?`
  ).all(limit);
  res.json({
    methods: MANUAL_METHODS,
    payments: rows.map((p) => ({
      id: p.id,
      username: p.username || ('id ' + p.user_id),
      amount_cents: p.amount_cents,
      amount: money(p.amount_cents),
      kind: p.kind,
      item: p.item || '',
      method: p.item?.startsWith('manual:')
        ? (MANUAL_METHODS[p.item.slice(7)] || p.item)
        : (p.yk_payment_id ? 'ЮKassa' : (p.status === 'paid' && !p.yk_payment_id ? 'баланс' : '—')),
      status: p.status,
      bonus_cents: p.bonus_cents || 0,
      created_at: p.created_at,
      paid_at: p.paid_at || '',
    })),
  });
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
