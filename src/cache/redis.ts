import { Redis } from 'ioredis';
export type RedisClient = Redis;
import { pino } from 'pino';
import crypto from 'node:crypto';

const logger = pino({ name: 'cache' });

let redis: RedisClient | null = null;

export function getRedis(): RedisClient {
  if (!redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 3000);
        return delay;
      },
      lazyConnect: true,
    });

    redis.on('error', (err: Error) => {
      logger.error({ err }, 'Redis connection error');
    });

    redis.on('connect', () => {
      logger.debug('Redis connected');
    });
  }

  return redis;
}

export async function connectRedis(): Promise<void> {
  const client = getRedis();
  await client.connect();
}

export async function checkCacheHealth(): Promise<boolean> {
  try {
    const result = await getRedis().ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis connection closed');
  }
}

// TTL presets in seconds
export const TTL = {
  COMPANY_PROFILE: 3600,       // 1 hour
  LATEST_PRICE: 300,           // 5 minutes
  SCREEN_RESULTS: 900,         // 15 minutes
  MACRO_INDICATORS: 21600,     // 6 hours
  FINANCIAL_DATA: 3600,        // 1 hour
  SEARCH_RESULTS: 600,         // 10 minutes
  INDEX_CONSTITUENTS: 86400,   // 24 hours
} as const;

// Cache key builder
export function cacheKey(
  domain: string,
  identifier: string,
  params?: Record<string, unknown>
): string {
  let key = `equity:${domain}:${identifier}`;
  if (params && Object.keys(params).length > 0) {
    const hash = crypto
      .createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex')
      .slice(0, 8);
    key += `:${hash}`;
  }
  return key;
}

// Generic cache-aside helper
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const data = await getRedis().get(key);
    if (data) {
      return JSON.parse(data) as T;
    }
    return null;
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed');
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    await getRedis().setex(key, ttlSeconds, JSON.stringify(value));
  } catch (err) {
    logger.warn({ err, key }, 'Cache write failed');
  }
}

export async function cacheInvalidate(pattern: string): Promise<void> {
  try {
    const keys = await getRedis().keys(pattern);
    if (keys.length > 0) {
      await getRedis().del(...keys);
      logger.debug({ pattern, count: keys.length }, 'Cache invalidated');
    }
  } catch (err) {
    logger.warn({ err, pattern }, 'Cache invalidation failed');
  }
}
