import { z } from 'zod';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { env } from '../lib/config';

const rowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(10000),
}).strict();

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(k => `${JSON.stringify(k)}:${stable(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// This route is intentionally not mounted unless the operator explicitly enables it.
// Do not enable until settlement evidence is durably recorded and reconciled in the ledger.
export function mountX402Routes(app: import('express').Express): void {
  if (env.X402_ENABLED !== 'true') return;
  if (process.env.X402_LEDGER_RECONCILIATION_READY !== 'true') {
    throw new Error('x402 route is blocked: durable settlement receipt storage and ledger reconciliation are not implemented/verified.');
  }
  if (!env.X402_PAY_TO || !/^0x[a-fA-F0-9]{40}$/.test(env.X402_PAY_TO)) {
    throw new Error('X402_ENABLED requires a valid X402_PAY_TO EVM address; no wallet private key is needed on the server.');
  }
  // Public x402.org facilitator is for development/test workflows; production must use a
  // production facilitator that explicitly supports Base mainnet.
  if (env.APP_ENV === 'production' && env.X402_FACILITATOR_URL.includes('x402.org')) {
    throw new Error('Production x402 is blocked from using the public x402.org development facilitator. Configure a production facilitator.');
  }
  const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });
  const server = new x402ResourceServer(facilitator);
  server.register('eip155:8453', new ExactEvmScheme());

  app.use(paymentMiddleware({
    'POST /agent/v1/x402/cleanup': {
      accepts: {
        scheme: 'exact',
        price: env.X402_PRICE,
        network: 'eip155:8453',
        payTo: env.X402_PAY_TO,
        extra: { paymentFlow: 'upfront', name: 'USDC', version: '2' },
      },
      description: 'Deterministic CSV-row cleanup: trim column names and string values, remove exact duplicate rows, and return a QA summary.',
      mimeType: 'application/json',
    },
  }, server));

  app.post('/agent/v1/x402/cleanup', (req, res) => {
    const parsed = rowsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Expected JSON body { rows: object[] } with 1–10000 rows.' });
    const originalRows = parsed.data.rows;
    for (const row of originalRows) {
      const keys = Object.keys(row).map(k => k.trim());
      if (keys.some(k => !k) || new Set(keys).size !== keys.length) {
        return res.status(400).json({ error: 'Column names must remain unique after trimming; ambiguous input was not changed.' });
      }
    }
    const cleaned = originalRows.map(row => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) out[key.trim()] = typeof value === 'string' ? value.trim() : value;
      return out;
    });
    const seen = new Set<string>();
    const output = cleaned.filter(row => {
      const fingerprint = stable(row);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
    return res.json({
      service: 'ABS V2 Data Cleanup',
      status: 'completed',
      output: output,
      qa: {
        inputRows: originalRows.length,
        outputRows: output.length,
        exactDuplicatesRemoved: originalRows.length - output.length,
        columnNamesTrimmed: originalRows.some(row => Object.keys(row).some(k => k !== k.trim())),
        stringValuesTrimmed: originalRows.some(row => Object.values(row).some(v => typeof v === 'string' && v !== v.trim())),
      },
      note: 'This endpoint must remain disabled until x402 settlement receipts are persisted and reconciled to the ABS ledger. A successful HTTP response alone is not accounting evidence.',
    });
  });
}

