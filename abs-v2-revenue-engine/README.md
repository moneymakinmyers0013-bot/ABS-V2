# ABS v2 — provider-evidence-gated B2B revenue engine

This is an implementation scaffold for the Prisma schema: API, Postgres persistence, Redis/BullMQ worker, deterministic task executors, PayPal order/capture integration, owner-gated payout reservations, payout submission and provider reconciliation, audit records, and balanced ledger postings.

**Important:** this is not yet a certified or fully production-ready financial system. Run sandbox tests and an independent security/accounting review before live use. Provider behavior and payout APIs can vary by account/country/capability. The implementation intentionally fails closed on ambiguous payment/payout outcomes and does not treat a webhook alone as proof of a capture.

## Requirements

- Node.js 20+
- PostgreSQL 14+
- Redis 6.2+
- PayPal developer account for sandbox credentials

## Run

```bash
cp .env.example .env
# Edit DATABASE_URL, REDIS_URL and ABS_ADMIN_TOKEN
npm install
npm run db:generate
npm run db:migrate
npm run dev
```

In a second process:

```bash
npm run worker
```

Check `GET /health`.

## API

### Create a task and quote

`POST /tasks`

```json
{
  "customerEmail": "customer@example.com",
  "source": "direct",
  "taskType": "csv_cleanup",
  "input": { "rows": [{ "name": " Ada  Lovelace ", "email": "ada@example.com" }] },
  "amountCents": 500,
  "currency": "USD",
  "pricingVersion": "v1"
}
```

Task types currently accepted for quoting are limited to deterministic implementations: `csv_cleanup`, `data_normalization`, `duplicate_removal`, `data_transformation`, and `categorization`. Unsupported types are rejected at intake rather than charged and then represented as successful work. Output is re-read from disk, hash-checked, parsed, and checked against task-specific invariants before delivery is enabled.

### Create a PayPal order

`POST /tasks/:taskId/payment-order`

The response includes the PayPal order ID and approval links. The customer must approve the order through the provider's checkout flow.

### Capture and verify

`POST /tasks/:taskId/capture`

The server captures the order and verifies completed status, exact integer-cent amount, and currency before moving the task to `AUTHORIZED` and posting the inbound ledger group. In production, secure this endpoint with customer/session authentication and enforce customer ownership; it is left accessible in this scaffold for integration testing.

### Queue execution

`POST /tasks/:taskId/run` with `Authorization: Bearer <ABS_ADMIN_TOKEN>`.

The API checks for a matching `CAPTURED_VERIFIED` inbound payment before enqueueing. The worker checks again before execution.

### Payout flow

1. Create and verify a `Destination` record in the database. It must be active and have `verifiedByOwnerAt` set only after an actual owner verification step.
2. `POST /payouts` with admin authorization, a unique idempotency key, and explicit owner-approval evidence.
3. `POST /payouts/:payoutId/submit` submits a PayPal email payout. If the provider outcome is uncertain, status becomes `UNKNOWN`; the reservation remains held.
4. `POST /payouts/:payoutId/reconcile` fetches provider batch/item state. Only a provider item status of `SUCCESS` marks it `PAID`; terminal failures release the reservation; unresolved states remain non-success.

The `ownerAuthorization` payload in this scaffold is an audit assertion, not a cryptographic owner signature. Before live payouts, replace it with a verified signature or a separate authenticated owner approval flow, enforce ownership/tenant boundaries, and use least-privilege credentials.

## Safety and correctness boundaries

- Never enable live payments until sandbox flows, webhook verification, replay behavior, idempotency, failure recovery, reconciliation and alerting are tested.
- Set `PAYPAL_MODE=sandbox` by default. Live mode additionally requires `APP_ENV=production`, `PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=true`, credentials, and webhook ID.
- `ABS_ADMIN_TOKEN` protects privileged routes, but is not a substitute for customer authentication, owner identity verification, role-based access control, or signed payout approvals.
- A webhook is recorded only after PayPal signature verification. It does not itself authorize a task; provider-state reconciliation is still required.
- The payout reconciler expects provider batch/item details and checks the item status, amount, currency, receiver, and sender batch ID. If any detail is missing or mismatched, it does not mark the payout paid.
- The ledger posting helper checks balanced groups and idempotency inside a DB transaction. Revenue is recognized only after customer acceptance. Payout availability is capped by both positive provider cash and earned revenue not already distributed, less active reservations. Database-level cross-row sum enforcement is not provided by Prisma; all ledger writes must go through this helper and DB permissions should prevent arbitrary writes.
- Output files are written to local `WORKSPACE_DIR` (default `./workspace`). Replace this with private object storage, malware scanning, retention policy, signed download URLs and tenant-scoped access before production.
- Task status transitions are guarded in route/worker code, not fully enforced by database triggers. Add transition constraints or a single state-transition service before production.
- Refund workflow, taxes, provider fees, chargebacks, payout reversals, and dispute adjudication are not implemented.

