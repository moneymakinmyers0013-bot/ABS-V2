import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { prisma } from '../lib/db';
import { env } from '../lib/config';

const supported = new Set(['csv_cleanup','data_normalization','duplicate_removal','data_transformation','categorization']);
type FeedConfig = { key: string; url: string; allowedHost: string };
type FeedItem = { id?: unknown; title?: unknown; taskType?: unknown; description?: unknown; url?: unknown; claimUrl?: unknown; rewardCents?: unknown; currency?: unknown; input?: unknown };
function feeds(): FeedConfig[] {
  let parsed: unknown;
  try { parsed = JSON.parse(env.AGENT_DISCOVERY_FEEDS); } catch { throw new Error('AGENT_DISCOVERY_FEEDS must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('AGENT_DISCOVERY_FEEDS must be a JSON array');
  return parsed.map((x: any) => {
    if (!x || typeof x.key !== 'string' || !/^[a-z0-9_-]{1,48}$/i.test(x.key) || typeof x.url !== 'string' || typeof x.allowedHost !== 'string') throw new Error('Each discovery feed requires key, url, allowedHost');
    const u = new URL(x.url);
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== x.allowedHost.toLowerCase() || u.username || u.password) throw new Error(`Feed ${x.key} must use HTTPS and exactly match its allowlisted hostname`);
    return { key: x.key, url: u.toString(), allowedHost: x.allowedHost.toLowerCase() };
  });
}
function isPrivateAddress(ip: string): boolean {
  if (ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:') || ip.startsWith('ff') || ip.startsWith('2001:db8:')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0]!, b = parts[1]!;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
async function assertPublicHost(host: string) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('Private/local discovery hosts are forbidden');
  if (isIP(host)) { if (isPrivateAddress(host)) throw new Error('Private discovery IP is forbidden'); return; }
  const resolved = await lookup(host, { all: true, verbatim: true });
  if (!resolved.length || resolved.some(r => isPrivateAddress(r.address))) throw new Error('Discovery hostname resolves to a private or invalid address');
}
function record(x: unknown): x is Record<string, unknown> { return !!x && typeof x === 'object' && !Array.isArray(x); }
function sameHostUrl(raw: unknown, host: string): string | null {
  if (typeof raw !== 'string') return null;
  try { const u = new URL(raw); if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== host || u.username || u.password) return null; return u.toString(); } catch { return null; }
}
export async function scanDiscoveryFeeds() {
  const configs = feeds(); let scanned = 0, upserted = 0, rejected = 0;
  for (const feed of configs) {
    try {
      await assertPublicHost(feed.allowedHost);
      const response = await fetch(feed.url, { redirect: 'error', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`feed returned HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 2_000_000) throw new Error('feed exceeds 2MB limit');
      const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const items = Array.isArray(body) ? body : record(body) && Array.isArray(body.items) ? body.items : null;
      if (!items) throw new Error('feed must be an array or an object with an items array');
      for (const raw of items.slice(0, 500)) {
        scanned++;
        if (!record(raw)) { rejected++; continue; }
        const x = raw as FeedItem;
        const externalId = typeof x.id === 'string' || typeof x.id === 'number' ? String(x.id).slice(0, 200) : '';
        const title = typeof x.title === 'string' ? x.title.trim().slice(0, 200) : '';
        const sourceUrl = sameHostUrl(x.url, feed.allowedHost);
        if (!externalId || !title || !sourceUrl) { rejected++; continue; }
        const taskType = typeof x.taskType === 'string' && supported.has(x.taskType) ? x.taskType : null;
        const rewardCents = typeof x.rewardCents === 'number' && Number.isSafeInteger(x.rewardCents) && x.rewardCents >= 0 && x.rewardCents <= 500000 ? x.rewardCents : null;
        const currency = typeof x.currency === 'string' && /^[A-Z]{3}$/.test(x.currency) ? x.currency : 'USD';
        const claimUrl = sameHostUrl(x.claimUrl, feed.allowedHost);
        const status = taskType && rewardCents !== null && rewardCents >= 100 && currency === 'USD' ? 'QUALIFIED_REVIEW_REQUIRED' : 'UNSUPPORTED_OR_INCOMPLETE';
        await prisma.marketLead.upsert({ where: { sourceKey_externalId: { sourceKey: feed.key, externalId } }, create: { sourceKey: feed.key, externalId, title, taskType, description: typeof x.description === 'string' ? x.description.slice(0, 5000) : null, sourceUrl, claimUrl, rewardCents, currency, payload: { feedItem: raw }, status, rejectionReason: status === 'UNSUPPORTED_OR_INCOMPLETE' ? 'Unsupported task type or incomplete reward/schema metadata' : null }, update: { title, taskType, description: typeof x.description === 'string' ? x.description.slice(0, 5000) : null, sourceUrl, claimUrl, rewardCents, currency, payload: { feedItem: raw }, status: status === 'QUALIFIED_REVIEW_REQUIRED' ? undefined : status, rejectionReason: status === 'UNSUPPORTED_OR_INCOMPLETE' ? 'Unsupported task type or incomplete reward/schema metadata' : undefined } });
        upserted++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 500) : 'unknown discovery error';
      await prisma.auditEvent.create({ data: { agent: 'discovery-worker', action: 'DISCOVERY_FEED_FAILED', result: 'FAILED', correlationId: `discovery:${feed.key}:${Math.floor(Date.now()/60000)}`, evidence: { sourceKey: feed.key, error: message } } });
    }
  }
  await prisma.auditEvent.create({ data: { agent: 'discovery-worker', action: 'DISCOVERY_SCAN_COMPLETED', result: 'SUCCESS', correlationId: `discovery:${Date.now()}`, evidence: { feedCount: configs.length, scanned, upserted, rejected, autoClaimEnabled: env.AGENT_AUTO_CLAIM_ENABLED === 'true' } } });
  return { feedCount: configs.length, scanned, upserted, rejected };
}
