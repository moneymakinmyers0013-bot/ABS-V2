import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { asyncRoute, requireAdmin } from '../lib/http';
import { PayPalClient, sha256 } from '../services/paypal';
import { enqueueTask } from '../services/executor';
import { postBalancedGroup } from '../services/ledger';
const router = Router(); const paypal = new PayPalClient();
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const createSchema = z.object({ customerEmail:z.string().email(), customerName:z.string().optional(), source:z.string().min(1), taskType:z.enum(['csv_cleanup','data_normalization','duplicate_removal','data_transformation','categorization']), input:z.record(z.string(),z.unknown()), amountCents:z.number().int().positive().max(50000), currency:z.literal('USD').default('USD'), pricingVersion:z.string().min(1).default('v1'), expiresInMinutes:z.number().int().positive().max(1440).default(60) });
router.post('/', asyncRoute(async (req,res) => {
  const body = createSchema.parse(req.body);
  const result = await prisma.$transaction(async tx => {
    const customer = await tx.customer.upsert({ where:{ email:body.customerEmail.toLowerCase() }, create:{ email:body.customerEmail.toLowerCase(), name:body.customerName }, update:{ name:body.customerName ?? undefined } });
    if (customer.optedOut) throw new Error('Customer has opted out; do not create a sales task');
    const opportunity = await tx.opportunity.create({ data:{ source:body.source, customerId:customer.id, taskType:body.taskType, payload:body.input, status:'QUALIFIED' } });
    const quote = await tx.quote.create({ data:{ opportunityId:opportunity.id, amountCents:body.amountCents, currency:body.currency.toUpperCase(), pricingVersion:body.pricingVersion, expiresAt:new Date(Date.now()+body.expiresInMinutes*60000) } });
    const task = await tx.task.create({ data:{ opportunityId:opportunity.id, customerId:customer.id, quoteId:quote.id, taskType:body.taskType, status:'QUOTED', input:body.input } });
    await tx.auditEvent.create({ data:{ agent:'api', action:'TASK_QUOTED', taskId:task.id, result:'SUCCESS', correlationId:task.id, evidence:{ quoteId:quote.id, amountCents:quote.amountCents, currency:quote.currency } } });
    return { task, quote };
  });
  res.status(201).json({ taskId:result.task.id, status:result.task.status, quote:{ id:result.quote.id, amountCents:result.quote.amountCents, currency:result.quote.currency, expiresAt:result.quote.expiresAt } });
}));
router.post('/:taskId/payment-order', asyncRoute(async (req,res) => {
  const task = await prisma.task.findUnique({ where:{ id:req.params.taskId }, include:{ quote:true } });
  if (!task) return res.status(404).json({ error:'task not found' });
  if (task.status !== 'QUOTED') return res.status(409).json({ error:`task is not quotable in status ${task.status}` });
  if (task.quote.expiresAt <= new Date() || task.quote.status !== 'OPEN') return res.status(409).json({ error:'quote expired or closed' });
  const existingPayment = await prisma.paymentTransaction.findFirst({ where:{ quoteId:task.quoteId, direction:'INBOUND' } });
  if (existingPayment) return res.status(409).json({ error:'a payment order already exists for this quote; reconcile it instead of creating another order' });
  const order = await paypal.createOrder(task.quote.amountCents, task.quote.currency, task.id);
  const payment = await prisma.paymentTransaction.create({ data:{ direction:'INBOUND', provider:'paypal', quoteId:task.quoteId, providerOrderId:order.id, amountCents:task.quote.amountCents, currency:task.quote.currency, status:'CREATED' } });
  await prisma.auditEvent.create({ data:{ agent:'api', action:'PAYMENT_ORDER_CREATED', taskId:task.id, transactionId:payment.id, provider:'paypal', result:'PENDING', correlationId:task.id, evidence:{ providerOrderId:order.id } } });
  res.status(201).json({ paymentTransactionId:payment.id, providerOrderId:order.id, providerStatus:order.status, links:order.links });
}));
router.post('/:taskId/capture', asyncRoute(async (req,res) => {
  const task = await prisma.task.findUnique({ where:{ id:req.params.taskId }, include:{ quote:true } });
  if (!task) return res.status(404).json({ error:'task not found' });
  const payment = await prisma.paymentTransaction.findFirst({ where:{ quoteId:task.quoteId, direction:'INBOUND', status:'CREATED' }, orderBy:{ createdAt:'desc' } });
  if (task.status !== 'QUOTED' || task.quote.status !== 'OPEN') return res.status(409).json({ error:'task or quote is no longer awaiting payment' });
  if (!payment?.providerOrderId) return res.status(409).json({ error:'payment order not found' });
  if (task.quote.expiresAt <= new Date()) return res.status(409).json({ error:'quote expired' });
  const capture = await paypal.captureOrder(payment.providerOrderId, task.quote.amountCents, task.quote.currency);
  await prisma.$transaction(async tx => {
    const prior = await tx.paymentTransaction.findFirst({ where:{ providerCaptureId:capture.captureId } });
    if (prior && prior.id !== payment.id) throw new Error('Provider capture already associated with another transaction');
    await tx.paymentTransaction.update({ where:{ id:payment.id }, data:{ providerCaptureId:capture.captureId, status:'CAPTURED_VERIFIED' } });
    await postBalancedGroup(tx, { idempotencyKey:`capture:${capture.captureId}`, kind:'CUSTOMER_CAPTURE', currency:capture.currency, evidenceType:'provider_capture', evidenceId:capture.captureId, lines:[{ account:'PROVIDER_CASH', amountCents:capture.amountCents }, { account:'CUSTOMER_PREPAID', amountCents:-capture.amountCents }] });
    await tx.quote.update({ where:{ id:task.quoteId }, data:{ status:'PAID' } });
    await tx.task.update({ where:{ id:task.id }, data:{ status:'AUTHORIZED' } });
    await tx.providerSnapshot.create({ data:{ subjectType:'capture', subjectId:capture.captureId, provider:'paypal', payloadHash:sha256(capture.raw), payload:capture.raw as any } });
    await tx.reconciliationRecord.create({ data:{ subjectType:'payment', subjectId:payment.id, outcome:'MATCH', details:{ providerCaptureId:capture.captureId, amountCents:capture.amountCents, currency:capture.currency, status:capture.status } } });
    await tx.auditEvent.create({ data:{ agent:'api', action:'PAYMENT_CAPTURE_VERIFIED', taskId:task.id, transactionId:payment.id, provider:'paypal', result:'VERIFIED', correlationId:task.id, evidence:{ captureId:capture.captureId, amountCents:capture.amountCents, currency:capture.currency } } });
  });
  res.json({ taskId:task.id, status:'AUTHORIZED', providerCaptureId:capture.captureId, verified:true });
}));
router.post('/:taskId/run', requireAdmin, asyncRoute(async (req,res) => {
  const task = await prisma.task.findUnique({ where:{ id:req.params.taskId }, include:{ quote:true } });
  if (!task) return res.status(404).json({ error:'task not found' });
  if (task.status !== 'AUTHORIZED' && task.status !== 'ACCEPTED') return res.status(409).json({ error:`task must be funded and authorized; current status=${task.status}` });
  const payment = await prisma.paymentTransaction.findFirst({ where:{ quoteId:task.quoteId, status:'CAPTURED_VERIFIED', direction:'INBOUND' } });
  if (!payment || payment.amountCents !== task.quote.amountCents || payment.currency !== task.quote.currency) return res.status(409).json({ error:'matching verified provider capture required' });
  await enqueueTask(task.id);
  res.status(202).json({ taskId:task.id, queued:true });
}));

