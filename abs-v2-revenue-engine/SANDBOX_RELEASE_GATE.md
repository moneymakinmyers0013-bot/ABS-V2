# ABS v2 sandbox release gate

## Current result: BLOCKED

The repository has been hardened and local source-level release-gate checks pass, but the full PayPal sandbox lifecycle has **not** been executed. Do not enable live financial operations.

## Changes in this revision

- Delivery re-hashes output bytes before issuing a receipt and again at download. Acceptance requires a successful download with a matching one-time token.
- Task intake accepts only implemented deterministic task types; placeholder executors cannot create a passing deliverable.
- The executor reads output back from disk, verifies the SHA-256 hash, parses JSON, and checks row counts/normalization/duplicate invariants before marking delivery eligible.
- A durable outbox publisher retries queue publication after process crashes.
- Amount handling is explicitly restricted to USD until non-two-decimal currency support is implemented.
- Revenue is recognized only after customer acceptance. Payout capacity is capped by provider cash and earned revenue net of prior owner distributions and active reservations. Payout reservation creation uses a serializable transaction.
- PayPal capture first reconciles provider state to recover an already-completed capture rather than blindly treating retries as new captures. Task/quote state blocks repeated capture after authorization.
- A payout is marked `PAID` only if the provider item reports success and the amount, currency, recipient, and sender batch identifier match the canonical payout.
- Live operations remain disabled by default.

## Checks actually run here

- `npm test` (`node --test tests/*.test.mjs`): **8 passed, 0 failed**. These are dependency-free source-level regression checks.
- TypeScript transpile/syntax check of every `.ts` file using the globally installed TypeScript compiler API: **13 files parsed successfully**. This does not perform type checking.
- `tsc -p tsconfig.json --noEmit`: **blocked/fails because project dependencies and type definitions are not installed** (`zod`, `@prisma/client`, Express, BullMQ, Node types, etc.).
- `npm install --no-audit --no-fund`: **timed out** in this environment.
- Docker, PostgreSQL, Redis, and Prisma CLI are unavailable in this execution environment; schema validation/migration and DB integration tests could not be run.
- PayPal sandbox credentials, a sandbox buyer approval, and an owner-verified sandbox payout destination are not configured here; no real sandbox order, capture, payout submission, or settlement was performed.

## Required to clear the gate

1. On a networked Node.js 20+ environment, install dependencies.
2. Run `npm run build`, `npm run db:generate`, `npx prisma validate`, and `npm run db:migrate` against a disposable PostgreSQL database.
3. Run API and worker against PostgreSQL/Redis.
4. Configure PayPal sandbox REST credentials and webhook ID locally, never in chat or source control.
5. Create an actual owner-verified sandbox destination and provide the lifecycle runner with an explicit approval ID.
6. Run `npm run sandbox:lifecycle`; use a sandbox buyer to approve checkout and explicitly confirm the payout. Require the runner to end with `SANDBOX LIFECYCLE PASS` and provider-reconciled payout status `PAID`.
7. Review webhook replay, duplicate requests, provider timeouts, insufficient funds, mismatched payout details, and database rollback cases before considering production.

Passing the source-level tests is not production certification. Keep `PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false` until all required integration and security checks pass.


## PayPal-to-bank configuration page addition (2026-10-12)

- Added mobile page at `/admin/paypal-bank`; it does not collect PayPal API credentials or banking credentials.
- Page accepts the ABS admin token in memory for a same-origin status request only; it does not use localStorage/sessionStorage and clears the field after the request.
- Added admin-protected `/admin/config/status`, which returns only configuration booleans and blockers, never credential values.
- Added `ABS_PAYOUT_RELEASE_GATE_PASSED=false` and owner-attestation flags, all false by default. Live PayPal operations now additionally require the release-gate attestation. This flag is not automatic proof; set it only after actual required gates pass.
- **BLOCKED:** current PayPal adapter uses recipient Payouts API with email recipients; it is not an owner balance-to-bank withdrawal API. The new status endpoint hardcodes ABS-initiated bank payouts to disabled. Owner must configure account-level automatic bank transfers directly in PayPal if the feature is available. No account or bank status was verified.
- Source-level tests after this addition: 15 passed, 0 failed (`node --test tests/*.test.mjs`).
- TypeScript build, provider sandbox lifecycle, database/Redis integration, account setup, and deployment were not executed in this working directory and remain unverified.
