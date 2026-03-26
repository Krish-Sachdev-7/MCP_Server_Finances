import { describe, expect, it } from 'vitest';
import {
  parseScreenConditions,
  validateSortColumn,
  validateSortOrder,
} from '../../src/utils/screen-parser';

describe('screen-parser utilities', () => {
  describe('parseScreenConditions', () => {
    it('parses a single condition into SQL and params', () => {
      const result = parseScreenConditions('PE > 20');
      expect(result.whereClause).toBe('r.pe_ratio > $1');
      expect(result.params).toEqual([20]);
      expect(result.errors).toEqual([]);
    });

    it('parses multiple conditions joined by AND', () => {
      const result = parseScreenConditions('PE > 20 AND debt to equity < 0.5');
      expect(result.whereClause).toBe('r.pe_ratio > $1 AND r.debt_to_equity < $2');
      expect(result.params).toEqual([20, 0.5]);
      expect(result.errors).toEqual([]);
    });

    it('auto-converts percentage fields from whole number to decimal', () => {
      const result = parseScreenConditions('ROE > 15');
      expect(result.whereClause).toBe('r.roe > $1');
      expect(result.params).toEqual([0.15]);
      expect(result.errors).toEqual([]);
    });

    it('keeps percentage field value unchanged when already decimal', () => {
      const result = parseScreenConditions('ROE > 0.15');
      expect(result.whereClause).toBe('r.roe > $1');
      expect(result.params).toEqual([0.15]);
      expect(result.errors).toEqual([]);
    });

    it('returns unknown field in errors array without throwing', () => {
      const result = parseScreenConditions('unknownfield > 10');
      expect(result.whereClause).toBe('');
      expect(result.params).toEqual([]);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Unknown field in condition');
    });

    it('returns descriptive error for missing operator', () => {
      const result = parseScreenConditions('PE 20');
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Missing operator in condition');
    });

    it('returns descriptive error for non-numeric value', () => {
      const result = parseScreenConditions('PE > abc');
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain('Invalid value in condition');
    });

    it('supports all operators: >, <, >=, <=, =, !=', () => {
      const cases = [
        ['PE > 20', 'r.pe_ratio > $1'],
        ['PE < 20', 'r.pe_ratio < $1'],
        ['PE >= 20', 'r.pe_ratio >= $1'],
        ['PE <= 20', 'r.pe_ratio <= $1'],
        ['PE = 20', 'r.pe_ratio = $1'],
        ['PE != 20', 'r.pe_ratio != $1'],
      ] as const;

      for (const [input, clause] of cases) {
        const result = parseScreenConditions(input);
        expect(result.errors).toEqual([]);
        expect(result.whereClause).toBe(clause);
        expect(result.params).toEqual([20]);
      }
    });

    it('maps field alias "return on equity" to same column as "roe"', () => {
      const fromAlias = parseScreenConditions('return on equity > 12');
      const fromShort = parseScreenConditions('roe > 12');
      expect(fromAlias.whereClause).toBe('r.roe > $1');
      expect(fromShort.whereClause).toBe('r.roe > $1');
      expect(fromAlias.params).toEqual([0.12]);
      expect(fromShort.params).toEqual([0.12]);
    });

    it('uses longest-match-first for overlapping aliases', () => {
      const result = parseScreenConditions('sales growth 10years > 12');
      expect(result.errors).toEqual([]);
      expect(result.whereClause).toBe('r.revenue_cagr_10y > $1');
      expect(result.params).toEqual([0.12]);
    });

    it('collects errors but still parses valid conditions in mixed input', () => {
      const result = parseScreenConditions('PE > 20 AND badfield > 10 AND ROE > 15');
      expect(result.whereClause).toBe('r.pe_ratio > $1 AND r.roe > $2');
      expect(result.params).toEqual([20, 0.15]);
      expect(result.errors.length).toBe(1);
    });

    it('parses case-insensitive AND and trims spacing', () => {
      const result = parseScreenConditions('  pe > 10   and   ROE >= 12  ');
      expect(result.errors).toEqual([]);
      expect(result.whereClause).toBe('r.pe_ratio > $1 AND r.roe >= $2');
      expect(result.params).toEqual([10, 0.12]);
    });
  });

  describe('validateSortColumn', () => {
    it('returns mapped SQL column for valid sort key', () => {
      expect(validateSortColumn('roe')).toBe('r.roe');
      expect(validateSortColumn('market_cap')).toBe('c.market_cap_cr');
    });

    it('returns default for invalid sort key', () => {
      expect(validateSortColumn('not_a_column')).toBe('c.market_cap_cr');
    });
  });

  describe('validateSortOrder', () => {
    it('returns ASC for asc/ASC and DESC otherwise', () => {
      expect(validateSortOrder('asc')).toBe('ASC');
      expect(validateSortOrder('ASC')).toBe('ASC');
      expect(validateSortOrder('descending')).toBe('DESC');
      expect(validateSortOrder('foo')).toBe('DESC');
    });
  });
});
