import { Router } from 'express';
import { cfg, TRIAL_DAYS } from '../config.js';
import { db, q, createSession, nowISO, addDays } from '../db.js';
import { hashPassword, verifyPassword, verifyTgWidget, randomRefCode } from '../util.js';
import { provider } from '../vpn/provider.js';

const r = Router();

const COOKIE = {
  httpOnly: true,
  sameSite: 'lax',
  secure: cfg.base_url.startsWith('https'),
  maxAge: 30 * 86400 * 1000,
};

/**
 * Регистрация БЕЗ подтверждения почты и номера:
 * логин + пароль, email опциональный (никаких писем и кодов).
 */
r.post('/register', async (req, res) => {
  try {
    const { username, password, email, ref } = req.body || {};
    const uname = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) return res.status(400).json({ error: 'Логин: 3–20 символов, латиница, цифры, _' });
    if (String(password || '').length < 6) return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    if (q.userByName(uname)) return res.status(409).json({ error: 'Такой логин уже занят' });

    let referrerId = null;
    if (ref) {
      const refUser = q.userByRefCode(String(ref).trim().toLowerCase());
      if (refUser) referrerId = refUser.id;
    }

    const code = randomRefCode();
    db.exec('BEGIN');
    let id;
    try {
      id = q.insertUser({
        username: uname,
        username_display: uname,
        password_hash: hashPassword(password),
        email: email || null,
        referral_code: code,
        referrer_id: referrerId,
        created_at: nowISO(),
      });
      q.upsertSub(id, 'trial', null, addDays(nowISO(), TRIAL_DAYS));
      q.insertClient(id, 'pending', 'pending');
      q.event(id, 'register');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // профиль VPS — отдельно (может быть долгим/недоступным)
    await provider.provision({ id });
    const token = createSession(id);
    q.touch(id);
    res.setHeader('Set-Cookie', `vs_session=${token}; Path=/; HttpOnly; SameSite=Lax${COOKIE.secure ? '; Secure' : ''}; Max-Age=${COOKIE.maxAge / 1000}`);
    res.json({ ok: true, user: { username: uname, referral_code: code, trial: true } });
  } catch (e) {
    console.error('register', e);
    res.status(500).json({ error: 'Ошибка сервера, попробуйте ещё раз' });
  }
});

r.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = q.userByName(String(username || '').trim().toLowerCase());
  if (!user || !user.password_hash || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  }
  q.touch(user.id);
  q.event(user.id, 'login');
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', `vs_session=${token}; Path=/; HttpOnly; SameSite=Lax${COOKIE.secure ? '; Secure' : ''}; Max-Age=${COOKIE.maxAge / 1000}`);
  res.json({ ok: true });
});

/** Telegram Login Widget (кнопка «Войти через Telegram» на сайте) — синхронизация аккаунта */
r.post('/auth/telegram', (req, res) => {
  if (!cfg.tg_bot_token) return res.status(503).json({ error: 'Telegram-вход не настроен' });
  const data = req.body || {};
  if (!data.hash || !data.id) return res.status(400).json({ error: 'Пустые данные Telegram' });
  if (data.auth_date && Date.now() / 1000 - Number(data.auth_date) > 86400) {
    return res.status(401).json({ error: 'Сессия Telegram истекла, попробуйте снова' });
  }
  if (!verifyTgWidget(data, cfg.tg_bot_token)) return res.status(401).json({ error: 'Подпись Telegram не совпала' });

  let user = q.userByTg(Number(data.id));
  let created = false;
  if (!user) {
    const uname = String(data.username || `user${data.id}`).toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 18) || `tg${data.id}`;
    const taken = q.userByName(uname);
    const finalName = taken && taken.tg_id !== Number(data.id) ? `${uname.slice(0, 14)}_${String(data.id).slice(-4)}` : uname;
    let referrerId = null;
    if (data.ref) {
      const refUser = q.userByRefCode(String(data.ref).toLowerCase());
      if (refUser) referrerId = refUser.id;
    }
    const id = q.insertUser({
      username: finalName,
      username_display: data.first_name ? `${data.first_name} (Telegram)` : finalName,
      email: null,
      tg_id: Number(data.id),
      tg_username: data.username || null,
      referral_code: randomRefCode(),
      referrer_id: referrerId,
      created_at: nowISO(),
    });
    user = q.userById(id);
    created = true;
  } else {
    q.linkTg(user.id, Number(data.id), data.username || user.tg_username);
  }
  q.touch(user.id);
  q.event(user.id, created ? 'register' : 'login');
  if (created) {
    q.upsertSub(user.id, 'trial', null, addDays(nowISO(), TRIAL_DAYS));
    provider.provision(user).catch((e) => console.error('provision(tg)', e.message));
  }
  const token = createSession(user.id);
  res.setHeader('Set-Cookie', `vs_session=${token}; Path=/; HttpOnly; SameSite=Lax${COOKIE.secure ? '; Secure' : ''}; Max-Age=${COOKIE.maxAge / 1000}`);
  res.json({ ok: true, created });
});

/** Настройки для Telegram Login Widget (кнопка на сайте) */
r.get('/auth/telegram-config', (req, res) => {
  if (!cfg.tg_bot_token) return res.json({ enabled: false });
  res.json({ enabled: true, bot: cfg.tg_bot_token.split(':')[0], origin: cfg.base_url });
});

r.post('/logout', (req, res) => {
  const user = req.user;
  if (user) q.touch(user.id);
  res.setHeader('Set-Cookie', 'vs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

r.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'not authorized' });
  const u = req.user;
  res.json({
    username: u.username,
    display: u.username_display,
    email: u.email || null,
    tg_linked: !!u.tg_id,
    referral_code: u.referral_code,
    balance_cents: u.balance_cents,
    created_at: u.created_at,
  });
});

export default r;
