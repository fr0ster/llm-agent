/** Test helpers shared by the server-libs smart-agent tests (not a test file). */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { makeLlm as makeTestLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import type { BuildAgentDeps } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';

/** Every test here builds a real SmartServer; the seams are required now. */
export function makeLlmDeps(): Pick<
  BuildAgentDeps,
  'makeLlm' | 'resolveEmbedder'
> {
  return {
    ...constructionSeams,
    makeLlm: async (cfg) => ({
      ...makeTestLlm([{ content: 'ok' }]),
      model: cfg.model ?? 'stub',
    }),
  };
}

export function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr !== undefined
          ? { 'Content-Length': Buffer.byteLength(bodyStr) }
          : {}),
      },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

/** A promise the test settles. */
export function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A request whose body streams `raw`, as handleConfigUpdate reads it. */
export function jsonRequest(raw: string): IncomingMessage {
  return Readable.from([Buffer.from(raw)]) as unknown as IncomingMessage;
}

/** A response that records its status and body. */
export function recordingResponse(): {
  reply: { status?: number; body?: string };
  res: ServerResponse;
} {
  const reply: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      reply.status = status;
      return res;
    },
    end(text?: string) {
      reply.body = text;
    },
  } as unknown as ServerResponse;
  return { reply, res };
}
