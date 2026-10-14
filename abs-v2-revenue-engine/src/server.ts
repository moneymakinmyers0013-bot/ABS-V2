import express from 'express';
import { env } from './lib/config';
import { prisma } from './lib/db';
import { redis } from './lib/queue';
import taskRoutes from './routes/tasks';
import payoutRoutes from './routes/payouts';
import webhookRoutes from './routes/webhooks';
import agentRoutes from './routes/agent';
import discoveryRoutes from './routes/discovery';
import adminConfigRoutes from './routes/admin-config';
import { agentCard } from './services/agent-catalog';
import { requireOwnerPage } from './lib/http';
import { mountX402Routes } from './routes/x402';
const paypalBankSetupPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><title>ABS v2 — PayPal bank setup</title>
<script>
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };
</script>
<script defer src="/_vercel/insights/script.js"></script>
<style>
:root{color-scheme:dark light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:#101318;color:#f4f5f7}main{max-width:760px;margin:auto;padding:20px 16px 44px}.panel{background:#1b2028;border:1px solid #343b47;border-radius:16px;padding:18px;margin:14px 0}h1{font-size:1.5rem;margin:0 0 8px}h2{font-size:1.08rem;margin:0 0 12px}p,li{line-height:1.55;color:#d5d9e0}small,.muted{color:#aeb7c4}.pill{display:inline-block;padding:5px 9px;border-radius:999px;background:#492b2b;color:#ffcccc;font-size:.82rem;font-weight:700}.ok{color:#a7f3c0}.blocked{color:#ffcb9e}label{display:block;font-weight:650;margin:12px 0 6px}input,button{font:inherit;width:100%;border-radius:10px;padding:12px;border:1px solid #586273}input{background:#0e1116;color:white}button{background:#e6eaf0;color:#101318;font-weight:750;cursor:pointer;margin-top:12px}a{color:#a8c7ff;overflow-wrap:anywhere}.statusrow{display:flex;gap:12px;justify-content:space-between;border-bottom:1px solid #343b47;padding:9px 0}.statusrow span:first-child{color:#b7c0cb}.statusrow span:last-child{text-align:right;overflow-wrap:anywhere}.notice{border-left:4px solid #e0a35b;padding:10px 12px;background:#30271f;border-radius:4px}.error{color:#ffb5b5;white-space:pre-wrap}.success{color:#a7f3c0;white-space:pre-wrap}ol{padding-left:22px}code{overflow-wrap:anywhere}@media(min-width:600px){main{padding-top:32px}}
</style></head><body><main>
<h1>ABS v2 — PayPal-to-bank setup</h1><p class="muted">Secure setup checklist · mobile-friendly · no credential collection in this page</p>
<div class="panel"><span class="pill">OWNER-ONLY · LIVE OPERATIONS GATED</span><p>This page is protected by browser-level owner authentication. Use username <code>owner</code> and your ABS admin token as the password when prompted. The token is not exposed to page JavaScript or browser storage. This page never asks for PayPal client secrets, bank passwords, card numbers, or private keys.</p></div>
<div class="panel"><h2>1. Check server configuration</h2><button id="check" type="button">Check configuration status</button><p id="message" class="muted" aria-live="polite">Owner authenticated. Check current server-side configuration.</p><div id="status" hidden></div></div>
<div class="panel"><h2>2. Configure secrets in your hosting dashboard</h2><ol><li>Open the secure environment-variable / secrets settings for the deployed ABS v2 service.</li><li>Set <code>PAYPAL_MODE=live</code> only when intentionally targeting production. This alone does not enable live operations.</li><li>Add <code>PAYPAL_CLIENT_ID</code>, <code>PAYPAL_CLIENT_SECRET</code>, and <code>PAYPAL_WEBHOOK_ID</code> as server-side secrets. Never add them to HTML, Git, client-side JavaScript, logs, or this chat.</li><li>Keep <code>PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false</code> and <code>ABS_PAYOUT_RELEASE_GATE_PASSED=false</code> until required integration, security, sandbox, and reconciliation gates have passed.</li><li>Redeploy/restart the service after changing environment settings.</li></ol></div>
<div class="panel"><h2>3. Link the bank and configure PayPal automatic transfers</h2><ol><li>Open <a href="https://www.paypal.com/" target="_blank" rel="noopener noreferrer">PayPal directly</a> and sign in.</li><li>In PayPal Wallet, link and verify your bank account through PayPal’s own secure flow.</li><li>Look in PayPal’s balance/transfer settings for automatic transfers to the verified bank, if this feature is available for your account and region. Review schedules, minimums, fees, and eligibility.</li><li>Do not enter online banking credentials into ABS v2.</li></ol><p class="notice">Important technical limitation: the current ABS v2 PayPal payout adapter submits recipient payouts to PayPal email recipients. That is not the same as withdrawing your own PayPal balance to your bank. This implementation does not permanently hard-code the release gate off: live financial operations can only be considered after all required release checks pass and the actual payout adapter supports the requested operation. The current adapter cannot withdraw the owner’s PayPal balance to a bank, so ABS-initiated bank withdrawals remain unavailable until a documented, authorized adapter is implemented. PayPal account-level auto-transfers must currently be configured and managed in PayPal itself.</p></div>
<div class="panel"><h2>4. Release gate</h2><p>Live financial operations must remain disabled until the actual repository passes its build, database/migration, provider sandbox lifecycle, security, duplicate-request, timeout-recovery, and payout-reconciliation checks. A green configuration status alone is not proof that the bank is connected or that a payout succeeded.</p><p id="blockers" class="muted">Configuration blockers will appear after a status check.</p></div>
<p class="muted">No credentials are sent to ChatGPT by this page. The admin token is sent only in an Authorization header to this same ABS origin when you press the status-check button. Do not use this page on an untrusted device or public Wi-Fi.</p>
</main><script>
(function(){'use strict';var button=document.getElementById('check');var message=document.getElementById('message');var statusBox=document.getElementById('status');var blockers=document.getElementById('blockers');button.addEventListener('click',async function(){button.disabled=true;message.className='muted';message.textContent='Checking server configuration…';statusBox.hidden=true;try{var r=await fetch('/admin/config/status',{method:'GET',headers:{'Accept':'application/json'},cache:'no-store',credentials:'same-origin',redirect:'error'});var d=await r.json();if(!r.ok)throw new Error(r.status===401?'Unauthorized: token was rejected.':'Status request failed ('+r.status+').');statusBox.hidden=false;statusBox.replaceChildren();var fields=[['Runtime mode',d.runtimeMode],['Application environment',d.appEnvironment],['PayPal credentials present',d.credentialsPresent?'Yes':'No'],['Webhook ID present',d.webhookPresent?'Yes':'No'],['Live financial flag',d.liveFinancialFlagEnabled?'Enabled':'Disabled'],['Release gate attestation',d.releaseGateAttestationPresent?'Present':'Missing'],['Bank verification attestation',d.bankDestinationOwnerAttestationPresent?'Present':'Missing'],['Auto-transfer attestation',d.automaticTransfersOwnerAttestationPresent?'Present':'Missing'],['ABS owner bank withdrawal adapter',d.paypalOwnerBalanceToBankApiSupportedByCurrentAdapter?'Available':'Not implemented'],['Live payout eligibility',d.livePayoutsEnabled?'Enabled by release gates':'Blocked']];fields.forEach(function(pair){var row=document.createElement('div');row.className='statusrow';var left=document.createElement('span');left.textContent=pair[0];var right=document.createElement('span');right.textContent=String(pair[1]);row.append(left,right);statusBox.appendChild(row);});blockers.textContent=(d.blockers||[]).map(function(x){return '• '+x;}).join('\n');blockers.className='error';message.className='success';message.textContent='Received configuration status. This is not provider verification and does not enable payouts.';}catch(e){message.className='error';message.textContent=e instanceof Error?e.message:'Request failed.';}finally{button.disabled=false;}});})();
</script></body></html>`;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit:'1mb', strict:true }));
mountX402Routes(app);
app.get('/.well-known/agent.json', (_req,res) => res.json(agentCard));
app.get('/admin/paypal-bank', requireOwnerPage, (_req,res) => { res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; connect-src 'self' https://vitals.vercel-insights.com; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"); res.type('html').send(paypalBankSetupPage); });
app.use('/admin/config', adminConfigRoutes);
app.get('/health', async (_req,res) => {
  try { await prisma.$queryRaw`SELECT 1`; await redis.ping(); res.json({ status:'ok', database:'ok', redis:'ok', mode:env.PAYPAL_MODE }); }
  catch { res.status(503).json({ status:'degraded' }); }
});
app.use('/tasks', taskRoutes);
app.use('/payouts', payoutRoutes);
app.use('/webhooks', webhookRoutes);
app.use('/agent/v1', agentRoutes);
app.use('/admin/discovery', discoveryRoutes);
app.use((err: unknown, _req:express.Request, res:express.Response, _next:express.NextFunction) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  const hinted = err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const status = hinted ?? (err && typeof err === 'object' && 'name' in err && err.name === 'ZodError' ? 400 : 500);
  if (status === 500) console.error('request_error', message);
  res.status(status).json({ error:status === 400 ? message : 'request failed', ...(env.NODE_ENV !== 'production' && status === 500 ? { detail:message } : {}) });
});
const server = app.listen(env.PORT, () => console.log(`ABS v2 API listening on ${env.PORT}`));
async function shutdown() { server.close(); await prisma.$disconnect(); await redis.quit(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
