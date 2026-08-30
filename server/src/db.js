import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'sonicvpn.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  username_display TEXT NOT NULL,
  password_hash TEXT,
  email TEXT,
  tg_id INTEGER UNIQUE,
  tg_username TEXT,
  referral_code TEXT UNIQUE NOT NULL,
  referrer_id INTEGER REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions(
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'trial',
  plan_id INTEGER,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_used_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  yk_payment_id TEXT,
  bonus_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS vpn_clients(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications(
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY(kind, ref)
);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, at);
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users(referrer_id);
`);

export const nowISO = () => new Date().toISOString();

export const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

export const addMonths = (date, months) => {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
};

export const daysLeft = (iso) => Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 86400000));

// --- queries ---
export const q = {
  userById: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id)),
  userByName: (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(name),
  userByTg: (tgId) => db.prepare('SELECT * FROM users WHERE tg_id = ?').get(Number(tgId)),
  userByRefCode: (code) => db.prepare('SELECT * FROM users WHERE referral_code = ?').get(code),
  insertUser: (u) => {
    const r = db.prepare(`INSERT INTO users(username, username_display, password_hash, email, tg_id, tg_username, referral_code, referrer_id, created_at, last_active_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(u.username, u.username_display, u.password_hash ?? null, u.email ?? null, u.tg_id ?? null, u.tg_username ?? null, u.referral_code, u.referrer_id ?? null, u.created_at, u.created_at);
    return Number(r.lastInsertRowid);
  },
  touch: (id) => db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(nowISO(), Number(id)),
  linkTg: (id, tgId, tgUsername) => db.prepare('UPDATE users SET tg_id = ?, tg_username = ? WHERE id = ? AND (tg_id IS NULL)').run(Number(tgId), tgUsername, Number(id)),
  setBalance: (id, cents) => db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(cents, Number(id)),
  addBalance: (id, cents) => db.prepare('UPDATE users SET balance_cents = balance_cents + ? WHERE id = ?').run(cents, Number(id)),

  sub: (userId) => db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(Number(userId)),
  upsertSub: (userId, kind, planId, expiresAt) =>
    db.prepare(`INSERT INTO subscriptions(user_id, kind, plan_id, expires_at, updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind, plan_id=excluded.plan_id, expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
      .run(Number(userId), kind, planId ?? null, expiresAt, nowISO()),

  payment: (id) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id),
  paymentByYk: (ykId) => db.prepare('SELECT * FROM payments WHERE yk_payment_id = ?').get(ykId),
  insertPayment: (p) => db.prepare(`INSERT INTO payments(id, user_id, plan_id, amount_cents, balance_used_cents, status, yk_payment_id, created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(p.id, p.user_id, p.plan_id, p.amount_cents, p.balance_used_cents ?? 0, p.status ?? 'pending', p.yk_payment_id ?? null, p.created_at ?? nowISO()),
  updatePaymentStatus: (id, status, extra = {}) => {
    const sets = ['status = ?'];
    const args = [status];
    if (extra.paid_at) { sets.push('paid_at = ?'); args.push(extra.paid_at); }
    if (extra.yk_payment_id) { sets.push('yk_payment_id = ?'); args.push(extra.yk_payment_id); }
    if (extra.bonus_cents != null) { sets.push('bonus_cents = ?'); args.push(extra.bonus_cents); }
    args.push(id);
    db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  },
  paymentsOf: (userId) => db.prepare('SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(Number(userId)),

  client: (userId) => db.prepare('SELECT * FROM vpn_clients WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(Number(userId)),
  insertClient: (userId, provider, refId) => db.prepare('INSERT INTO vpn_clients(user_id, provider, ref_id, created_at) VALUES(?,?,?,?)').run(Number(userId), provider, refId, nowISO()),

  event: (userId, type) => db.prepare('INSERT INTO events(user_id, type, at) VALUES(?,?,?)').run(Number(userId), type, nowISO()),
  totalPaid: (userId) => Number(db.prepare("SELECT COALESCE(SUM(amount_cents + balance_used_cents),0) s FROM payments WHERE user_id = ? AND status = 'paid'").get(Number(userId)).s),

  invitedBy: (referrerId) => db.prepare('SELECT * FROM users WHERE referrer_id = ? ORDER BY created_at DESC').all(Number(referrerId)),
  earnSum: (referrerId) => Number(db.prepare("SELECT COALESCE(SUM(bonus_cents),0) s FROM payments p JOIN users u ON u.id = p.user_id WHERE u.referrer_id = ? AND p.status = 'paid' AND p.bonus_cents > 0").get(Number(referrerId)).s),

  notifyExists: (userId, kind, ref) => !!db.prepare('SELECT 1 FROM notifications WHERE user_id = ? AND kind = ? AND ref = ?').get(Number(userId), kind, ref),
  addNotification: (userId, kind, ref) => db.prepare('INSERT OR IGNORE INTO notifications(user_id, kind, ref, sent_at) VALUES(?,?,?,?)').run(Number(userId), kind, ref, nowISO()),

  expiredSoon: (fromDays, toDays) => {
    const a = addDays(new Date().toISOString(), fromDays).slice(0, 10);
    const b = addDays(new Date().toISOString(), toDays).slice(0, 10);
    return db.prepare('SELECT * FROM subscriptions WHERE substr(expires_at,1,10) >= ? AND substr(expires_at,1,10) <= ?').all(a, b);
  },
};

// --- sessions ---
export function createSession(userId, ttlDays = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)')
    .run(token, Number(userId), nowISO(), addDays(nowISO(), ttlDays));
  return token;
}
export function getSessionUser(req) {
  const token = req.cookies && req.cookies.vs_session;
  if (!token) return null;
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?').get(token, nowISO());
  return row || null;
}
export function destroySession(req) {
  const token = req.cookies && req.cookies.vs_session;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
