import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { asyncRoute } from '../lib/http';
import { agentCard, supportedAgentTasks } from '../services/agent-catalog';
import { redis } from '../lib/queue';

const router = Router();
const allowedTypes = supportedAgentTasks.map(t => t.id) as [string, ...string[]];
const WINDOW_SECONDS = 60;
const MAX_PER_WINDOW = 12;
async function rateLimit(key: string): Promise<boolean> {
  const bucketKey = `abs:agent-api:rate:${crypto.createHash('sha256').update(key).digest('hex')}`;
  const count = await redis.incr(bucketKey);
  if (count === 1) await redis.expire(bucketKey, WINDOW_SECONDS);
  return count <= MAX_PER_WINDOW;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validateInput(taskType: string, input: Record<string, unknown>) {
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 10000 || !input.rows.every(isRecord)) throw Object.assign(new Error('input.rows must be an array of 1–10000 objects'), { statusCode: 400 });
  if (taskType === 'data_transformation' && (!isRecord(input.mapping) || !Object.values(input.mapping).every(v => typeof v === 'string'))) throw Object.assign(new Error('data_transformation requires mapping { outputKey: inputKey }'), { statusCode: 400 });
  if (taskType === 'categorization' && (typeof input.categoryField !== 'string' || !Array.isArray(input.categories) || !input.categories.every(v => typeof v === 'string'))) throw Object.assign(new Error('categorization requires categoryField and a string categories array'), { statusCode: 400 });
}
router.get('/.well-known/agent.json', (_req, res) => res.json(agentCard));
router.get('/catalog', (_req, res) => res.json({ ...agentCard, generatedAt: new Date().toISOString() }));
router.get('/openapi.json', (_req, res) => res.json({ openapi: '3.1.0', info: { title: 'ABS v2 Agent API', version: '1.0.0' }, servers: [{ url: process.env.APP_BASE_URL ?? 'http://localhost:8080' }], paths: {
  '/agent/v1/catalog': { get: { summary: 'List supported services and fixed prices', responses: { '200': { description: 'Service catalog' } } } },
  '/agent/v1/jobs': { post: { summary: 'Create a $1 USD job quote', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['buyerEmail','taskType','input'], properties: { buyerEmail: { type: 'string', format: 'email' }, buyerName: { type: 'string' }, taskType: { type: 'string', enum: allowedTypes }, input: { type: 'object' }, idempotencyKey: { type: 'string', minLength: 16, maxLength: 128 } } } } } }, responses: { '201': { description: 'Job and quote created' }, '400': { description: 'Invalid request' }, '409': { description: 'Idempotency conflict' }, '429': { description: 'Rate limited' } } } }
} }));

