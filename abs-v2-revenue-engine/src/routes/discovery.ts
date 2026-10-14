import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db';
import { asyncRoute, requireAdmin } from '../lib/http';
const router = Router();
router.use(requireAdmin);
router.get('/leads', asyncRoute(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const take = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const leads = await prisma.marketLead.findMany({ where: status ? { status } : {}, orderBy: [{ rewardCents: 'desc' }, { discoveredAt: 'desc' }], take });
  res.json({ count: leads.length, leads });
}));
router.post('/leads/:id/reject', asyncRoute(async (req, res) => {
  const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
  const lead = await prisma.marketLead.update({ where: { id: req.params.id }, data: { status: 'REJECTED', rejectionReason: body.reason } });
  await prisma.auditEvent.create({ data: { agent: 'admin', action: 'MARKET_LEAD_REJECTED', result: 'SUCCESS', correlationId: lead.id, evidence: { reason: body.reason, sourceKey: lead.sourceKey, externalId: lead.externalId } } });
  res.json({ id: lead.id, status: lead.status });
}));
router.post('/leads/:id/mark-reviewed', asyncRoute(async (req, res) => {
  const body = z.object({ decision: z.enum(['REVIEWED_NOT_FUNDED', 'AWAITING_PROVIDER_ADAPTER', 'NOT_A_FIT']) }).parse(req.body);
  const lead = await prisma.marketLead.update({ where: { id: req.params.id }, data: { status: body.decision } });
  await prisma.auditEvent.create({ data: { agent: 'admin', action: 'MARKET_LEAD_REVIEWED', result: 'SUCCESS', correlationId: lead.id, evidence: { decision: body.decision, sourceKey: lead.sourceKey, externalId: lead.externalId } } });
  res.json({ id: lead.id, status: lead.status, note: 'Review does not authorize claiming, execution, or spending. A source-specific provider adapter must verify funding and contract terms first.' });
}));
export default router;
