import { randomUUID } from 'node:crypto';
import { LedgerAccount, Prisma } from '@prisma/client';
import { prisma } from '../lib/db';

type Line = { account: LedgerAccount; amountCents: number };
export async function postBalancedGroup(tx: Prisma.TransactionClient, input: { idempotencyKey: string; kind: string; currency: string; evidenceType: string; evidenceId: string; lines: Line[] }) {
  if (input.lines.length < 2 || input.lines.some(x => !Number.isSafeInteger(x.amountCents))) throw new Error('Ledger group requires at least two integer-cent lines');
  if (input.lines.reduce((s,x) => s + x.amountCents, 0) !== 0) throw new Error('Unbalanced ledger group rejected');
  if (input.lines.some(x => x.amountCents === 0)) throw new Error('Zero-value ledger lines are not allowed');
  const existing = await tx.ledgerEntry.findMany({ where:{ idempotencyKey:input.idempotencyKey } });
  if (existing.length) {
    if (existing.length !== input.lines.length || existing.reduce((s,x)=>s+x.amountCents,0)!==0) throw new Error('Idempotency collision: existing ledger group differs');
    return existing;
  }
  const groupId = randomUUID();
  const rows = input.lines.map(line => ({ groupId, idempotencyKey:input.idempotencyKey, kind:input.kind, account:line.account, amountCents:line.amountCents, currency:input.currency, evidenceType:input.evidenceType, evidenceId:input.evidenceId }));
  return tx.ledgerEntry.createMany({ data:rows }).then(async () => tx.ledgerEntry.findMany({ where:{ groupId } }));
}
export async function availablePayoutFundsFrom(tx: Prisma.TransactionClient, currency = 'USD') {
  const [cash, revenue, distributions, reserved] = await Promise.all([
    tx.ledgerEntry.aggregate({ where:{ account:'PROVIDER_CASH', currency }, _sum:{ amountCents:true } }),
    tx.ledgerEntry.aggregate({ where:{ account:'REVENUE', currency }, _sum:{ amountCents:true } }),
    tx.ledgerEntry.aggregate({ where:{ account:'OWNER_DISTRIBUTION', currency }, _sum:{ amountCents:true } }),
    tx.reservation.aggregate({ where:{ status:'HELD', payout:{ currency } }, _sum:{ amountCents:true } })
  ]);
  // Revenue is credited as a negative amount; owner distributions are debits (positive).
  const earnedAndUnpaid = Math.max(0, -(revenue._sum.amountCents ?? 0) - (distributions._sum.amountCents ?? 0));
  const providerCash = Math.max(0, cash._sum.amountCents ?? 0);
  return Math.max(0, Math.min(providerCash, earnedAndUnpaid) - (reserved._sum.amountCents ?? 0));
}
export async function availablePayoutFunds(currency = 'USD') {
  return prisma.$transaction(tx => availablePayoutFundsFrom(tx, currency));
}
