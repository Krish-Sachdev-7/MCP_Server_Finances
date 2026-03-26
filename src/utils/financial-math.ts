/**
 * Financial calculation utilities.
 * All percentages returned as decimals (0.15 = 15%).
 */

export function cagr(
  beginValue: number,
  endValue: number,
  years: number
): number | null {
  if (beginValue <= 0 || endValue <= 0 || years <= 0) return null;
  return Math.pow(endValue / beginValue, 1 / years) - 1;
}

export function compoundedReturn(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  const last = values[values.length - 1];
  if (first <= 0) return null;
  return (last - first) / first;
}

/**
 * Simplified XIRR using Newton-Raphson method.
 * cashFlows: array of { amount: number, date: Date }
 * Returns annualized internal rate of return.
 */
export function xirr(
  cashFlows: { amount: number; date: Date }[]
): number | null {
  if (cashFlows.length < 2) return null;

  const days = cashFlows.map(
    (cf) =>
      (cf.date.getTime() - cashFlows[0].date.getTime()) / (365.25 * 86400000)
  );

  let rate = 0.1; // initial guess

  for (let iter = 0; iter < 100; iter++) {
    let f = 0;
    let df = 0;

    for (let i = 0; i < cashFlows.length; i++) {
      const pv = cashFlows[i].amount / Math.pow(1 + rate, days[i]);
      f += pv;
      df -= days[i] * cashFlows[i].amount / Math.pow(1 + rate, days[i] + 1);
    }

    if (Math.abs(f) < 1e-6) return rate;

    const newRate = rate - f / df;
    if (Math.abs(newRate - rate) < 1e-8) return newRate;
    rate = newRate;

    if (!isFinite(rate) || rate < -1) return null;
  }

  return rate;
}

/**
 * Discounted Cash Flow valuation.
 */
export function dcfValuation(params: {
  lastFcf: number;
  growthRate: number;
  discountRate: number;
  terminalGrowthRate: number;
  projectionYears: number;
  sharesOutstanding: number;
  netDebt: number;
}): {
  intrinsicValue: number;
  presentValueOfCashFlows: number;
  terminalValue: number;
  enterpriseValue: number;
} {
  const {
    lastFcf,
    growthRate,
    discountRate,
    terminalGrowthRate,
    projectionYears,
    sharesOutstanding,
    netDebt,
  } = params;

  let pvSum = 0;
  let projectedFcf = lastFcf;

  for (let year = 1; year <= projectionYears; year++) {
    projectedFcf *= 1 + growthRate;
    pvSum += projectedFcf / Math.pow(1 + discountRate, year);
  }

  // Terminal value using Gordon Growth Model
  const terminalFcf = projectedFcf * (1 + terminalGrowthRate);
  const terminalValue =
    terminalFcf / (discountRate - terminalGrowthRate);
  const pvTerminal =
    terminalValue / Math.pow(1 + discountRate, projectionYears);

  const enterpriseValue = pvSum + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  const intrinsicValue =
    sharesOutstanding > 0 ? equityValue / sharesOutstanding : 0;

  return {
    intrinsicValue: Math.max(0, intrinsicValue),
    presentValueOfCashFlows: pvSum,
    terminalValue: pvTerminal,
    enterpriseValue,
  };
}

/**
 * Piotroski F-Score (0-9).
 * Higher is better financial health.
 */
export function piotroskiScore(data: {
  netIncome: number;
  operatingCashFlow: number;
  roa: number;
  prevRoa: number;
  longTermDebt: number;
  prevLongTermDebt: number;
  currentRatio: number;
  prevCurrentRatio: number;
  sharesOutstanding: number;
  prevSharesOutstanding: number;
  grossMargin: number;
  prevGrossMargin: number;
  assetTurnover: number;
  prevAssetTurnover: number;
}): number {
  let score = 0;

  // Profitability
  if (data.netIncome > 0) score++;
  if (data.roa > 0) score++;
  if (data.operatingCashFlow > 0) score++;
  if (data.operatingCashFlow > data.netIncome) score++;

  // Leverage / liquidity
  if (data.longTermDebt <= data.prevLongTermDebt) score++;
  if (data.currentRatio > data.prevCurrentRatio) score++;
  if (data.sharesOutstanding <= data.prevSharesOutstanding) score++;

  // Operating efficiency
  if (data.grossMargin > data.prevGrossMargin) score++;
  if (data.assetTurnover > data.prevAssetTurnover) score++;

  return score;
}

/**
 * Graham Number = sqrt(22.5 * EPS * Book Value Per Share)
 */
export function grahamNumber(eps: number, bvps: number): number | null {
  if (eps <= 0 || bvps <= 0) return null;
  return Math.sqrt(22.5 * eps * bvps);
}

/**
 * Simple Moving Average
 */
export function sma(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += values[j];
    }
    result.push(sum / period);
  }
  return result;
}

/**
 * Exponential Moving Average
 */
export function ema(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const result: number[] = [];

  // Start with SMA for the first value
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  result.push(sum / period);

  for (let i = period; i < values.length; i++) {
    const val = (values[i] - result[result.length - 1]) * multiplier + result[result.length - 1];
    result.push(val);
  }

  return result;
}

/**
 * Relative Strength Index
 */
export function rsi(closes: number[], period = 14): number[] {
  const results: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  if (gains.length < period) return [];

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  results.push(100 - 100 / (1 + rs));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const currentRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    results.push(100 - 100 / (1 + currentRs));
  }

  return results;
}

/**
 * MACD (Moving Average Convergence Divergence)
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);
  const signalOffset = signalPeriod - 1;
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + signalOffset] - signalLine[i]);
  }

  return { macdLine, signalLine, histogram };
}
