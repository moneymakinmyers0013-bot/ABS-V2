import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('live financial operations default to disabled', () => {
  const env = read('.env.example');
  const config = read('src/lib/config.ts');
  assert.match(env, /^PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false$/m);
  assert.match(config, /env\.APP_ENV === 'production'/);
  assert.match(config, /env\.PRODUCTION_FINANCIAL_OPERATIONS_ENABLED === 'true'/);
});

test('only implemented task types can be quoted', () => {
  const routes = read('src/routes/tasks.ts');
  const executor = read('src/services/executor.ts');
  assert.match(routes, /z\.enum\(\['csv_cleanup','data_normalization','duplicate_removal','data_transformation','categorization'\]\)/);
  assert.match(executor, /refusing to create a false-positive deliverable/);
});

test('capture is verified against provider state and cannot authorize a second payment', () => {
  const paypal = read('src/services/paypal.ts');
  const routes = read('src/routes/tasks.ts');
  assert.match(paypal, /existing\?\.status === 'COMPLETED'/);
  assert.match(paypal, /capture\.status !== 'COMPLETED' \|\| amountCents !== expectedCents \|\| currency !== expectedCurrency/);
  assert.match(routes, /task or quote is no longer awaiting payment/);
  assert.match(routes, /a payment order already exists for this quote/);
});

test('delivery rehashes output and acceptance requires a downloaded artifact', () => {
  const routes = read('src/routes/tasks.ts');
  assert.match(routes, /output artifact hash mismatch; delivery blocked/);
  assert.match(routes, /artifact integrity check failed/);
  assert.match(routes, /deliverable must be downloaded before acceptance/);
  assert.match(routes, /CUSTOMER_ACCEPTED_DELIVERABLE/);
});

test('payouts are limited to cash-backed earned revenue and reconciled provider details', () => {
  const ledger = read('src/services/ledger.ts');
  const payouts = read('src/routes/payouts.ts');
  const tasks = read('src/routes/tasks.ts');
  assert.match(tasks, /kind:'REVENUE_RECOGNITION'/);
  assert.match(ledger, /account:'PROVIDER_CASH'/);
  assert.match(ledger, /account:'REVENUE'/);
  assert.match(ledger, /account:'OWNER_DISTRIBUTION'/);
  assert.match(payouts, /providerAmount/);
  assert.match(payouts, /providerCurrency/);
  assert.match(payouts, /providerReceiver\.toLowerCase\(\) === payout\.destination\.receiver\.toLowerCase\(\)/);
  assert.match(payouts, /itemStatus === 'SUCCESS' && itemMatches/);
  assert.match(payouts, /isolationLevel:'Serializable'/);
});

test('manual sandbox runner requires provider approval and confirmed PAID status', () => {
  const script = read('scripts/sandbox-lifecycle.ts');
  assert.match(script, /Approve the order using your PayPal SANDBOX buyer account/);
  assert.match(script, /Confirm you intentionally authorize this SANDBOX payout/);
  assert.match(script, /reconciled\?\.status !== 'PAID'/);
  assert.match(script, /SANDBOX LIFECYCLE PASS/);
});

test('execution queue intent is durable and republished from the outbox', () => {
  const executor = read('src/services/executor.ts');
  const worker = read('src/workers/worker.ts');
  assert.match(executor, /outboxEvent\.upsert/);
  assert.match(executor, /publishedAt:null/);
  assert.match(executor, /jobId:`execute-\$\{payload\.taskId\}`/);
  assert.match(worker, /drainOutbox\(\)/);
});

test('minor-unit assumptions are explicitly limited to USD', () => {
  const tasks = read('src/routes/tasks.ts');
  const payouts = read('src/routes/payouts.ts');
  assert.match(tasks, /currency:z\.literal\('USD'\)\.default\('USD'\)/);
  assert.match(payouts, /currency:z\.literal\('USD'\)\.default\('USD'\)/);
});

test('agent catalog advertises only implemented tasks at fixed one-dollar USD pricing', () => {
  const catalog = read('src/services/agent-catalog.ts');
  const routes = read('src/routes/agent.ts');
  assert.match(catalog, /priceCents: 100/g);
  assert.match(catalog, /executeOnlyAfterProviderConfirmedPayment: true/);
  assert.match(routes, /amountCents: 100/);
  assert.match(routes, /Provider-confirmed matching capture is required before execution/);
  assert.match(routes, /rate limit exceeded/);
});

test('agent sales API uses idempotency and bounded task inputs', () => {
  const routes = read('src/routes/agent.ts');
  assert.match(routes, /idempotencyKey: z\.string\(\)\.min\(16\)\.max\(128\)/);
  assert.match(routes, /body\.idempotencyKey/);
  assert.match(routes, /input\.rows\.length > 10000/);
  assert.match(routes, /statusCode: 409/);
});