## Tests and validation

`npm test` runs dependency-free release-gate regression checks. These are source-level safety checks, not substitutes for TypeScript compilation, Prisma schema validation, database integration tests, or real provider sandbox transactions. Run `npm run build`, `npm run db:generate`, and the manual sandbox lifecycle only after dependencies and services are available.

## Environment

See `.env.example`. Do not commit `.env`, credentials, customer data, or provider payloads containing sensitive information.

## Delivery and customer acceptance

After a worker creates an output artifact and a passing validation record, an admin can call `POST /tasks/:taskId/deliver` with `Authorization: Bearer <ABS_ADMIN_TOKEN>`. The server re-hashes the output bytes, stores only a hash of a high-entropy delivery token, and returns a time-limited download URL plus an acceptance endpoint. The customer downloads the output, then calls `POST /tasks/delivery/:receiptId/accept` with `{ "token": "<token-from-delivery-url>", "accepted": true, "note": "..." }`. Acceptance is refused until the output has been downloaded and verified. The raw token is returned only once; issuing a new delivery rotates the token.

## Manual-assisted PayPal sandbox lifecycle test

1. Start PostgreSQL and Redis using `docker compose up -d` on a machine with Docker installed.
2. Copy `.env.example` to `.env`; keep `PAYPAL_MODE=sandbox` and `PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false`.
3. Add PayPal sandbox REST app credentials and webhook ID to the local `.env` (never paste secrets into chat or commit them).
4. Run `npm install`, `npm run db:generate`, and `npm run db:migrate`, then start API and worker in separate terminals.
5. Create an actual owner-verified PayPal sandbox payout destination in the database using your controlled sandbox owner account. Set `SANDBOX_DESTINATION_ID` and a genuine, explicit sandbox owner approval identifier in `.env`.
6. Run `npm run sandbox:lifecycle`. It creates a low-value task and order, pauses for buyer approval in the PayPal sandbox browser, verifies capture, executes and validates output, downloads and hash-checks delivery, records customer acceptance, submits a payout, and polls provider reconciliation. It exits non-zero unless the provider reports a confirmed `PAID` payout.

The lifecycle script is a manual-assisted integration test, not a mock. It cannot complete buyer approval without a person using a sandbox buyer account. Payout completion depends on PayPal sandbox account capabilities and recipient setup. Do not treat an unresolved/pending payout as success. Do not use live credentials for this script.

## One-command local sandbox bootstrap

On a machine with Node.js 20+, Docker Desktop/Engine, and network access to the npm registry:

1. Copy `.env.example` to `.env` if needed.
2. Fill `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` with **sandbox** values from your PayPal developer app. Do not paste credentials into chat or commit `.env`.
3. Create and verify a PayPal sandbox payout destination, and set `SANDBOX_DESTINATION_ID` and `SANDBOX_OWNER_APPROVAL_ID` only after the owner has explicitly approved the test payout.
4. Run `./scripts/bootstrap-sandbox.sh`.
5. In separate terminals run `npm run dev` and `npm run worker`, then run `npm run sandbox:lifecycle` in another terminal. Use only the PayPal sandbox buyer account when prompted.

The bootstrap script refuses non-sandbox configuration and refuses to enable production operations. A successful build/test bootstrap does not itself mean the PayPal lifecycle passed; only the lifecycle runner's final provider-reconciled `PAID` result can pass that gate.

## Agentic sales and opportunity discovery (new)

### Public machine-readable catalog
- `GET /.well-known/agent.json` and `GET /agent/v1/.well-known/agent.json` — compact agent card.
- `GET /agent/v1/catalog` — supported services, schemas, fixed price, and payment policy.
- `GET /agent/v1/openapi.json` — generated OpenAPI 3.1 description for the agent endpoints.
- `POST /agent/v1/jobs` — creates a quote at exactly **100 USD cents** for supported task types. The response includes PayPal order/capture URLs. Quote creation is not payment confirmation, and the existing PayPal capture endpoint remains the authority for funding.

Only currently implemented deterministic tasks are advertised: `csv_cleanup`, `data_normalization`, `duplicate_removal`, `data_transformation`, and `categorization`. Unsupported tasks are not listed or silently marked complete. Job creation is limited per client IP; production deployments should additionally place a WAF/API gateway rate limit in front of public endpoints.

### Continuous opportunity discovery
Run the durable discovery process separately from Vercel Functions:

