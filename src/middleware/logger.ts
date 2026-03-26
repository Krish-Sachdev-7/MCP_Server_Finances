import { pino } from 'pino';

export const rootLogger = pino({
  name: 'equity-mcp',
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export function logToolCall(params: {
  clientId: string;
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  status: 'success' | 'error';
  error?: string;
}): void {
  const { clientId, tool, args, durationMs, status, error } = params;

  if (status === 'error') {
    rootLogger.error({ clientId, tool, args, durationMs, error }, 'Tool call failed');
  } else {
    rootLogger.info({ clientId, tool, durationMs }, 'Tool call succeeded');
  }
}
