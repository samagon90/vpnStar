import { Router } from 'express';
import { cfg, DEVICES_BASE, DEVICE_PACK_PRICE_CENTS, DEVICE_PACK_MAX } from '../config.js';
import { q, nowISO } from '../db.js';
import { money, newId } from '../util.js';
import { provider } from '../vpn/provider.js';
import { yk } from '../yookassa.js';
import { applyPayment } from './pay.js';

const r = Router();

const limitOf = (user) => DEVICES_BASE + Number(user.devices_extra || 0);

function deviceInfo(d) {
  return {
    id: d.id,
    name: d.name,
    enabled: !!d.enabled,
    provider: d.provider,
    created_str: new Date(d.created_at).toLocaleDateString('ru-RU'),
    blocked_at: d.blocked_at,
  };
}

/** Список устройств + лимиты */
r.get('/', (req, res) => {
  const user = req.user;
  const devices = q.devicesOf(user.id).map(deviceInfo);
  const limit = limitOf(user);
  const used = devices.length;
  res.json({
    devices,
    base: DEVICES_BASE,
    extra: Number(user.devices_extra || 0),
    limit,
    used,
    can_add: used < limit,
    max_extra: DEVICE_PACK_MAX,
    can_buy: Number(user.devices_extra || 0) < DEVICE_PACK_MAX,
    pack_price: money(DEVICE_PACK_PRICE_CENTS),
  });
});

/** Создать устройство (нужен свободный слот) */
r.post('/', async (req, res) => {
  const user = req.user;
  const name = String((req.body || {}).name || '').trim().slice(0, 30) || `Устройство ${q.deviceCount(user.id) + 1}`;
  const limit = limitOf(user);
  if (q.deviceCount(user.id) >= limit) {
    return res.status(400).json({
      error: `Лимит ${limit} устройств исчерпан — докупите +1 за ${money(DEVICE_PACK_PRICE_CENTS)}`,
      code: 'limit',
    });
  }
  const id = q.insertDevice(user.id, name, 'pending', null);
  try {
    await provider.provisionDevice(user, q.device(id));
  } catch (e) {
    console.error('[devices] provision', e.message);
  }
  res.json({ ok: true, device: deviceInfo(q.device(id)), limit, used: q.deviceCount(user.id) });
});

/**
 * Купить +1 устройство (99 ₽). Оплатить можно СБП/картой или реферальным балансом.
 * Route ДО /:id.
 */
r.post('/buy', async (req, res) => {
  const user = req.user;
  if (Number(user.devices_extra || 0) >= DEVICE_PACK_MAX) {
    return res.status(400).json({ error: `Уже максимум: ${DEVICES_BASE + DEVICE_PACK_MAX} устройств` });
  }
  const useBalance = !!req.body.use_balance;
  const balance = user.balance_cents;
  const balanceUsed = useBalance ? Math.min(balance, DEVICE_PACK_PRICE_CENTS) : 0;
  const rest = DEVICE_PACK_PRICE_CENTS - balanceUsed;
  if (balanceUsed > 0) q.setBalance(user.id, user.balance_cents - balanceUsed);

  const checkoutId = newId('co_');
  q.insertPayment({
    id: checkoutId, user_id: user.id, plan_id: 0, amount_cents: DEVICE_PACK_PRICE_CENTS,
    balance_used_cents: balanceUsed, status: 'pending', kind: 'devices', item: '+1 устройство', qty: 1,
  });

  if (rest === 0) {
    applyPayment(q.payment(checkoutId));
    return res.json({ ok: true, paid: true, checkout_id: checkoutId, balance_used: balanceUsed, limit: limitOf(q.userById(user.id)) });
  }
  if (!yk.enabled()) {
    return res.json({ ok: true, paid: false, checkout_id: checkoutId, mode: 'mock', price_cents: rest, balance_used: balanceUsed });
  }
  try {
    const { ykId, confirmationUrl } = await yk.createPayment({
      amountCents: rest,
      description: 'Sonic VPN — устройство +1',
      returnUrl: `${cfg.base_url}/account.html`,
      idempotencyKey: checkoutId,
    });
    q.updatePaymentStatus(checkoutId, 'pending', { yk_payment_id: ykId });
    res.json({ ok: true, paid: false, checkout_id: checkoutId, mode: 'yookassa', confirmation_url: confirmationUrl, price_cents: rest, balance_used: balanceUsed });
  } catch (e) {
    console.error('yookassa create(device)', e.message);
    res.status(502).json({ error: `Платёжный сервис недоступен: ${e.message}` });
  }
});

/** Профиль устройства: VLESS-ссылка, конфиг, QR */
r.get('/:id', async (req, res) => {
  const device = q.device(req.params.id);
  if (!device || device.user_id !== req.user.id) return res.status(404).json({ error: 'Устройство не найдено' });
  if (device.provider === 'pending' && !device.ref_id) {
    // lazy-provision (например, 3x-ui был недоступен при создании)
    try { await provider.provisionDevice(req.user, device); } catch (e) { console.error('[devices] provision', e.message); }
  }
  const d = q.device(req.params.id);
  let profile = null;
  try {
    profile = await provider.profile(req.user, d);
    profile.qr = await provider.qrDataUrl(profile);
    delete profile.demo;
  } catch (e) {
    console.error('[devices] profile', e.message);
  }
  res.json({ device: deviceInfo(d), profile });
});

/** Имя и/или блокировка (enabled: false = заблокировано) */
r.patch('/:id', async (req, res) => {
  const device = q.device(req.params.id);
  if (!device || device.user_id !== req.user.id) return res.status(404).json({ error: 'Устройство не найдено' });
  const body = req.body || {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 30) || device.name;
    q.setDeviceName(device.id, name);
  }
  if (typeof body.enabled === 'boolean' && !!body.enabled !== !!device.enabled) {
    await provider.setDeviceEnabled(device, body.enabled);
    q.event(req.user.id, body.enabled ? 'device_unblocked' : 'device_blocked');
  }
  const d = q.device(req.params.id);
  res.json({ ok: true, device: deviceInfo(d) });
});

/** Удалить устройство (свободит слот) */
r.delete('/:id', async (req, res) => {
  const device = q.device(req.params.id);
  if (!device || device.user_id !== req.user.id) return res.status(404).json({ error: 'Устройство не найдено' });
  await provider.deleteDevice(device);
  q.event(req.user.id, 'device_removed');
  res.json({ ok: true, used: q.deviceCount(req.user.id) });
});

export default r;