const createSchema = z.object({ buyerEmail: z.string().email().max(254), buyerName: z.string().max(120).optional(), taskType: z.enum(allowedTypes), input: z.record(z.string(), z.unknown()), idempotencyKey: z.string().min(16).max(128).optional() }).strict();
router.post('/jobs', asyncRoute(async (req, res) => {
  const clientKey = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  if (!(await rateLimit(clientKey))) return res.status(429).json({ error: 'rate limit exceeded', retryAfterSeconds: WINDOW_SECONDS });
  const body = createSchema.parse(req.body);
  validateInput(body.taskType, body.input);
  const canonicalEmail = body.buyerEmail.toLowerCase();
  const requestHash = crypto.createHash('sha256').update(stable({ buyerEmail: canonicalEmail, buyerName: body.buyerName ?? null, taskType: body.taskType, input: body.input })).digest('hex');
  if (body.idempotencyKey) {
    const existing = await prisma.agentRequest.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
    if (existing) {
      if (existing.requestHash !== requestHash || existing.buyerEmail !== canonicalEmail) return res.status(409).json({ error: 'idempotency key was already used for a different request' });
      const task = await prisma.task.findUnique({ where: { id: existing.taskId }, include: { quote: true } });
      if (!task) return res.status(409).json({ error: 'idempotency record exists but task is unavailable; reconciliation required' });
      const base = process.env.APP_BASE_URL ?? 'http://localhost:8080';
      return res.status(200).json({ taskId: task.id, status: task.status, replay: true, quote: { id: task.quote.id, amountCents: task.quote.amountCents, currency: task.quote.currency, expiresAt: task.quote.expiresAt }, payment: { provider: 'paypal', createOrderUrl: `${base}/tasks/${task.id}/payment-order`, captureUrl: `${base}/tasks/${task.id}/capture` } });
    }
  }
  let created: any;
  try { created = await prisma.$transaction(async tx => {
    const customer = await tx.customer.upsert({ where: { email: canonicalEmail }, create: { email: canonicalEmail, name: body.buyerName }, update: { name: body.buyerName ?? undefined } });
    if (customer.optedOut) throw Object.assign(new Error('buyer has opted out'), { statusCode: 409 });
    const payload = { ...body.input, ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}) };
    const opportunity = await tx.opportunity.create({ data: { source: 'agent-api', customerId: customer.id, taskType: body.taskType, payload, status: 'QUALIFIED' } });
    const quote = await tx.quote.create({ data: { opportunityId: opportunity.id, amountCents: 100, currency: 'USD', pricingVersion: 'agent-fixed-v1', expiresAt: new Date(Date.now() + 15 * 60_000) } });
    const task = await tx.task.create({ data: { opportunityId: opportunity.id, customerId: customer.id, quoteId: quote.id, taskType: body.taskType, status: 'QUOTED', input: body.input } });
    if (body.idempotencyKey) await tx.agentRequest.create({ data: { idempotencyKey: body.idempotencyKey, requestHash, buyerEmail: canonicalEmail, taskId: task.id } });
    await tx.auditEvent.create({ data: { agent: 'agent-api', action: 'AGENT_JOB_QUOTED', taskId: task.id, result: 'SUCCESS', correlationId: task.id, evidence: { quoteId: quote.id, amountCents: 100, currency: 'USD', pricingVersion: 'agent-fixed-v1', idempotencyKey: body.idempotencyKey ?? null } } });
    return { task, quote };
  }); } catch (err) {
    // Concurrent retries race on the database unique constraint; return the committed original request.
    if (body.idempotencyKey && err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      const existing = await prisma.agentRequest.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
      if (existing && existing.requestHash === requestHash && existing.buyerEmail === canonicalEmail) {
        const task = await prisma.task.findUnique({ where: { id: existing.taskId }, include: { quote: true } });
        if (task) { const base = process.env.APP_BASE_URL ?? 'http://localhost:8080'; return res.status(200).json({ taskId: task.id, status: task.status, replay: true, quote: { id: task.quote.id, amountCents: task.quote.amountCents, currency: task.quote.currency, expiresAt: task.quote.expiresAt }, payment: { provider: 'paypal', createOrderUrl: `${base}/tasks/${task.id}/payment-order`, captureUrl: `${base}/tasks/${task.id}/capture` } }); }
      }
      return res.status(409).json({ error: 'idempotency conflict; inspect the existing request before retrying' });
    }
    throw err;
  }
  const base = process.env.APP_BASE_URL ?? 'http://localhost:8080';
  res.status(201).json({ taskId: created.task.id, status: created.task.status, quote: { id: created.quote.id, amountCents: 100, currency: 'USD', expiresAt: created.quote.expiresAt }, payment: { provider: 'paypal', createOrderUrl: `${base}/tasks/${created.task.id}/payment-order`, captureUrl: `${base}/tasks/${created.task.id}/capture`, executionPolicy: 'Provider-confirmed matching capture is required before execution.' }, note: 'A quote is not payment confirmation. PayPal buyer approval may be required; the service does not claim crypto/x402 support until a real facilitator adapter is installed.' });
}));
export default router;
