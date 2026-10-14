import { Router } from 'express';
import { prisma } from '../lib/db';
import { asyncRoute } from '../lib/http';
import { PayPalClient, sha256 } from '../services/paypal';
const router = Router(); const paypal = new PayPalClient();
router.post('/paypal', asyncRoute(async (req,res) => {
  const event = req.body;
  const headers: Record<string,string|undefined> = {
    'paypal-auth-algo':req.header('paypal-auth-algo') ?? undefined,
    'paypal-cert-url':req.header('paypal-cert-url') ?? undefined,
    'paypal-transmission-id':req.header('paypal-transmission-id') ?? undefined,
    'paypal-transmission-sig':req.header('paypal-transmission-sig') ?? undefined,
    'paypal-transmission-time':req.header('paypal-transmission-time') ?? undefined
  };
  const eventId = String(event?.id ?? ''); const eventType = String(event?.event_type ?? '');
  if (!eventId || !eventType) return res.status(400).json({ error:'invalid webhook envelope' });
  const verified = await paypal.verifyWebhook(headers, event);
  const payloadHash = sha256(event);
  const stored = await prisma.providerEvent.upsert({ where:{ provider_eventId:{ provider:'paypal', eventId } }, create:{ provider:'paypal', eventId, eventType, payloadHash, payload:event, verified }, update:{} });
  if (!verified) return res.status(400).json({ error:'webhook signature verification failed' });
  if (stored.payloadHash !== payloadHash) return res.status(409).json({ error:'event ID reused with different payload' });
  // Webhook is evidence, not a command: capture/order state must be independently fetched and matched.
  // The payment capture endpoint is the only current transition to CAPTURED_VERIFIED.
  if (!stored.processedAt) await prisma.providerEvent.update({ where:{ id:stored.id }, data:{ processedAt:new Date() } });
  res.status(200).json({ received:true, verified:true, eventId, eventType, action:'recorded; authoritative provider-state reconciliation remains required' });
}));
export default router;
