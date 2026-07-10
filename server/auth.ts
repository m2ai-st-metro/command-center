import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Shared-secret bearer auth for mutating /api routes (Q-20260708-0007).
 *
 * Closes the orchestrator spawn perimeter: :3142 binds 0.0.0.0 and POST /api/tasks
 * is a fire-and-forget spawn of a write-capable agent. This middleware requires a
 * bearer on every state-changing request; read-only GET/HEAD/OPTIONS stay open (the
 * network-layer ufw allowlist is the perimeter for those).
 *
 * Fail-closed: if CMD_API_TOKEN is unset, mutating requests are rejected (503), not
 * allowed. A misconfigured restart surfaces loudly instead of running wide open.
 *
 * The token reaches this process via a `source ~/.env.shared` start wrapper
 * (scripts/pm2-command-center.sh) — PM2's ambient env is frozen and cannot be relied on.
 */

const TOKEN = process.env.CMD_API_TOKEN ?? '';
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

if (!TOKEN) {
  console.error(
    '[auth] WARNING: CMD_API_TOKEN is unset. All mutating /api routes will be REJECTED ' +
      '(fail-closed). Start the server via scripts/pm2-command-center.sh, or source ' +
      '~/.env.shared before launching, so the bearer is present.',
  );
}

/** Constant-time string compare that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Pull the presented token from `Authorization: Bearer <t>` or `X-CMD-Token: <t>`. */
function presentedToken(req: Request): string | null {
  const auth = req.get('authorization');
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.get('x-cmd-token');
  if (x) return x.trim();
  return null;
}

/**
 * Require a valid bearer on all mutating /api requests. Mount BEFORE the router:
 *   app.use('/api', requireApiToken, router)
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) {
    next();
    return;
  }
  if (!TOKEN) {
    res.status(503).json({ error: 'Server auth not configured (CMD_API_TOKEN unset)' });
    return;
  }
  const presented = presentedToken(req);
  if (!presented || !safeEqual(presented, TOKEN)) {
    res.status(401).json({ error: 'Unauthorized: a valid bearer token is required for mutating requests' });
    return;
  }
  next();
}

/** The active token, for server-side injection into the SPA (never a committed bundle). */
export const API_TOKEN = TOKEN;
