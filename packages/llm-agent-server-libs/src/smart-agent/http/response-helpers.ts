/**
 * Pure HTTP response helpers shared by SmartServer's route handlers.
 *
 * Relocated verbatim from `smart-server.ts` so the route table and the
 * SmartServer methods can share them without duplicating logic. Behaviour is
 * byte-identical to the originals; `smart-server.ts` re-exports them so import
 * paths stay stable.
 */

import type { IncomingMessage } from 'node:http';
import type { ExternalToolValidationCode } from '@mcp-abap-adt/llm-agent';
import type { StopReason } from '@mcp-abap-adt/llm-agent-libs';

export function mapStopReason(r: StopReason): 'stop' | 'length' | 'tool_calls' {
  if (r === 'stop') return 'stop';
  if (r === 'tool_calls') return 'tool_calls';
  return 'length';
}

export function jsonError(
  message: string,
  type: string,
  code?: string,
): string {
  return JSON.stringify({
    error: { message, type, ...(code ? { code } : {}) },
  });
}

export function jsonValidationError(
  message: string,
  code: ExternalToolValidationCode,
  param: string,
): string {
  return JSON.stringify({
    error: {
      message,
      type: 'invalid_request_error',
      code,
      param,
    },
  });
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Pre-dispatch readiness gate response: HTTP 503 with an OpenAI-shaped error,
 * written BEFORE any pipeline run or SSE stream is opened. Used when the server is
 * NOT_READY (MCP unavailable) so a request fails loud instead of being served
 * tool-blind / returning a silent "(no response)".
 */
export function writeNotReady(res: {
  writeHead(code: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}): void {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        type: 'service_unavailable',
        message: 'MCP unavailable — server not ready',
      },
    }),
  );
}
