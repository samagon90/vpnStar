import crypto from 'node:crypto';

export function parseCookies(req, res, next) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  req.cookies = out;
  next();
}

export const newId = (prefix = '') => prefix + crypto.randomBytes(8).toString('hex');

export const randomRefCode = () => {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[crypto.randomInt(abc.length)];
  return s;
};

export const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${h}`;
};
export const verifyPassword = (password, stored) => {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(calc, 'hex'));
};

// --- Telegram Login Widget: official hash check ---
export function verifyTgWidget(data, botToken) {
  try {
    const { hash, ...rest } = data;
    const dcs = Object.keys(rest)
      .filter((k) => rest[k] !== undefined)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAuthSecret').update(botToken).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    return calc === hash;
  } catch {
    return false;
  }
}

export const money = (cents) => {
  const rub = Math.trunc(cents / 100);
  const k = Math.round(cents) % 100;
  return `${rub.toLocaleString('ru-RU')}${k ? `,${String(k).padStart(2, '0')}` : ''} ₽`;
};

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
