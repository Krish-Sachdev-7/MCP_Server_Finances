/**
 * Builds standardized responses optimized for LLM consumption.
 * Every tool response includes: summary, data, context, related_tools.
 */

export interface ToolResponse<T = unknown> {
  summary: string;
  data: T;
  context: {
    dataFreshness?: string;
    units?: Record<string, string>;
    period?: string;
    count?: number;
    ticker?: string;
    sector?: string;
    disclaimer?: string;
    [key: string]: unknown;
  };
  relatedTools: string[];
}

export function buildResponse<T>(params: {
  summary: string;
  data: T;
  context?: ToolResponse['context'];
  relatedTools?: string[];
}): string {
  const response: ToolResponse<T> = {
    summary: params.summary,
    data: params.data,
    context: params.context || {},
    relatedTools: params.relatedTools || [],
  };

  return JSON.stringify(response, null, 2);
}

export function buildErrorResponse(
  toolName: string,
  error: string,
  suggestion?: string
): string {
  return JSON.stringify({
    error: true,
    tool: toolName,
    message: error,
    suggestion: suggestion || 'Check the input parameters and try again.',
  });
}

/**
 * Normalizes a ticker symbol: uppercase, trimmed, strip exchange suffix.
 */
export function normalizeTicker(raw: string): string {
  let ticker = raw.trim().toUpperCase();
  // Remove .NS or .BO suffix if present
  if (ticker.endsWith('.NS') || ticker.endsWith('.BO')) {
    ticker = ticker.slice(0, -3);
  }
  return ticker;
}

/**
 * Formats a number in Indian notation (lakhs, crores).
 */
export function formatIndian(value: number): string {
  if (Math.abs(value) >= 10_000_000) {
    return `${(value / 10_000_000).toFixed(2)} Cr`;
  }
  if (Math.abs(value) >= 100_000) {
    return `${(value / 100_000).toFixed(2)} L`;
  }
  return value.toLocaleString('en-IN');
}

/**
 * Formats a percentage (0.15 → "15.00%").
 */
export function formatPercent(value: number | null): string {
  if (value === null || value === undefined) return 'N/A';
  return `${(value * 100).toFixed(2)}%`;
}
