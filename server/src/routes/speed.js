import crypto from 'node:crypto';
import { Router } from 'express';

/**
 * Sonic Speedtest: проверка скорости до VPN-сервера (и через VPN).
 * Без зависимостей: download — поток случайных байт, upload — приём и сброс.
 * Антиабуз: размер ≤25 МБ, кулдаун 10с на IP.
 */
const r = Router();
const lastHit = new Map(); // ip -> ts

function cooled(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '?';
  const now = Date.now();
  if (now - (lastHit.get(ip) || 0) < 10000) {
    res.status(429).json({ error: 'Подождите 10 секунд и повторите' });
    return null;
  }
  lastHit.set(ip, now);
  if (lastHit.size > 2000) lastHit.clear();
  return true;
}

r.get('/ping', (req, res) => {
  res.json({ t: Date.now() });
});

r.get('/download', (req, res) => {
  if (!cooled(req, res)) return;
  const mb = Math.min(25, Math.max(1, Number(req.query.size) || 10));
  const total = mb * 1024 * 1024;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', total);
  res.setHeader('Cache-Control', 'no-store');
  let sent = 0;
  const chunk = () => {
    if (sent >= total) return res.end();
    const n = Math.min(256 * 1024, total - sent);
    sent += n;
    if (!res.write(crypto.randomBytes(n))) return res.once('drain', chunk);
    setImmediate(chunk);
  };
  chunk();
});

r.post('/upload', (req, res) => {
  if (!cooled(req, res)) return;
  let bytes = 0;
  req.on('data', (c) => {
    bytes += c.length;
    if (bytes > 25 * 1024 * 1024) {
      res.status(413).json({ error: 'Слишком много (макс 25 МБ)' });
      req.destroy();
    }
  });
  req.on('end', () => res.json({ ok: true, bytes }));
  req.on('error', () => res.status(500).json({ error: 'Сбой приёма' }));
});

export default r;
