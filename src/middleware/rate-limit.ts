import { getRedis } from '../cache/redis.js';
import { pino } from 'pino';

const logger = pino({ name: 'rate-limit' });

const DEFAULT_RPM = parseInt(process.env.RATE_LIMIT_RPM || '100', 10);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
  limit: number;
}

export async function checkRateLimit(
  clientId: string,
  rpm = DEFAULT_RPM
): Promise<RateLimitResult> {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 60;
  const key = `ratelimit:${clientId}:rpm`;

  try {
    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, '-inf', windowStart);
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    pipeline.zcard(key);
    pipeline.expire(key, 120);

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) || 0;

    if (count > rpm) {
      return {
        allowed: false,
        remaining: 0,
        resetInSeconds: 60,
        limit: rpm,
      };
    }

    return {
      allowed: true,
      remaining: rpm - count,
      resetInSeconds: 60,
      limit: rpm,
    };
  } catch (err) {
    logger.warn({ err, clientId }, 'Rate limit check failed, allowing request');
    return { allowed: true, remaining: rpm, resetInSeconds: 60, limit: rpm };
  }
}
