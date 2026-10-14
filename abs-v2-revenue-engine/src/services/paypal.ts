import crypto from 'node:crypto';
import { env, assertLiveAllowed } from '../lib/config';

export type PayPalCapture = { orderId: string; captureId: string; status: string; amountCents: number; currency: string; raw: unknown };
export class PayPalClient {
  private async token(): Promise<string> {
    assertLiveAllowed();
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials are not configured');
    const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${env.PAYPAL_API_BASE}/v1/oauth2/token`, { method:'POST', headers:{ Authorization:`Basic ${basic}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:'grant_type=client_credentials' });
    if (!r.ok) throw new Error(`PayPal OAuth failed (${r.status})`);
    const body = await r.json() as { access_token?: string };
    if (!body.access_token) throw new Error('PayPal returned no access token');
    return body.access_token;
  }
  async createOrder(amountCents: number, currency: string, referenceId: string) {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error('Invalid amount');
    const token = await this.token();
    const r = await fetch(`${env.PAYPAL_API_BASE}/v2/checkout/orders`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'PayPal-Request-Id':`abs-order-${referenceId}` }, body:JSON.stringify({ intent:'CAPTURE', purchase_units:[{ reference_id:referenceId, amount:{ currency_code:currency, value:(amountCents/100).toFixed(2) } }] }) });
    const body = await r.json() as any;
    if (!r.ok) throw new Error(`PayPal order creation failed (${r.status})`);
    if (!body.id) throw new Error('PayPal response missing order ID');
    return { id: body.id as string, status: body.status as string, links: body.links ?? [] };
  }
  async captureOrder(orderId: string, expectedCents: number, expectedCurrency: string): Promise<PayPalCapture> {
    const token = await this.token();
    let body: any;
    // Recover an earlier successful capture before attempting another POST.
    const existing = await this.getOrder(orderId).catch(() => null) as any;
    if (existing?.status === 'COMPLETED' && existing.purchase_units?.[0]?.payments?.captures?.[0]) {
      body = existing;
    } else {
      try {
        const r = await fetch(`${env.PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'PayPal-Request-Id':`abs-capture-${orderId}` }, body:'{}' });
        body = await r.json() as any;
        if (!r.ok) {
          // 422 can mean the order was already captured; verify provider state before deciding.
          const reconciled = await this.getOrder(orderId).catch(() => null) as any;
          if (reconciled?.status === 'COMPLETED' && reconciled.purchase_units?.[0]?.payments?.captures?.[0]) body = reconciled;
          else throw new Error(`PayPal capture outcome uncertain (${r.status}); reconcile order before retrying`);
        }
      } catch (err) {
        const reconciled = await this.getOrder(orderId).catch(() => null) as any;
        if (reconciled?.status === 'COMPLETED' && reconciled.purchase_units?.[0]?.payments?.captures?.[0]) body = reconciled;
        else throw new Error(`PayPal capture outcome uncertain; provider lookup did not confirm completion (${err instanceof Error ? err.message : 'unknown error'})`);
      }
    }
    const unit = body.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];
    if (!capture) throw new Error('No capture evidence in PayPal response; reconcile before continuing');
    const amountCents = Math.round(Number(capture.amount?.value) * 100);
    const currency = String(capture.amount?.currency_code ?? '');
    if (capture.status !== 'COMPLETED' || amountCents !== expectedCents || currency !== expectedCurrency) throw new Error('Provider capture does not match expected amount/currency/status');
    return { orderId, captureId:String(capture.id), status:String(capture.status), amountCents, currency, raw:body };
  }
  async getOrder(orderId: string): Promise<any> {
    const token = await this.token();
    const r = await fetch(`${env.PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!r.ok) throw new Error(`PayPal order lookup failed (${r.status})`);
    return r.json();
  }

  async submitPayout(input: { receiver: string; amountCents: number; currency: string; idempotencyKey: string; note: string }) {
    const token = await this.token();
    const r = await fetch(`${env.PAYPAL_API_BASE}/v1/payments/payouts`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json', 'PayPal-Request-Id':input.idempotencyKey }, body:JSON.stringify({ sender_batch_header:{ sender_batch_id:input.idempotencyKey.slice(0,30), email_subject:'Your payout is being processed', email_message:input.note.slice(0,1000) }, items:[{ recipient_type:'EMAIL', receiver:input.receiver, note:input.note.slice(0,1000), sender_item_id:input.idempotencyKey.slice(0,30), amount:{ value:(input.amountCents/100).toFixed(2), currency:input.currency } }] }) });
    const body = await r.json() as any;
    if (!r.ok) {
      // Never blindly retry a timed-out/ambiguous payout. Caller must query/reconcile first.
      const err = new Error(`PayPal payout submission outcome uncertain or rejected (${r.status})`);
      (err as any).providerBody = body;
      throw err;
    }
    const batchId = body.batch_header?.payout_batch_id;
    if (!batchId) throw new Error('PayPal payout response missing batch ID; outcome must be reconciled');
    return { batchId:String(batchId), batchStatus:String(body.batch_header?.batch_status ?? 'PENDING'), raw:body };
  }
  async getPayoutBatch(batchId: string): Promise<any> {
    const token = await this.token();
    const r = await fetch(`${env.PAYPAL_API_BASE}/v1/payments/payouts/${encodeURIComponent(batchId)}`, { headers:{ Authorization:`Bearer ${token}` } });
    if (!r.ok) throw new Error(`PayPal payout batch lookup failed (${r.status})`);
    return r.json();
  }
  async verifyWebhook(headers: Record<string,string | undefined>, event: unknown): Promise<boolean> {
    if (!env.PAYPAL_WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID is not configured');
    const token = await this.token();
    const r = await fetch(`${env.PAYPAL_API_BASE}/v1/notifications/verify-webhook-signature`, { method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' }, body:JSON.stringify({ auth_algo:headers['paypal-auth-algo'], cert_url:headers['paypal-cert-url'], transmission_id:headers['paypal-transmission-id'], transmission_sig:headers['paypal-transmission-sig'], transmission_time:headers['paypal-transmission-time'], webhook_id:env.PAYPAL_WEBHOOK_ID, webhook_event:event }) });
    if (!r.ok) throw new Error(`Webhook verification API failed (${r.status})`);
    const body = await r.json() as { verification_status?: string };
    return body.verification_status === 'SUCCESS';
  }
}
export function sha256(value: unknown) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
