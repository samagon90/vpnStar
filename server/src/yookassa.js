import { cfg } from './config.js';

const BASE = 'https://api.yookassa.ru';

function auth() {
  return 'Basic ' + Buffer.from(`${cfg.yk_shop_id}:${cfg.yk_secret}`).toString('base64');
}

async function call(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      Authorization: auth(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = json && json.description ? json.description : `ЮKassa ${res.status}: ${text.slice(0, 300)}`;
    throw new Error(msg);
  }
  return json;
}

export const yk = {
  enabled: () => cfg.payment_mode === 'yookassa' && !!cfg.yk_shop_id && !!cfg.yk_secret,

  /** Создать платёж: СБП + карты РФ. Возвращает {id, confirmationUrl} */
  createPayment({ amountCents, description, returnUrl, idempotencyKey }) {
    return call('POST', '/v3/payments', {
      amount: { value: (amountCents / 100).toFixed(2), currency: 'RUB' },
      capture: true,
      description,
      paymentMethodTypes: ['sbp', 'card'],
      metadata: { checkout: idempotencyKey },
      confirmation: { type: 'redirect', returnUrl },
    }).then((r) => ({ ykId: r.id, confirmationUrl: r.confirmation.confirmation_url }));
  },

  getPayment(ykId) {
    return call('GET', `/v3/payments/${ykId}`);
  },

  refund(ykId, amountCents, description = 'Возврат по гарантии VpnStar') {
    return call('POST', '/v2/refunds', {
      payment_id: ykId,
      amount: { value: (amountCents / 100).toFixed(2), currency: 'RUB' },
      description,
    });
  },

  /** Токен вебхука = secret key (документация ЮKassa) */
  verifyWebhookToken(req) {
    return req.headers['x-yookassa-notification-token'] === cfg.yk_secret;
  },
};
