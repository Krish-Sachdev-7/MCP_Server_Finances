/**
 * Shared utilities for all ingestion pipelines.
 * - HTTP fetcher with exponential backoff retry
 * - Rate limiter per domain
 * - CSV parser helper
 * - Common types
 */

import { rootLogger } from '../middleware/logger.js';

const logger = rootLogger.child({ module: 'ingestion-utils' });

// ============================================================
// RATE LIMITER — per-domain sliding window
// ============================================================

const domainBuckets = new Map<string, number[]>();

/**
 * Simple in-memory rate limiter. Waits until the request can proceed
 * within the allowed requests-per-second for a given domain.
 */
export async function rateLimitedWait(domain: string, maxPerSecond: number): Promise<void> {
  const now = Date.now();
  const bucket = domainBuckets.get(domain) ?? [];

  // Remove timestamps older than 1 second
  const recent = bucket.filter((t) => now - t < 1000);

  if (recent.length >= maxPerSecond) {
    const oldestInWindow = recent[0];
    const waitMs = 1000 - (now - oldestInWindow) + 10; // +10ms buffer
    logger.debug({ domain, waitMs }, 'Rate limit wait');
    await sleep(waitMs);
  }

  recent.push(Date.now());
  domainBuckets.set(domain, recent);
}

// ============================================================
// HTTP FETCHER with retry + exponential backoff
// ============================================================

interface FetchOptions {
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
}

export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {}
): Promise<Response> {
  const { headers = {}, timeout = 30_000, retries = 3 } = options;
  const delays = [1000, 4000, 16000];

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json, text/csv, text/html, */*',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText} for ${url}`);
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        const delay = delays[attempt] ?? 16000;
        logger.warn(
          { url, attempt: attempt + 1, retries, delay, error: lastError.message },
          'Fetch failed, retrying'
        );
        await sleep(delay);
      }
    }
  }

  throw lastError ?? new Error(`All ${retries + 1} attempts failed for ${url}`);
}

export async function fetchJson<T = unknown>(url: string, options?: FetchOptions): Promise<T> {
  const response = await fetchWithRetry(url, options);
  return (await response.json()) as T;
}

export async function fetchText(url: string, options?: FetchOptions): Promise<string> {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

// ============================================================
// CSV PARSING (simple, no external dep)
// ============================================================

export function parseCSV(text: string, options?: { delimiter?: string }): Record<string, string>[] {
  const delimiter = options?.delimiter ?? ',';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = splitCSVLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] ?? '').trim();
    }
    rows.push(row);
  }

  return rows;
}

function splitCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ============================================================
// HELPERS
// ============================================================

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safely parse a numeric string, returning null if invalid */
export function safeNum(val: string | undefined | null): number | null {
  if (val === undefined || val === null || val === '' || val === '-') return null;
  const cleaned = val.replace(/,/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

/** Format a date as YYYY-MM-DD */
export function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Get date N days ago */
export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

/** Batch an array into chunks */
export function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
