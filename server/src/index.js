import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { getSessionUser } from './db.js';
import { parseCookies } from './util.js';
import authRoutes from './routes/auth.js';
import payRoutes from './routes/pay.js';
import accountRoutes from './routes/account.js';
import devicesRoutes from './routes/devices.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';
import { startBot } from './bot.js';
import { setBot } from './botref.js';
import { startCron } from './cron.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(parseCookies);

// CORS: для варианта, когда сайт на Cloudflare Pages, а API — на VPS (см. deploy/README.md)
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// авторизация: cookie-сессия
app.use((req, res, next) => {
  req.user = getSessionUser(req);
  next();
});
const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
  next();
};

// --- API ---
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use('/api', authRoutes);
app.use('/api/admin', adminRoutes); // ДО общего requireAuth: админка входит по своему токену
app.use('/api/payments', requireAuth, payRoutes);
app.use('/api', requireAuth, accountRoutes);
app.use('/api/devices', requireAuth, devicesRoutes);
app.use('/api/webhooks', webhookRoutes);

// --- Статика: сайт (работает в РФ без VPN: деплой на Cloudflare Pages / за Cloudflare-прокси) ---
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

app.use((err, req, res, next) => {
  console.error('[http]', err);
  res.status(500).json({ error: 'Внутренняя ошибка' });
});

app.listen(cfg.port, '0.0.0.0', () => {
  console.log(`Sonic VPN: http://0.0.0.0:${cfg.port} (mode: ${cfg.payment_mode}, vpn: ${cfg.xui_base ? '3x-ui' : 'mock'})`);
});

const bot = startBot();
if (bot) setBot(bot);
startCron();
