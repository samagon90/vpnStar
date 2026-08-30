import 'dotenv/config';

const env = (name, d = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? d : v;
};

export const cfg = {
  port: Number(env('PORT', '8080')),
  base_url: env('BASE_URL', 'http://localhost:8080').replace(/\/$/, ''),
  secret_key: env('SECRET_KEY', 'dev-secret-key-change-me'),

  payment_mode: env('PAYMENT_MODE', 'mock'), // mock | yookassa
  yk_shop_id: env('YOOKASSA_SHOP_ID'),
  yk_secret: env('YOOKASSA_SECRET_KEY'),
  yk_sandbox: env('YOOKASSA_IS_SANDBOX', 'true') === 'true',

  tg_bot_token: env('TG_BOT_TOKEN'),
  tg_support: env('TG_SUPPORT_USERNAME', ''),
  tg_channel_url: env('TG_CHANNEL_URL', 'https://t.me/sonicvpn_channel'),

  ai_api_base: env('AI_API_BASE'),
  ai_api_key: env('AI_API_KEY'),
  ai_model: env('AI_MODEL', 'gpt-4o-mini'),

  mail_from: env('MAIL_FROM', 'Sonic VPN <no-reply@sonicvpn.example>'),
  smtp_host: env('SMTP_HOST'),
  smtp_port: Number(env('SMTP_PORT', '587')),
  smtp_user: env('SMTP_USER'),
  smtp_pass: env('SMTP_PASS'),

  xui_base: env('XUI_BASE'),
  xui_user: env('XUI_USER'),
  xui_password: env('XUI_PASSWORD'),
  vpn_demo_host: env('VPN_DEMO_HOST', '203.0.113.10'),

  admin_token: env('ADMIN_TOKEN'),
};

export const REFERRAL_PERCENT = 20; // % от оплаты клиента уходит рефереру
export const TRIAL_DAYS = 7;
export const DEVICES_PER_PLAN = 5;

export const PLANS = [
  { id: 1, key: 'm1', name: '1 месяц', months: 1, price_cents: 19900 },
  { id: 2, key: 'm3', name: '3 месяца', months: 3, price_cents: 49900, popular: true },
  { id: 3, key: 'y1', name: '12 месяцев', months: 12, price_cents: 149900, best: true },
];
