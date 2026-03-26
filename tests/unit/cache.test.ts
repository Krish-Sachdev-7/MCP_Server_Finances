import { describe, expect, it } from 'vitest';
import { TTL, cacheKey } from '../../src/cache/redis';

describe('cache utilities', () => {
  describe('cacheKey', () => {
    it('builds key as equity:{domain}:{id}:{hash} when params exist', () => {
      const key = cacheKey('company', 'RELIANCE', { period: '1y', limit: 10 });
      expect(key).toMatch(/^equity:company:RELIANCE:[a-f0-9]{8}$/);
    });

    it('produces consistent hash for same params', () => {
      const a = cacheKey('screen', 'preset', { sortBy: 'pe', limit: 20 });
      const b = cacheKey('screen', 'preset', { sortBy: 'pe', limit: 20 });
      expect(a).toBe(b);
    });

    it('produces different hashes for different params', () => {
      const a = cacheKey('screen', 'preset', { sortBy: 'pe', limit: 20 });
      const b = cacheKey('screen', 'preset', { sortBy: 'roe', limit: 20 });
      expect(a).not.toBe(b);
    });

    it('omits hash suffix when params are absent', () => {
      const key = cacheKey('macro', 'overview');
      expect(key).toBe('equity:macro:overview');
    });

    it('omits hash suffix when params are an empty object', () => {
      const key = cacheKey('macro', 'overview', {});
      expect(key).toBe('equity:macro:overview');
    });
  });

  describe('TTL constants', () => {
    it('contains expected TTL keys', () => {
      expect(TTL).toHaveProperty('COMPANY_PROFILE');
      expect(TTL).toHaveProperty('LATEST_PRICE');
      expect(TTL).toHaveProperty('SCREEN_RESULTS');
      expect(TTL).toHaveProperty('MACRO_INDICATORS');
      expect(TTL).toHaveProperty('FINANCIAL_DATA');
      expect(TTL).toHaveProperty('SEARCH_RESULTS');
      expect(TTL).toHaveProperty('INDEX_CONSTITUENTS');
    });

    it('has positive numeric values for all TTL entries', () => {
      const values = Object.values(TTL);
      for (const ttl of values) {
        expect(typeof ttl).toBe('number');
        expect(Number.isFinite(ttl)).toBe(true);
        expect(ttl).toBeGreaterThan(0);
      }
    });

    it('keeps relative ordering of hot-vs-slow changing data reasonable', () => {
      expect(TTL.LATEST_PRICE).toBeLessThan(TTL.COMPANY_PROFILE);
      expect(TTL.SCREEN_RESULTS).toBeLessThan(TTL.MACRO_INDICATORS);
      expect(TTL.INDEX_CONSTITUENTS).toBeGreaterThanOrEqual(TTL.COMPANY_PROFILE);
    });
  });
});
