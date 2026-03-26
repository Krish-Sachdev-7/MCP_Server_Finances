import { describe, expect, it } from 'vitest';
import {
  cagr,
  xirr,
  dcfValuation,
  piotroskiScore,
  grahamNumber,
  sma,
  ema,
  rsi,
  macd,
} from '../../src/utils/financial-math';

describe('financial-math utilities', () => {
  describe('cagr', () => {
    it('computes normal CAGR case', () => {
      expect(cagr(100, 200, 5)).toBeCloseTo(0.1487, 4);
    });

    it('returns null for zero/negative inputs', () => {
      expect(cagr(0, 200, 5)).toBeNull();
      expect(cagr(100, 0, 5)).toBeNull();
      expect(cagr(-100, 200, 5)).toBeNull();
      expect(cagr(100, 200, 0)).toBeNull();
    });

    it('handles single year and large values', () => {
      expect(cagr(100, 120, 1)).toBeCloseTo(0.2, 10);
      expect(cagr(1_000_000_000, 2_000_000_000, 10)).toBeCloseTo(0.071773, 6);
    });
  });

  describe('xirr', () => {
    it('handles simple investment + return pair', () => {
      const result = xirr([
        { amount: -1000, date: new Date('2024-01-01') },
        { amount: 1100, date: new Date('2025-01-01') },
      ]);

      expect(result).not.toBeNull();
      expect(result!).toBeCloseTo(0.1, 2);
    });

    it('handles monthly SIP-style cashflows', () => {
      const cashflows = [
        { amount: -1000, date: new Date('2024-01-01') },
        { amount: -1000, date: new Date('2024-02-01') },
        { amount: -1000, date: new Date('2024-03-01') },
        { amount: -1000, date: new Date('2024-04-01') },
        { amount: -1000, date: new Date('2024-05-01') },
        { amount: -1000, date: new Date('2024-06-01') },
        { amount: 6500, date: new Date('2025-01-01') },
      ];

      const result = xirr(cashflows);
      expect(result).not.toBeNull();
      expect(Number.isFinite(result!)).toBe(true);
      expect(result!).toBeGreaterThan(0);
    });

    it('returns null for insufficient data', () => {
      expect(xirr([{ amount: -1000, date: new Date('2024-01-01') }])).toBeNull();
    });
  });

  describe('dcfValuation', () => {
    const baseParams = {
      lastFcf: 1000,
      growthRate: 0.1,
      discountRate: 0.15,
      terminalGrowthRate: 0.04,
      projectionYears: 5,
      sharesOutstanding: 100,
      netDebt: 500,
    };

    it('returns positive intrinsic value in normal case', () => {
      const result = dcfValuation(baseParams);
      expect(result.intrinsicValue).toBeGreaterThan(0);
      expect(result.presentValueOfCashFlows).toBeGreaterThan(0);
      expect(result.terminalValue).toBeGreaterThan(0);
    });

    it('is sensitive to growth rate (higher growth => higher value)', () => {
      const lowGrowth = dcfValuation({ ...baseParams, growthRate: 0.05 });
      const highGrowth = dcfValuation({ ...baseParams, growthRate: 0.15 });
      expect(highGrowth.intrinsicValue).toBeGreaterThan(lowGrowth.intrinsicValue);
    });

    it('subtracts net debt from equity value', () => {
      const lowDebt = dcfValuation({ ...baseParams, netDebt: 100 });
      const highDebt = dcfValuation({ ...baseParams, netDebt: 2000 });
      expect(highDebt.intrinsicValue).toBeLessThan(lowDebt.intrinsicValue);
    });

    it('handles zero/negative FCF by flooring intrinsic value at 0', () => {
      const zeroFcf = dcfValuation({ ...baseParams, lastFcf: 0 });
      const negativeFcf = dcfValuation({ ...baseParams, lastFcf: -1000 });
      expect(zeroFcf.intrinsicValue).toBe(0);
      expect(negativeFcf.intrinsicValue).toBe(0);
    });
  });

  describe('piotroskiScore', () => {
    it('returns 9 for perfect score', () => {
      const score = piotroskiScore({
        netIncome: 10,
        operatingCashFlow: 12,
        roa: 0.1,
        prevRoa: 0.05,
        longTermDebt: 80,
        prevLongTermDebt: 100,
        currentRatio: 2,
        prevCurrentRatio: 1.5,
        sharesOutstanding: 100,
        prevSharesOutstanding: 100,
        grossMargin: 0.5,
        prevGrossMargin: 0.4,
        assetTurnover: 1.2,
        prevAssetTurnover: 1.0,
      });

      expect(score).toBe(9);
    });

    it('returns 0 for worst case', () => {
      const score = piotroskiScore({
        netIncome: -1,
        operatingCashFlow: -2,
        roa: -0.1,
        prevRoa: 0.05,
        longTermDebt: 120,
        prevLongTermDebt: 100,
        currentRatio: 1.0,
        prevCurrentRatio: 1.5,
        sharesOutstanding: 110,
        prevSharesOutstanding: 100,
        grossMargin: 0.3,
        prevGrossMargin: 0.4,
        assetTurnover: 0.9,
        prevAssetTurnover: 1.0,
      });

      expect(score).toBe(0);
    });

    it('returns partial score correctly', () => {
      const score = piotroskiScore({
        netIncome: 10,
        operatingCashFlow: 5,
        roa: 0.1,
        prevRoa: 0.08,
        longTermDebt: 100,
        prevLongTermDebt: 100,
        currentRatio: 1.2,
        prevCurrentRatio: 1.0,
        sharesOutstanding: 101,
        prevSharesOutstanding: 100,
        grossMargin: 0.4,
        prevGrossMargin: 0.3,
        assetTurnover: 0.9,
        prevAssetTurnover: 1.0,
      });

      expect(score).toBe(6);
    });
  });

  describe('grahamNumber', () => {
    it('computes normal case', () => {
      expect(grahamNumber(10, 50)).toBeCloseTo(Math.sqrt(22.5 * 10 * 50), 10);
    });

    it('returns null for negative EPS or BVPS', () => {
      expect(grahamNumber(-1, 50)).toBeNull();
      expect(grahamNumber(10, -5)).toBeNull();
    });

    it('returns null for zero EPS or zero BVPS', () => {
      expect(grahamNumber(0, 50)).toBeNull();
      expect(grahamNumber(10, 0)).toBeNull();
    });
  });

  describe('sma', () => {
    it('computes 3-period SMA for known sequence', () => {
      expect(sma([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4]);
    });

    it('returns empty when period is longer than array', () => {
      expect(sma([1, 2], 3)).toEqual([]);
    });

    it('returns original values when period is 1', () => {
      expect(sma([5, 6, 7], 1)).toEqual([5, 6, 7]);
    });
  });

  describe('ema', () => {
    it('starts with SMA and then weights recent values', () => {
      const values = [1, 2, 3, 4, 5];
      const result = ema(values, 3);

      expect(result[0]).toBeCloseTo(2, 10);
      expect(result[1]).toBeCloseTo(3, 10);
      expect(result[2]).toBeCloseTo(4, 10);
      expect(result[2]).toBeGreaterThan(result[1]);
    });

    it('returns empty when period is longer than data', () => {
      expect(ema([1, 2], 5)).toEqual([]);
    });

    it('responds faster to latest move with shorter period', () => {
      const values = [10, 10, 10, 50];
      const short = ema(values, 2);
      const long = ema(values, 3);
      expect(short[short.length - 1]).toBeGreaterThan(long[long.length - 1]);
    });
  });

  describe('rsi', () => {
    it('detects overbought (>70) on rising prices', () => {
      const rising = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
      const values = rsi(rising, 5);
      expect(values.length).toBeGreaterThan(0);
      expect(values[values.length - 1]).toBeGreaterThan(70);
    });

    it('detects oversold (<30) on falling prices', () => {
      const falling = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
      const values = rsi(falling, 5);
      expect(values.length).toBeGreaterThan(0);
      expect(values[values.length - 1]).toBeLessThan(30);
    });

    it('returns empty when period is longer than available data', () => {
      expect(rsi([100, 101, 102], 14)).toEqual([]);
    });
  });

  describe('macd', () => {
    it('computes macdLine = fast EMA - slow EMA and expected array lengths', () => {
      const closes = Array.from({ length: 40 }, (_, i) => i + 1);
      const fastPeriod = 5;
      const slowPeriod = 8;
      const signalPeriod = 3;

      const { macdLine, signalLine, histogram } = macd(
        closes,
        fastPeriod,
        slowPeriod,
        signalPeriod
      );

      const fast = ema(closes, fastPeriod);
      const slow = ema(closes, slowPeriod);
      const offset = slowPeriod - fastPeriod;

      expect(macdLine.length).toBe(slow.length);
      for (let i = 0; i < macdLine.length; i++) {
        expect(macdLine[i]).toBeCloseTo(fast[i + offset] - slow[i], 10);
      }

      expect(signalLine.length).toBe(macdLine.length - signalPeriod + 1);
      expect(histogram.length).toBe(signalLine.length);
    });

    it('returns empty arrays when close history is insufficient', () => {
      const result = macd([1, 2, 3], 5, 8, 3);
      expect(result.macdLine).toEqual([]);
      expect(result.signalLine).toEqual([]);
      expect(result.histogram).toEqual([]);
    });

    it('satisfies histogram = macdLine offset - signalLine', () => {
      const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.3);
      const signalPeriod = 9;
      const { macdLine, signalLine, histogram } = macd(closes, 12, 26, signalPeriod);
      for (let i = 0; i < histogram.length; i++) {
        expect(histogram[i]).toBeCloseTo(macdLine[i + signalPeriod - 1] - signalLine[i], 10);
      }
    });
  });
});
