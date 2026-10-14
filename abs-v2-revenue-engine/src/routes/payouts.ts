import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { asyncRoute, requireAdmin } from '../lib/http';
import { availablePayoutFundsFrom, postBalancedGroup } from '../services/ledger';
import { PayPalClient, sha256 } from '../services/paypal';
const paypal = new PayPalClient();
const router = Router();
const schema = z.object({ destinationId:z.string().uuid(), amountCents:z.number().int().positive().max(50000), currency:z.literal('USD').default('USD'), purpose:z.string().min(3).max(200), idempotencyKey:z.string().min(12).max(128), ownerAuthorization:z.object({ authorizationId:z.string().min(1), approvedByOwner:z.boolean(), approvedAt:z.string().datetime() }) });
router.post('/', requireAdmin, asyncRoute(async (req,res) => {
  const body = schema.parse(req.body);
  if (body.ownerAuthorization.approvedByOwner !== true) return res.status(403).json({ error:'explicit owner authorization required' });
  const destination = await prisma.destination.findUnique({ where:{ id:body.destinationId } });
  if (!destination || !destination.active || !destination.verifiedByOwnerAt) return res.status(409).json({ error:'destination must be active and owner-verified' });
  if (destination.currency !== body.currency.toUpperCase()) return res.status(409).json({ error:'destination currency mismatch' });
  const payout = await prisma.$transaction(async tx => {
    const duplicate = await tx.payoutRequest.findUnique({ where:{ idempotencyKey:body.idempotencyKey } });
    if (duplicate) {
      if (duplicate.destinationId !== destination.id || duplicate.amountCents !== body.amountCents || duplicate.currency !== body.currency.toUpperCase()) throw Object.assign(new Error('Idempotency key was already used with different payout parameters'), { statusCode:409 });
      return duplicate;
    }
    const available = await availablePayoutFundsFrom(tx, body.currency.toUpperCase());
    if (available < body.amountCents) throw Object.assign(new Error(`Insufficient earned and unreconciled payout funds; availableCents=${available}`), { statusCode:409 });
    const created = await tx.payoutRequest.create({ data:{ destinationId:destination.id, amountCents:body.amountCents, currency:body.currency.toUpperCase(), purpose:body.purpose, status:'AUTHORIZED', idempotencyKey:body.idempotencyKey, authorization:{ authorizationId:body.ownerAuthorization.authorizationId, approvedByOwner:true, approvedAt:body.ownerAuthorization.approvedAt } } });
    await tx.reservation.create({ data:{ payoutId:created.id, amountCents:created.amountCents, status:'HELD' } });
    await tx.auditEvent.create({ data:{ agent:'api', action:'PAYOUT_AUTHORIZED', authorizationId:body.ownerAuthorization.authorizationId, provider:destination.provider, result:'AUTHORIZED', correlationId:created.id, evidence:{ payoutId:created.id, amountCents:created.amountCents, currency:created.currency, destinationId:destination.id } } });
    return created;
  }, { isolationLevel:'Serializable' });
  // This endpoint only reserves funds. A separate provider adapter must submit and reconcile it.
  res.status(201).json({ payoutId:payout.id, status:payout.status, amountCents:payout.amountCents, currency:payout.currency, message:'Authorized and reserved; not yet submitted or paid.' });
}));
router.post('/:payoutId/submit', requireAdmin, asyncRoute(async (req,res) => {
  const payout = await prisma.payoutRequest.findUnique({ where:{ id:req.params.payoutId }, include:{ destination:true, reservation:true } });
  if (!payout) return res.status(404).json({ error:'payout not found' });
  if (payout.status !== 'AUTHORIZED' || payout.reservation?.status !== 'HELD') return res.status(409).json({ error:'payout must be authorized with held reservation and not previously submitted' });
  if (payout.destination.provider.toLowerCase() !== 'paypal' || payout.destination.recipientType !== 'EMAIL') return res.status(400).json({ error:'current provider adapter supports PayPal email recipients only' });
  // A live submission requires all configured live gates; the provider adapter enforces this too.
  try {
    const result = await paypal.submitPayout({ receiver:payout.destination.receiver, amountCents:payout.amountCents, currency:payout.currency, idempotencyKey:payout.idempotencyKey, note:payout.purpose });
    await prisma.$transaction(async tx => {
      await tx.payoutRequest.update({ where:{ id:payout.id }, data:{ status:'PROVIDER_PENDING', providerBatchId:result.batchId, attempts:{ increment:1 }, lastError:null } });
      await tx.providerSnapshot.create({ data:{ subjectType:'payout_batch', subjectId:result.batchId, provider:'paypal', payloadHash:sha256(result.raw), payload:result.raw } });
      await tx.auditEvent.create({ data:{ agent:'payout-service', action:'PAYOUT_SUBMITTED', authorizationId:(payout.authorization as any)?.authorizationId, provider:'paypal', result:'PROVIDER_PENDING', correlationId:payout.id, evidence:{ batchId:result.batchId, providerStatus:result.batchStatus } } });
    });
    return res.status(202).json({ payoutId:payout.id, status:'PROVIDER_PENDING', providerBatchId:result.batchId, providerStatus:result.batchStatus });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown provider submission outcome';
    // A timeout/uncertain result stays reserved and is not resubmitted automatically.
    await prisma.payoutRequest.update({ where:{ id:payout.id }, data:{ status:'UNKNOWN', attempts:{ increment:1 }, lastError:message } });
    return res.status(202).json({ payoutId:payout.id, status:'UNKNOWN', message:'Submission outcome is uncertain; reconcile with provider before any retry.' });
  }
}));
router.post('/:payoutId/reconcile', requireAdmin, asyncRoute(async (req,res) => {
  const payout = await prisma.payoutRequest.findUnique({ where:{ id:req.params.payoutId }, include:{ reservation:true, destination:true } });
  if (!payout) return res.status(404).json({ error:'payout not found' });
  if (!payout.providerBatchId) return res.status(409).json({ error:'no provider batch ID; manual provider search required before retry' });
  const provider = await paypal.getPayoutBatch(payout.providerBatchId);
  const batchStatus = String(provider.batch_header?.batch_status ?? 'UNKNOWN');
  const items = provider.items ?? [];
  const item = items.find((x:any) => x.payout_item?.sender_item_id === payout.idempotencyKey.slice(0,30));
  const itemStatus = String(item?.transaction_status ?? 'UNKNOWN');
  const providerAmount = Number(item?.payout_item?.amount?.value);
  const providerCurrency = String(item?.payout_item?.amount?.currency ?? item?.payout_item?.amount?.currency_code ?? '');
  const providerReceiver = String(item?.payout_item?.receiver ?? '');
  const batchSenderId = String(provider.batch_header?.sender_batch_header?.sender_batch_id ?? '');
  const expectedSenderId = payout.idempotencyKey.slice(0,30);
  const itemMatches = Boolean(item) && Number.isFinite(providerAmount) && Math.round(providerAmount * 100) === payout.amountCents && providerCurrency === payout.currency && providerReceiver.toLowerCase() === payout.destination.receiver.toLowerCase() && batchSenderId === expectedSenderId;
  let status: 'PAID'|'PAYOUT_FAILED'|'PROVIDER_PENDING'|'RECONCILIATION_REQUIRED' = 'RECONCILIATION_REQUIRED';
  if (itemStatus === 'SUCCESS' && itemMatches) status = 'PAID';
  else if (itemStatus === 'SUCCESS' && !itemMatches) status = 'RECONCILIATION_REQUIRED';
  else if (['FAILED','BLOCKED','DENIED','RETURNED','REFUNDED','CANCELED'].includes(itemStatus) && itemMatches) status = 'PAYOUT_FAILED';
  else if (['PENDING','PROCESSING','ONHOLD','UNCLAIMED'].includes(itemStatus) || ['PENDING','PROCESSING'].includes(batchStatus)) status = 'PROVIDER_PENDING';
  await prisma.$transaction(async tx => {
    await tx.payoutRequest.update({ where:{ id:payout.id }, data:{ status, paidAt:status==='PAID' ? new Date() : undefined, providerItemId:item?.payout_item_id ?? undefined, lastError:status==='RECONCILIATION_REQUIRED' ? `Unresolved provider state batch=${batchStatus}, item=${itemStatus}` : null } });
    if (status === 'PAID') {
      await tx.reservation.updateMany({ where:{ payoutId:payout.id, status:'HELD' }, data:{ status:'SETTLED' } });
      await postBalancedGroup(tx, { idempotencyKey:`payout-paid:${payout.id}`, kind:'PAYOUT_SETTLEMENT', currency:payout.currency, evidenceType:'provider_payout_batch', evidenceId:payout.providerBatchId!, lines:[{ account:'PROVIDER_CASH', amountCents:-payout.amountCents }, { account:'OWNER_DISTRIBUTION', amountCents:payout.amountCents }] });
    }
    if (status === 'PAYOUT_FAILED') await tx.reservation.updateMany({ where:{ payoutId:payout.id, status:'HELD' }, data:{ status:'RELEASED' } });
    await tx.providerSnapshot.create({ data:{ subjectType:'payout_batch', subjectId:payout.providerBatchId!, provider:'paypal', payloadHash:sha256(provider), payload:provider } });
    await tx.reconciliationRecord.create({ data:{ subjectType:'payout', subjectId:payout.id, outcome:status==='PAID' ? 'MATCH' : status==='PAYOUT_FAILED' ? 'MISMATCH' : 'MISMATCH', details:{ batchStatus, itemStatus, providerBatchId:payout.providerBatchId, derivedStatus:status, itemMatches, providerAmount, providerCurrency, providerReceiver, batchSenderId, expectedSenderId } } });
    await tx.auditEvent.create({ data:{ agent:'payout-reconciler', action:'PAYOUT_RECONCILED', provider:'paypal', result:status, correlationId:payout.id, evidence:{ batchStatus, itemStatus, providerBatchId:payout.providerBatchId, itemMatches, providerAmount, providerCurrency, providerReceiver, batchSenderId } } });
  });
  res.json({ payoutId:payout.id, status, providerBatchStatus:batchStatus, providerItemStatus:itemStatus, itemMatches });
}));
router.get('/:payoutId', requireAdmin, asyncRoute(async (req,res) => {
  const payout = await prisma.payoutRequest.findUnique({ where:{ id:req.params.payoutId }, include:{ reservation:true, destination:{ select:{ id:true, provider:true, recipientType:true, currency:true, active:true, verifiedByOwnerAt:true } } } });
  if (!payout) return res.status(404).json({ error:'payout not found' });
  res.json(payout);
}));
export default router;
