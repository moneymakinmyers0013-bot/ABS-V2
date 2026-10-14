import os from 'node:os';
import { env } from '../lib/config';
import { prisma } from '../lib/db';
import { redis } from '../lib/queue';
import { scanDiscoveryFeeds } from '../services/discovery';
const lockKey = 'abs:discovery:scan-lock';
const owner = `${os.hostname()}-${process.pid}`;
let stopping = false;
async function scan() {
  if (stopping) return;
  // Single worker obtains a short lease so horizontal replicas do not hammer sources.
  const acquired = await redis.set(lockKey, owner, 'EX', Math.max(60, env.DISCOVERY_INTERVAL_SECONDS - 5), 'NX');
  if (acquired !== 'OK') return;
  try { const result = await scanDiscoveryFeeds(); console.log('discovery_scan', JSON.stringify(result)); }
  catch (e) { console.error('discovery_scan_failed', e instanceof Error ? e.message : 'unknown error'); }
  finally {
    // Compare-and-delete atomically: GET followed by DEL can delete a newer
    // worker's lease if this lease expires between those two Redis commands.
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      lockKey,
      owner
    );
  }
}
async function shutdown() { stopping = true; clearInterval(timer); await prisma.$disconnect(); await redis.quit(); process.exit(0); }
const timer = setInterval(() => { void scan(); }, env.DISCOVERY_INTERVAL_SECONDS * 1000);
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
console.log(`ABS discovery worker ${owner} online; interval=${env.DISCOVERY_INTERVAL_SECONDS}s; auto-claim=${env.AGENT_AUTO_CLAIM_ENABLED}`);
void scan();