// Create a time-limited delivery receipt only after the worker has persisted a passing validation.
router.post('/:taskId/deliver', requireAdmin, asyncRoute(async (req,res) => {
  const task = await prisma.task.findUnique({ where:{ id:req.params.taskId }, include:{ artifacts:{ where:{ kind:'OUTPUT' }, orderBy:{ createdAt:'desc' }, take:1 }, validations:{ orderBy:{ createdAt:'desc' }, take:1 }, deliveryReceipt:true } });
  if (!task) return res.status(404).json({ error:'task not found' });
  if (task.status !== 'DELIVERABLE_SUBMITTED') return res.status(409).json({ error:`task must have a newly validated deliverable; current status=${task.status}` });
  const artifact = task.artifacts[0];
  const validation = task.validations[0];
  if (!artifact || !validation?.passed) return res.status(409).json({ error:'passing validation and output artifact required' });
  const bytes = await fs.readFile(artifact.storagePath);
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualHash !== artifact.sha256) return res.status(409).json({ error:'output artifact hash mismatch; delivery blocked' });
  const token = crypto.randomBytes(32).toString('base64url');
  const receipt = await prisma.$transaction(async tx => {
    const r = await tx.deliveryReceipt.upsert({ where:{ taskId:task.id }, create:{ taskId:task.id, artifactId:artifact.id, tokenHash:tokenHash(token), expiresAt:new Date(Date.now()+7*24*60*60*1000) }, update:{ artifactId:artifact.id, tokenHash:tokenHash(token), expiresAt:new Date(Date.now()+7*24*60*60*1000), downloadedAt:null, acceptedAt:null, deliveredAt:new Date() } });
    await tx.task.update({ where:{ id:task.id }, data:{ deliveredAt:new Date() } });
    await tx.auditEvent.create({ data:{ agent:'delivery-service', action:'TASK_DELIVERED', taskId:task.id, result:'SUCCESS', correlationId:r.id, evidence:{ artifactId:artifact.id, sha256:artifact.sha256, sizeBytes:artifact.sizeBytes, receiptId:r.id, expiresAt:r.expiresAt.toISOString() } } });
    return r;
  });
  res.status(201).json({ taskId:task.id, delivered:true, deliveryUrl:`/tasks/delivery/${receipt.id}?token=${encodeURIComponent(token)}`, acceptanceUrl:`/tasks/delivery/${receipt.id}/accept`, expiresAt:receipt.expiresAt, artifact:{ filename:artifact.filename, mime:artifact.mime, sha256:artifact.sha256, sizeBytes:artifact.sizeBytes } });
}));

