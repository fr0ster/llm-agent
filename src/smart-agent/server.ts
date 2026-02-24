import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Message } from '../types.js';
import type { SmartAgent, StopReason } from './agent.js';
import type { CallOptions } from './interfaces/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SmartAgentServerConfig {
  port?: number; // default: 0 (OS-assigned)
  host?: string; // default: '127.0.0.1'
  requestTimeoutMs?: number; // optional per-request AbortSignal timeout
}

export interface SmartAgentServerHandle {
  port: number; // actual bound port (important when port: 0)
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: StopReason): 'stop' | 'length' {
  switch (r) {
    case 'stop':
      return 'stop';
    case 'iteration_limit':
      return 'length';
    case 'tool_call_limit':
      return 'length';
    default: {
      const _exhaustive: never = r;
      return 'stop';
    }
  }
}

function jsonError(message: string, type: string, code?: string): string {
  return JSON.stringify({
    error: { message, type, ...(code !== undefined ? { code } : {}) },
  });
}

// ---------------------------------------------------------------------------
// SmartAgentServer
// ---------------------------------------------------------------------------

export class SmartAgentServer {
  constructor(
    private readonly agent: SmartAgent,
    private readonly config: SmartAgentServerConfig = {},
  ) {}

  start(): Promise<SmartAgentServerHandle> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this._handleRequest(req, res).catch((err: unknown) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(jsonError(String(err), 'server_error'));
          }
        });
      });

      const port = this.config.port ?? 0;
      const host = this.config.host ?? '127.0.0.1';

      server.on('error', reject);
      server.listen(port, host, () => {
        const address = server.address();
        const actualPort =
          typeof address === 'object' && address !== null ? address.port : port;
        resolve({
          port: actualPort,
          close(): Promise<void> {
            return new Promise((resolveClose, rejectClose) => {
              server.close((err) => {
                if (err) rejectClose(err);
                else resolveClose();
              });
            });
          },
        });
      });
    });
  }

  private async _handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { method, url } = req;

    if (url !== '/v1/chat/completions') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(jsonError(`Cannot ${method} ${url}`, 'invalid_request_error'));
      return;
    }

    if (method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(`Method ${method} not allowed`, 'invalid_request_error'),
      );
      return;
    }

    const rawBody = await this._readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).messages)
    ) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'messages must be a non-empty array',
          'invalid_request_error',
        ),
      );
      return;
    }

    const body = parsed as {
      messages: Array<Message>;
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      stream?: boolean;
    };

    if (body.messages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'messages must be a non-empty array',
          'invalid_request_error',
        ),
      );
      return;
    }

    const hasUserMessage = body.messages.some((m) => m.role === 'user');
    if (!hasUserMessage) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'at least one message with role "user" is required',
          'invalid_request_error',
        ),
      );
      return;
    }

    let opts: CallOptions = {
      temperature: body.temperature,
      maxTokens: body.max_tokens,
      topP: body.top_p,
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (this.config.requestTimeoutMs) {
      const ctrl = new AbortController();
      timeoutId = setTimeout(() => ctrl.abort(), this.config.requestTimeoutMs);
      opts.signal = ctrl.signal;
    }

    try {
      const result = await this.agent.process(body.messages, opts);

      if (!result.ok) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(result.error.message, 'server_error', result.error.code),
        );
        return;
      }

      const response = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'smart-agent',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.value.content },
            finish_reason: mapStopReason(result.value.stopReason),
          },
        ],
        usage: {
          prompt_tokens: result.value.usage?.promptTokens ?? 0,
          completion_tokens: result.value.usage?.completionTokens ?? 0,
          total_tokens: result.value.usage?.totalTokens ?? 0,
        },
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private _readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}
