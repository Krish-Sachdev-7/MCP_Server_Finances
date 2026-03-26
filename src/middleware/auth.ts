import { pino } from 'pino';

const logger = pino({ name: 'auth' });

let validKeys: Set<string> | null = null;

function loadKeys(): Set<string> {
  if (!validKeys) {
    const raw = process.env.EQUITY_MCP_API_KEYS || '';
    validKeys = new Set(raw.split(',').map((k) => k.trim()).filter(Boolean));
    logger.info({ keyCount: validKeys.size }, 'API keys loaded');
  }
  return validKeys;
}

export function validateApiKey(authHeader: string | undefined): {
  valid: boolean;
  clientId: string | null;
  error?: string;
} {
  // Skip auth in development mode
  if (process.env.NODE_ENV === 'development' && !process.env.EQUITY_MCP_API_KEYS) {
    return { valid: true, clientId: 'dev-client' };
  }

  if (!authHeader) {
    return { valid: false, clientId: null, error: 'Missing Authorization header' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return {
      valid: false,
      clientId: null,
      error: 'Authorization header must be: Bearer <api-key>',
    };
  }

  const key = parts[1];
  const keys = loadKeys();

  if (keys.has(key)) {
    // Use a hash of the key as the client ID for logging (don't log the actual key)
    const clientId = `client-${key.slice(0, 4)}...${key.slice(-4)}`;
    return { valid: true, clientId };
  }

  return { valid: false, clientId: null, error: 'Invalid API key' };
}

export function reloadKeys(): void {
  validKeys = null;
  loadKeys();
}