// Delivery token is high entropy and stored only as a SHA-256 hash. Never expose storagePath.
router.get('/delivery/:receiptId', asyncRoute(async (req,res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(401).json({ error:'delivery token required' });
  const receipt = await prisma.deliveryReceipt.findUnique({ where:{ id:req.params.receiptId }, include:{ task:{ include:{ artifacts:true } } } });
  if (!receipt || receipt.expiresAt <= new Date() || receipt.tokenHash !== tokenHash(token)) return res.status(404).json({ error:'delivery receipt invalid or expired' });
  const artifact = receipt.task.artifacts.find(a => a.id === receipt.artifactId && a.kind === 'OUTPUT');
  if (!artifact) return res.status(404).json({ error:'deliverable not found' });
  const bytes = await fs.readFile(artifact.storagePath);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) return res.status(409).json({ error:'artifact integrity check failed' });
  await prisma.deliveryReceipt.update({ where:{ id:receipt.id }, data:{ downloadedAt:new Date() } });
  res.setHeader('Content-Type', artifact.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename.replace(/[\r\n"\\]/g,'_')}"`);
  res.setHeader('Content-Length', String(bytes.length));
  res.send(bytes);
}));

// Customer acceptance is authorized by the one-time delivery token, not by an AI decision.
router.post('/delivery/:receiptId/accept', asyncRoute(async (req,res) => {
  const schema = z.object({ token:z.string().min(32), accepted:z.literal(true), note:z.string().max(1000).optional() });
  const body = schema.parse(req.body);
  const receipt = await prisma.deliveryReceipt.findUnique({ where:{ id:req.params.receiptId }, include:{ task:{ include:{ quote:true, confirmation:true } } } });
  if (!receipt || receipt.expiresAt <= new Date() || receipt.tokenHash !== tokenHash(body.token)) return res.status(404).json({ error:'delivery receipt invalid or expired' });
  if (!receipt.downloadedAt) return res.status(409).json({ error:'deliverable must be downloaded before acceptance' });
  if (receipt.task.confirmation) return res.status(409).json({ error:'customer acceptance already recorded' });
  const result = await prisma.$transaction(async tx => {
    const confirmation = await tx.customerConfirmation.create({ data:{ taskId:receipt.taskId, method:'delivery-token', evidence:{ receiptId:receipt.id, artifactId:receipt.artifactId, accepted:true, note:body.note ?? null, acceptedAt:new Date().toISOString() } } });
    await tx.deliveryReceipt.update({ where:{ id:receipt.id }, data:{ acceptedAt:new Date() } });
    await tx.task.update({ where:{ id:receipt.taskId }, data:{ status:'CUSTOMER_ACCEPTED' } });
    await postBalancedGroup(tx, { idempotencyKey:`earning:${receipt.taskId}`, kind:'REVENUE_RECOGNITION', currency:receipt.task.quote.currency, evidenceType:'customer_acceptance', evidenceId:confirmation.id, lines:[{ account:'CUSTOMER_PREPAID', amountCents:receipt.task.quote.amountCents }, { account:'REVENUE', amountCents:-receipt.task.quote.amountCents }] });
    await tx.earning.upsert({ where:{ taskId:receipt.taskId }, create:{ taskId:receipt.taskId, customerId:receipt.task.customerId, amountCents:receipt.task.quote.amountCents, currency:receipt.task.quote.currency, status:'EARNED', evidence:{ confirmationId:confirmation.id, receiptId:receipt.id, quoteId:receipt.task.quoteId } }, update:{ status:'EARNED', evidence:{ confirmationId:confirmation.id, receiptId:receipt.id, quoteId:receipt.task.quoteId } } });
    await tx.task.update({ where:{ id:receipt.taskId }, data:{ status:'EARNED' } });
    await tx.auditEvent.create({ data:{ agent:'customer-acceptance', action:'CUSTOMER_ACCEPTED_DELIVERABLE', taskId:receipt.taskId, result:'SUCCESS', correlationId:receipt.id, evidence:{ confirmationId:confirmation.id, artifactId:receipt.artifactId } } });
    return confirmation;
  });
  res.json({ taskId:receipt.taskId, status:'EARNED', accepted:true, confirmationId:result.id });
}));

router.get('/:taskId', asyncRoute(async (req,res) => {
  const task = await prisma.task.findUnique({ where:{ id:req.params.taskId }, include:{ quote:true, artifacts:true, validations:true, executions:true, earning:true } });
  if (!task) return res.status(404).json({ error:'task not found' });
  // In production, enforce customer/owner authentication and do not expose storagePath.
  const { artifacts, ...rest } = task;
  res.json({ ...rest, artifacts:artifacts.map(({ storagePath, ...a }) => a) });
}));
export default router;
