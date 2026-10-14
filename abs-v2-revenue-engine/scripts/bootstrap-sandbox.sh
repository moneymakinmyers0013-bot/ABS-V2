#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

fail() { printf 'BLOCKED: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || fail 'Node.js 20+ is required.'
node -e 'const [major] = process.versions.node.split(".").map(Number); if (major < 20) process.exit(1)' || fail "Node.js 20+ required; found $(node --version)."
command -v npm >/dev/null 2>&1 || fail 'npm is required.'
command -v docker >/dev/null 2>&1 || fail 'Docker is required to start PostgreSQL and Redis. Install/start Docker Desktop or use existing services and run the checks manually.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose plugin is required.'

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  printf 'Created .env from .env.example. Configure PayPal SANDBOX credentials and destination approval, then rerun this script.\n'
  exit 2
fi

# Check required local settings without printing secrets.
node <<'NODE'
const fs = require('fs');
const env = Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#') && l.includes('=')).map(l => { const i=l.indexOf('='); return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const required = ['DATABASE_URL','REDIS_URL','ABS_ADMIN_TOKEN','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET','PAYPAL_WEBHOOK_ID'];
const missing = required.filter(k => !env[k] || env[k].startsWith('replace-with-'));
if (env.PAYPAL_MODE !== 'sandbox') missing.push('PAYPAL_MODE must be sandbox');
if (env.PRODUCTION_FINANCIAL_OPERATIONS_ENABLED !== 'false') missing.push('PRODUCTION_FINANCIAL_OPERATIONS_ENABLED must be false');
if (missing.length) { console.error('BLOCKED: configure these .env settings locally: ' + [...new Set(missing)].join(', ')); process.exit(2); }
NODE

printf '\n[1/6] Starting PostgreSQL and Redis...\n'
docker compose up -d postgres redis
printf '\n[2/6] Installing packages...\n'
npm install --no-audit --no-fund
printf '\n[3/6] Generating Prisma client...\n'
npm run db:generate
printf '\n[4/6] Validating Prisma schema...\n'
npx prisma validate
printf '\n[5/6] Applying local development migrations...\n'
npm run db:migrate -- --name sandbox_bootstrap
printf '\n[6/6] Running build and tests...\n'
npm run build
npm test
printf '\nPASS: local bootstrap checks completed. This does NOT prove the provider lifecycle.\n'
printf 'Next: start API and worker in separate terminals, then run npm run sandbox:lifecycle and require provider-confirmed PAID.\n'
printf 'Keep PRODUCTION_FINANCIAL_OPERATIONS_ENABLED=false.\n'
