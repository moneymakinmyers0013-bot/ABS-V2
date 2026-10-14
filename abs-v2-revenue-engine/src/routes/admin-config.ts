import { Router } from 'express';
import { env } from '../lib/config';
import { requireAdmin } from '../lib/http';

const router = Router();

// This status endpoint intentionally returns booleans and blockers only. It never returns secrets.
router.get('/status', requireAdmin, (_req, res) => {
  const credentialsPresent = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  const webhookPresent = Boolean(env.PAYPAL_WEBHOOK_ID);
  const liveFlag = env.PRODUCTION_FINANCIAL_OPERATIONS_ENABLED === 'true';
  const releaseGateAttested = env.ABS_PAYOUT_RELEASE_GATE_PASSED === 'true';
  const bankVerifiedAttested = env.PAYPAL_BANK_DESTINATION_VERIFIED === 'true';
  const autoTransfersAttested = env.PAYPAL_AUTO_TRANSFERS_CONFIGURED === 'true';
  const blockers: string[] = [];
  if (!credentialsPresent) blockers.push('PayPal API credentials are missing from server-side environment secrets.');
  if (!webhookPresent) blockers.push('PayPal webhook ID is missing from server-side environment secrets.');
  if (env.PAYPAL_MODE !== 'live') blockers.push('Runtime is not configured for live PayPal mode.');
  if (env.APP_ENV !== 'production') blockers.push('APP_ENV must be production before live payment operations can be considered.');
  if (!liveFlag) blockers.push('PRODUCTION_FINANCIAL_OPERATIONS_ENABLED is false.');
  if (!releaseGateAttested) blockers.push('ABS_PAYOUT_RELEASE_GATE_PASSED is false; required release checks have not been attested.');
  if (!bankVerifiedAttested) blockers.push('Bank destination verification has not been attested in PayPal.');
  if (!autoTransfersAttested) blockers.push('PayPal automatic bank transfers have not been attested as configured in PayPal account settings.');
  // Critical limitation: the existing PayPal Payouts API adapter sends to recipient email addresses.
  // It is not an owner balance-to-bank withdrawal adapter. Do not allow this app to call it as a bank payout.
  blockers.push('ABS v2 has no supported API adapter to withdraw the owner’s PayPal balance directly to their bank. Configure PayPal’s account-level automatic transfers in PayPal itself; app-controlled bank payout remains disabled.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    provider: 'paypal',
    requestedMode: 'live',
    runtimeMode: env.PAYPAL_MODE,
    appEnvironment: env.APP_ENV,
    credentialsPresent,
    webhookPresent,
    liveFinancialFlagEnabled: liveFlag,
    releaseGateAttestationPresent: releaseGateAttested,
    bankDestinationOwnerAttestationPresent: bankVerifiedAttested,
    automaticTransfersOwnerAttestationPresent: autoTransfersAttested,
    paypalOwnerBalanceToBankApiSupportedByCurrentAdapter: false,
    absInitiatedBankPayoutsEnabled: false,
    livePayoutsEnabled: false,
    blockers,
    note: 'Status is derived from server configuration and owner-attested flags. It does not verify a PayPal account, bank destination, or transfer. No secrets are returned.'
  });
});

export default router;
