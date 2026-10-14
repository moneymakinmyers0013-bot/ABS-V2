import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.string().default('development'), PORT: z.coerce.number().int().positive().default(8080),
  APP_BASE_URL: z.string().url().default('http://localhost:8080'),
  AGENT_DISCOVERY_FEEDS: z.string().default('[]'),
  DISCOVERY_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(86400).default(300),
  AGENT_AUTO_CLAIM_ENABLED: z.string().default('false'),
  DATABASE_URL: z.string().min(1), REDIS_URL: z.string().min(1),
  PAYPAL_MODE: z.enum(['sandbox','live']).default('sandbox'), PAYPAL_CLIENT_ID: z.string().optional(),
  X402_ENABLED: z.string().default('false'), X402_PAY_TO: z.string().optional(),
  X402_FACILITATOR_URL: z.string().url().default('https://x402.org/facilitator'), X402_PRICE: z.string().default('$1.00'),
  PAYPAL_CLIENT_SECRET: z.string().optional(), PAYPAL_WEBHOOK_ID: z.string().optional(),
  PAYPAL_API_BASE: z.string().url().default('https://api-m.sandbox.paypal.com'),
  APP_ENV: z.string().default('development'), PRODUCTION_FINANCIAL_OPERATIONS_ENABLED: z.string().default('false'),
  // Owner-attested operational gates; all fail closed by default. These are not provider verification.
  ABS_PAYOUT_RELEASE_GATE_PASSED: z.string().default('false'),
  PAYPAL_BANK_DESTINATION_VERIFIED: z.string().default('false'),
  PAYPAL_AUTO_TRANSFERS_CONFIGURED: z.string().default('false'),
  ABS_ADMIN_TOKEN: z.string().min(16), AUTHORIZATION_HMAC_SECRET: z.string().optional()
});
export const env = schema.parse(process.env);
export function assertLiveAllowed() {
  if (env.PAYPAL_MODE === 'live' && !(env.APP_ENV === 'production' && env.PRODUCTION_FINANCIAL_OPERATIONS_ENABLED === 'true' && env.ABS_PAYOUT_RELEASE_GATE_PASSED === 'true' && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_WEBHOOK_ID)) {
    throw new Error('Live payments are fail-closed: production environment, explicit enable flag, passed release-gate attestation, credentials and webhook ID are all required.');
  }
}