```bash
npm run discovery
```

Configure `AGENT_DISCOVERY_FEEDS` as a JSON array, for example:

```json
[{"key":"partner-feed","url":"https://jobs.example.com/api/feed","allowedHost":"jobs.example.com"}]
```

Each feed must be a public HTTPS JSON endpoint on the exact allowlisted hostname. The worker rejects private/local destinations, redirects, oversized responses, and non-JSON data; it bounds each feed to 500 items and 2 MB. Supported feed envelope: a JSON array or `{ "items": [...] }`; each item should include `id`, `title`, `url`, `taskType`, `rewardCents`, `currency`, and task metadata. Lead records are deduplicated by `(sourceKey, externalId)` and inspected through admin-authenticated `GET /admin/discovery/leads`.

**Important funding invariant:** discovery is not authorization. The worker records and scores leads but does not claim jobs or spend money based on a marketplace feed's self-reported funding field. A source-specific connector must independently verify escrow/provider evidence, terms, payment timing, and the allowed claim action before unattended acceptance can be implemented. `AGENT_AUTO_CLAIM_ENABLED` defaults to `false` and is currently an explicit guardrail, not a promise that arbitrary marketplaces can be auto-claimed.

### Current payment capability boundary
The agent catalog advertises PayPal because this repository has a provider-state verification path for it. It does **not** advertise x402/USDC as enabled: a real facilitator/chain adapter, exact recipient and asset configuration, replay-safe verification/settlement, and end-to-end provider evidence must be implemented and tested before crypto payments can be offered. Do not treat a 402 response or a transaction hash alone as settled payment.

### Worker/runtime layout
- Vercel: public catalog and API only if the deployment adapter is configured to run the existing Express app correctly.
- Persistent worker runtime: `npm run worker` for execution and `npm run discovery` for feed scans.
- PostgreSQL: canonical jobs, quotes, market leads, evidence, and ledger.
- Redis: durable task queue and scan coordination.

The discovery worker is a real feed poller, not a universal marketplace connector. A live source must be explicitly configured, public, allowlisted, and have a documented contract. No source is enabled by default.


## Mobile PayPal-to-bank configuration page

Open `/admin/paypal-bank` on the deployed ABS origin from iPhone Safari. The page does not collect PayPal credentials; it only accepts the ABS admin token temporarily to call `/admin/config/status`. The token is not stored in browser storage. The status endpoint returns booleans and blockers only, never secret values.

Configure `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_WEBHOOK_ID` only in the hosting provider's server-side secret/environment settings. Keep `PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false` and `ABS_PAYOUT_RELEASE_GATE_PASSED=false` until all release gates have actually passed. `PAYPAL_BANK_DESTINATION_VERIFIED` and `PAYPAL_AUTO_TRANSFERS_CONFIGURED` are owner-attestation flags only; they do not verify provider state and must not be set based solely on this page.

**Bank withdrawal limitation:** the current `PayPalClient.submitPayout` uses PayPal's recipient Payouts API with an email recipient. It is not an API for withdrawing the account owner's own PayPal balance to their bank. This release intentionally reports `absInitiatedBankPayoutsEnabled=false` and keeps that feature blocked. Link the bank and configure PayPal account-level automatic transfers directly in PayPal if available. Do not represent an email-recipient payout as a bank deposit.

## x402 / Base USDC (implementation scaffold; disabled by default)

A new Express route scaffold is present at `POST /agent/v1/x402/cleanup`. It uses the official x402 TypeScript server packages, Base mainnet network identifier `eip155:8453`, exact-price USDC, and an upfront payment flow so settlement is attempted before deterministic cleanup executes. The receiving wallet is a public address supplied through `X402_PAY_TO`; never place a wallet private key in this service.

Required environment values are documented in `.env.example`:

- `X402_ENABLED=false`
- `X402_LEDGER_RECONCILIATION_READY=false`
- `X402_PAY_TO=`
- `X402_FACILITATOR_URL=https://x402.org/facilitator`
- `X402_PRICE=$1.00`

**Do not enable this route yet.** The durable x402 settlement receipt -> database ledger -> chain reconciliation adapter is not implemented or tested. The route intentionally refuses to mount unless both `X402_ENABLED=true` and `X402_LEDGER_RECONCILIATION_READY=true`; the latter is an operator gate, not proof of readiness. Do not set it until the ledger adapter and end-to-end payment tests exist and pass. The public `x402.org` facilitator is for development/test workflows and is explicitly blocked for production mode. Configure a production facilitator that documents Base mainnet support before production use.

A source-level test pass does not verify npm dependency resolution, TypeScript build, facilitator support, wallet correctness, on-chain settlement, deployment, or revenue.
