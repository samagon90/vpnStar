import nodemailer from 'nodemailer';
import { cfg, PLANS } from './config.js';
import { q, addDays, daysLeft } from './db.js';
import { botApi } from './botref.js';

/**
 * Часовой cron:
 *  - напоминания об окончании подписки: за 5 / 2 / 1 день (email, если указан, + Telegram, если аккаунт синхронизирован)
 */
let started = false;

export function startCron() {
  if (started) return;
  started = true;
  const check = async () => {
    for (const [n, label] of [[5, '5'], [2, '2'], [1, '1']]) {
      const rows = q.expiredSoon(n, n);
      for (const s of rows) {
        const kind = `expire_${label}`;
        if (q.notifyExists(s.user_id, kind, s.expires_at)) continue;
        const user = q.userById(s.user_id);
        const plan = PLANS.find((p) => p.id === s.plan_id);
        const text = `VpnStar: ваша подписка (${plan ? plan.name : 'пробный период'}) истекает ${new Date(s.expires_at).toLocaleDateString('ru-RU')} — через ${n} дн. Продлите, чтобы не потерять доступ.`;
        let sent = false;
        if (user.tg_id && botApi()) {
          try {
            await botApi().sendMessage(user.tg_id, text);
            sent = true;
          } catch (e) { /* пользователь не писал боту / заблокировал */ }
        }
        if (user.email && cfg.smtp_host) {
          try {
            const t = nodemailer.createTransport({
              host: cfg.smtp_host,
              port: cfg.smtp_port,
              auth: { user: cfg.smtp_user, pass: cfg.smtp_pass },
            });
            await t.sendMail({ from: cfg.mail_from, to: user.email, subject: 'VpnStar: подписка заканчивается', text });
            sent = true;
          } catch (e) {
            console.error('[mail]', e.message);
          }
        }
        if (sent) q.addNotification(user.id, kind, s.expires_at);
      }
    }
  };
  check().catch((e) => console.error('[cron]', e.message));
  setInterval(() => check().catch((e) => console.error('[cron]', e.message)), 3600_000);
  console.log('[cron] напоминания об окончании подписки: включены');
}
