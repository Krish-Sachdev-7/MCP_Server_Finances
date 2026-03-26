import type { Request, Response, NextFunction } from 'express';
import { rootLogger } from './logger.js';

const logger = rootLogger.child({ module: 'host-validation' });

let cachedAllowList: Set<string> | null = null;

function getAllowedHosts(): Set<string> | null {
  if (cachedAllowList) return cachedAllowList;

  const raw = process.env.ALLOWED_HOSTS;
  if (!raw) return null;

  cachedAllowList = new Set(
    raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  );
  logger.info({ count: cachedAllowList.size }, 'Host allowlist loaded');
  return cachedAllowList;
}

/**
 * Middleware that validates the Host header to prevent DNS rebinding attacks.
 *
 * Development mode: allows localhost and 127.0.0.1 (with or without :3000),
 * plus any host (permissive for local dev).
 *
 * Production mode: checks against ALLOWED_HOSTS env var (comma-separated).
 * If ALLOWED_HOSTS is not set, falls back to allowing any host but logs a warning.
 */
export function validateHost(req: Request, res: Response, next: NextFunction): void {
  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    next();
    return;
  }

  const host = (req.headers.host || '').toLowerCase();

  if (!host) {
    res.status(403).json({ error: 'Forbidden: invalid Host header' });
    return;
  }

  const allowList = getAllowedHosts();

  if (!allowList) {
    // No ALLOWED_HOSTS configured in production -- permissive fallback with warning
    logger.warn(
      { host },
      'ALLOWED_HOSTS not set. Accepting all hosts. Set ALLOWED_HOSTS in production.',
    );
    next();
    return;
  }

  if (allowList.has(host)) {
    next();
    return;
  }

  // Also check without port for hosts that include a port
  const hostWithoutPort = host.split(':')[0];
  if (allowList.has(hostWithoutPort)) {
    next();
    return;
  }

  logger.warn({ host, allowed: [...allowList] }, 'Rejected request with invalid Host header');
  res.status(403).json({ error: 'Forbidden: invalid Host header' });
}

/**
 * Reloads the host allowlist from environment. Useful if ALLOWED_HOSTS changes at runtime.
 */
export function reloadHostAllowlist(): void {
  cachedAllowList = null;
  getAllowedHosts();
}