test('discovery is HTTPS allowlisted, rejects private destinations, and never auto-claims leads', () => {
  const discovery = read('src/services/discovery.ts');
  const worker = read('src/workers/discovery.ts');
  const admin = read('src/routes/discovery.ts');
  assert.match(discovery, /u\.protocol !== 'https:'/);
  assert.match(discovery, /u\.hostname\.toLowerCase\(\) !== x\.allowedHost\.toLowerCase\(\)/);
  assert.match(discovery, /resolves to a private or invalid address/);
  assert.match(discovery, /QUALIFIED_REVIEW_REQUIRED/);
  assert.doesNotMatch(discovery, /fetch\(.*claimUrl/);
  assert.match(admin, /source-specific provider adapter must verify funding/);
  assert.match(worker, /DISCOVERY_INTERVAL_SECONDS/);
  assert.match(worker, /redis\.set\(lockKey, owner/);
  assert.match(worker, /redis\.eval\(/);
  assert.match(worker, /redis\.call\('get', KEYS\[1\]\).*redis\.call\('del', KEYS\[1\]\)/s);
  assert.doesNotMatch(worker, /const current = await redis\.get\(lockKey\); if \(current === owner\) await redis\.del\(lockKey\)/);
});

test('agent discovery route is admin protected and lead review is audited', () => {
  const routes = read('src/routes/discovery.ts');
  assert.match(routes, /router\.use\(requireAdmin\)/);
  assert.match(routes, /MARKET_LEAD_REJECTED/);
  assert.match(routes, /MARKET_LEAD_REVIEWED/);
});

test('agent idempotency uses a unique durable database record and canonical request hash', () => {
  const routes = read('src/routes/agent.ts');
  const schema = read('prisma/schema.prisma');
  assert.match(routes, /prisma\.agentRequest\.findUnique/);
  assert.match(routes, /requestHash/);
  assert.match(routes, /Concurrent retries race on the database unique constraint/);
  assert.match(schema, /idempotencyKey String @unique/);
  assert.match(schema, /taskId String @unique/);
});


test('mobile PayPal bank configuration page never collects PayPal or bank credentials', () => {
  const server = read('src/server.ts');
  const route = read('src/routes/admin-config.ts');
  assert.match(server, /\/admin\/paypal-bank/);
  assert.match(server, /\/admin\/config/);
  assert.match(server, /requireOwnerPage/);
  assert.doesNotMatch(server, /id=\"adminToken\"/);
  assert.match(read('src/lib/http.ts'), /WWW-Authenticate/);
  assert.match(read('src/lib/http.ts'), /Basic realm=\"ABS v2 Owner Administration\"/);
  assert.match(server, /cache:'no-store'/);
  assert.match(route, /requireAdmin/);
  assert.match(route, /res\.json\(\{/);
  assert.match(route, /absInitiatedBankPayoutsEnabled: false/);
  assert.match(server, /requireOwnerPage/);
  assert.match(read('src/lib/http.ts'), /Basic realm=\"ABS v2 Owner Administration\"/);
  assert.match(route, /never returns secrets/i);
});

test('live payments require explicit release-gate attestation and remain disabled by default', () => {
  const env = read('.env.example');
  const config = read('src/lib/config.ts');
  const route = read('src/routes/admin-config.ts');
  assert.match(env, /^ABS_PAYOUT_RELEASE_GATE_PASSED=false$/m);
  assert.match(config, /env\.ABS_PAYOUT_RELEASE_GATE_PASSED === 'true'/);
  assert.match(route, /livePayoutsEnabled: false/);
  assert.match(route, /owner’s PayPal balance directly to their bank/);
});

test('x402 Base payment route is disabled by default and fails closed without ledger reconciliation readiness', () => {
  const env = read('.env.example');
  const config = read('src/lib/config.ts');
  const route = read('src/routes/x402.ts');
  const server = read('src/server.ts');
  assert.match(env, /^X402_ENABLED=false$/m);
  assert.match(env, /^X402_LEDGER_RECONCILIATION_READY=false$/m);
  assert.match(config, /X402_ENABLED: z\.string\(\)\.default\('false'\)/);
  assert.match(route, /X402_ENABLED !== 'true'/);
  assert.match(route, /X402_LEDGER_RECONCILIATION_READY !== 'true'/);
  assert.match(route, /eip155:8453/);
  assert.match(route, /paymentFlow: 'upfront'/);
  assert.match(server, /mountX402Routes\(app\)/);
  assert.doesNotMatch(route, /export default router/);
});

test('x402 route rejects invalid receiving addresses and production use of the public development facilitator', () => {
  const route = read('src/routes/x402.ts');
  assert.match(route, /\^0x\[a-fA-F0-9\]\{40\}\$/);
  assert.match(route, /production facilitator/);
  assert.match(route, /no wallet private key is needed on the server/i);
  assert.match(route, /settlement receipts are persisted and reconciled/);
});
