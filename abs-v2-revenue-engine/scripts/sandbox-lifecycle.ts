import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const base = process.env.APP_BASE_URL ?? 'http://localhost:8080';
const adminToken = process.env.ABS_ADMIN_TOKEN;
const destinationId = process.env.SANDBOX_DESTINATION_ID;
const approvalId = process.env.SANDBOX_OWNER_APPROVAL_ID;
const amountCents = Number(process.env.SANDBOX_AMOUNT_CENTS ?? 500);
const currency = process.env.SANDBOX_CURRENCY ?? 'USD';
if (!adminToken || adminToken.length < 16) throw new Error('ABS_ADMIN_TOKEN must be configured in local .env');
if (!destinationId || !approvalId) throw new Error('Set SANDBOX_DESTINATION_ID and SANDBOX_OWNER_APPROVAL_ID only after verifying the sandbox payout destination and explicitly approving this test payout.');
if (process.env.PAYPAL_MODE !== 'sandbox' || process.env.PRODUCTION_FINANCIAL_OPERATIONS_ENABLED !== 'false') throw new Error('This test runner is sandbox-only. Set PAYPAL_MODE=sandbox and PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false.');
const headers = { 'content-type':'application/json', authorization:`Bearer ${adminToken}` };
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, base), { ...init, headers:{ ...headers, ...(init.headers as Record<string,string> | undefined) } });
  const raw = await response.text();
  let body: any;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}
const pause = async (message: string) => { const rl = readline.createInterface({ input, output }); await rl.question(`${message}\nPress Enter when complete...`); rl.close(); };
const sleep = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));

async function main() {
  const health = await request('/health', { headers:{} });
  if (health.status !== 'ok' || health.database !== 'ok' || health.redis !== 'ok' || health.mode !== 'sandbox') throw new Error(`Health gate failed: ${JSON.stringify(health)}`);
  console.log('PASS health: PostgreSQL, Redis and PayPal sandbox mode');
  const task = await request('/tasks', { method:'POST', body:JSON.stringify({ customerEmail:`abs-sandbox-${Date.now()}@example.invalid`, source:'sandbox-lifecycle-test', taskType:'csv_cleanup', input:{ rows:[{ name:' Ada   Lovelace ', email:' ada@example.test ' },{ name:'Grace Hopper', email:'grace@example.test'}] }, amountCents, currency, pricingVersion:'sandbox-test-v1' }) });
  console.log(`Created task ${task.taskId}; quote ${task.quote.id} for ${task.quote.amountCents} ${task.quote.currency}`);
  const order = await request(`/tasks/${task.taskId}/payment-order`, { method:'POST', body:'{}' });
  const approvalUrl = order.links?.find((x:any) => x.rel === 'approve' || x.rel === 'payer-action')?.href;
  if (!approvalUrl) throw new Error(`PayPal approval link missing: ${JSON.stringify(order.links)}`);
  console.log(`Open this PayPal SANDBOX buyer approval URL in a browser:\n${approvalUrl}`);
  await pause('Approve the order using your PayPal SANDBOX buyer account. Do not use a real buyer account.');
  const capture = await request(`/tasks/${task.taskId}/capture`, { method:'POST', body:'{}' });
  if (capture.verified !== true || !capture.providerCaptureId) throw new Error(`Capture verification failed: ${JSON.stringify(capture)}`);
  console.log(`PASS provider capture: ${capture.providerCaptureId}`);
  await request(`/tasks/${task.taskId}/run`, { method:'POST', body:'{}' });
  let status:any;
  for (let i=0;i<60;i++) { status = await request(`/tasks/${task.taskId}`, { headers:{} }); if (['DELIVERABLE_SUBMITTED','FAILED'].includes(status.status)) break; await sleep(1000); }
  if (status?.status !== 'DELIVERABLE_SUBMITTED') throw new Error(`Execution/validation failed or timed out: ${JSON.stringify({status:status?.status, failureReason:status?.failureReason})}`);
  const outputArtifact = status.artifacts?.find((a:any) => a.kind === 'OUTPUT');
  const validation = status.validations?.at(-1);
  if (!outputArtifact?.sha256 || validation?.passed !== true) throw new Error('Output artifact or passing validation evidence missing');
  console.log(`PASS execution and validation: sha256=${outputArtifact.sha256}`);
  const delivery = await request(`/tasks/${task.taskId}/deliver`, { method:'POST', body:'{}' });
  const url = new URL(delivery.deliveryUrl, base);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('Delivery token missing from one-time URL');
  const downloaded = await fetch(url);
  if (!downloaded.ok) throw new Error(`Download failed (${downloaded.status})`);
  const deliveredBytes = Buffer.from(await downloaded.arrayBuffer());
  const hash = await import('node:crypto').then(m => m.createHash('sha256').update(deliveredBytes).digest('hex'));
  if (hash !== outputArtifact.sha256) throw new Error('Downloaded delivery hash differs from validated artifact hash');
  const outputJson = JSON.parse(deliveredBytes.toString('utf8'));
  if (!Array.isArray(outputJson) || outputJson[0]?.name !== 'Ada Lovelace') throw new Error('Delivered output content check failed');
  console.log('PASS delivery: downloaded bytes hash-match the validated output');
  const accepted = await request(delivery.acceptanceUrl, { method:'POST', body:JSON.stringify({ token, accepted:true, note:'Sandbox lifecycle acceptance test' }) });
  if (accepted.status !== 'EARNED' || accepted.accepted !== true) throw new Error(`Customer acceptance failed: ${JSON.stringify(accepted)}`);
  console.log(`PASS customer acceptance: ${accepted.confirmationId}`);

  const payout = await request('/payouts', { method:'POST', body:JSON.stringify({ destinationId, amountCents, currency, purpose:'ABS sandbox lifecycle test payout', idempotencyKey:`abs-sandbox-${task.taskId}`, ownerAuthorization:{ authorizationId:approvalId, approvedByOwner:true, approvedAt:new Date().toISOString() } }) });
  console.log(`Payout reserved: ${payout.payoutId}. Review the destination and test amount before continuing.`);
  await pause('Confirm you intentionally authorize this SANDBOX payout to the owner-verified sandbox destination.');
  const submitted = await request(`/payouts/${payout.payoutId}/submit`, { method:'POST', body:'{}' });
  if (!submitted.providerBatchId) throw new Error(`Payout submission did not return a provider batch ID: ${JSON.stringify(submitted)}`);
  console.log(`PASS payout submission: provider batch ${submitted.providerBatchId}`);
  let reconciled:any;
  for (let i=0;i<12;i++) {
    reconciled = await request(`/payouts/${payout.payoutId}/reconcile`, { method:'POST', body:'{}' });
    if (['PAID','PAYOUT_FAILED','RECONCILIATION_REQUIRED'].includes(reconciled.status)) break;
    await sleep(5000);
  }
  if (reconciled?.status !== 'PAID') throw new Error(`Provider settlement not confirmed; do not report success: ${JSON.stringify(reconciled)}`);
  console.log(`PASS provider-confirmed payout settlement: ${JSON.stringify(reconciled)}`);
  console.log('SANDBOX LIFECYCLE PASS — this is not production certification.');
}
main().catch(err => { console.error('SANDBOX LIFECYCLE FAILED:', err instanceof Error ? err.message : err); process.exitCode = 1; });
