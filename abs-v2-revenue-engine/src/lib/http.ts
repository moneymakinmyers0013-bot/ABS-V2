import type { Request, Response, NextFunction } from 'express';
import { env } from './config';

function safeEqual(a: string, b: string) {
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function suppliedAdminToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (!header) return undefined;
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1];
  const basic = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!basic) return undefined;
  try {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0 || decoded.slice(0, colon) !== 'owner') return undefined;
    return decoded.slice(colon + 1);
  } catch { return undefined; }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const supplied = suppliedAdminToken(req);
  if (!supplied || !safeEqual(supplied, env.ABS_ADMIN_TOKEN)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Owner-only browser gate. Browser Basic Auth keeps the token out of page JavaScript and local storage.
export function requireOwnerPage(req: Request, res: Response, next: NextFunction) {
  if (env.APP_ENV === 'production' && !req.secure) {
    return res.status(400).send('HTTPS is required for the owner administration page.');
  }
  const supplied = suppliedAdminToken(req);
  if (!supplied || !safeEqual(supplied, env.ABS_ADMIN_TOKEN)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="ABS v2 Owner Administration", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).send('Owner authentication required.');
  }
  next();
}

export function asyncRoute(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => { Promise.resolve(fn(req,res,next)).catch(next); };
}
