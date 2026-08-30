import { Router } from 'express';
import { yk } from '../yookassa.js';
import { q } from '../db.js';
import { applyPayment } from './pay.js';

const r = Router();

/** Webhook ЮKassa: payment.succeeded / payment.canceled */
r.post('/yookassa', async (req, res) => {
  if (!yk.verifyWebhookToken(req)) return res.status(403).json({ error: 'bad token' });
  const n = req.body || {};
  const obj = n.object || {};
  const ykId = obj.id;
  const p = ykId ? q.paymentByYk(ykId) : null;
  if (p && obj.status === 'succeeded' && p.status === 'pending') {
    applyPayment(p);
    console.log(`[webhook] payment ${p.id} paid`);
  }
  res.json({ ok: true });
});

export default r;
