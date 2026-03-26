import { describe, expect, it } from 'vitest';
import {
  buildResponse,
  buildErrorResponse,
  normalizeTicker,
  formatIndian,
  formatPercent,
} from '../../src/utils/response-builder';

describe('response-builder utilities', () => {
  it('buildResponse returns valid JSON with summary/data/context/relatedTools', () => {
    const json = buildResponse({
      summary: 'ok',
      data: { value: 42 },
      context: { ticker: 'RELIANCE', count: 1 },
      relatedTools: ['company.lookup'],
    });

    const parsed = JSON.parse(json);
    expect(parsed.summary).toBe('ok');
    expect(parsed.data).toEqual({ value: 42 });
    expect(parsed.context).toEqual({ ticker: 'RELIANCE', count: 1 });
    expect(parsed.relatedTools).toEqual(['company.lookup']);
  });

  it('buildErrorResponse includes error/tool/message/suggestion', () => {
    const json = buildErrorResponse('valuation', 'Bad input', 'Use valid ticker');
    const parsed = JSON.parse(json);

    expect(parsed.error).toBe(true);
    expect(parsed.tool).toBe('valuation');
    expect(parsed.message).toBe('Bad input');
    expect(parsed.suggestion).toBe('Use valid ticker');
  });

  it('normalizeTicker trims, uppercases, and strips exchange suffix', () => {
    expect(normalizeTicker('reliance')).toBe('RELIANCE');
    expect(normalizeTicker('  TCS  ')).toBe('TCS');
    expect(normalizeTicker('INFY.NS')).toBe('INFY');
    expect(normalizeTicker('HDFCBANK.BO')).toBe('HDFCBANK');
  });

  it('formatIndian formats values as Cr, L, or locale format', () => {
    expect(formatIndian(25_000_000)).toBe('2.50 Cr');
    expect(formatIndian(250_000)).toBe('2.50 L');
    expect(formatIndian(12_345)).toBe('12,345');
  });

  it('formatPercent formats decimal to percent and null as N/A', () => {
    expect(formatPercent(0.15)).toBe('15.00%');
    expect(formatPercent(null)).toBe('N/A');
  });
});
