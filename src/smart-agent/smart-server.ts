/**
 * SmartServer — embeddable OpenAI-compatible HTTP server backed by SmartAgent.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';

import type { Message } from '../types.js';
import type { SmartAgent, SmartAgentRagStores, StopReason } from './agent.js';
import { SmartAgentBuilder, type SmartAgentHandle } from './builder.js';
import type { TokenUsage } from './llm/token-counting-llm.js';
import { SessionLogger } from './logger/session-logger.js';
import type { ILogger } from './logger/types.js';
import {
  makeLlmFromProvider,
  makeRagFromStoreConfig,
  type PipelineConfig,
} from './pipeline.js';
import { normalizeExternalTools } from './utils/external-tools-normalizer.js';
import { toToolCallDelta } from './utils/tool-call-deltas.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SmartServerLlmConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  classifierTemperature?: number;
}

export interface SmartServerRagConfig {
  type?: 'ollama' | 'openai' | 'in-memory';
  url?: string;
  model?: string;
  dedupThreshold?: number;
  vectorWeight?: number;
  keywordWeight?: number;
}

export interface SmartServerMcpConfig {
  type: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
}

export interface SmartServerAgentConfig {
  maxIterations?: number;
  maxToolCalls?: number;
  ragQueryK?: number;
  showReasoning?: boolean;
  historyAutoSummarizeLimit?: number;
}

export interface SmartServerPromptsConfig {
  system?: string;
  classifier?: string;
  reasoning?: string;
  ragTranslate?: string;
  historySummary?: string;
}

export type SmartServerMode = 'hard' | 'pass' | 'smart';

export interface SmartServerConfig {
  port?: number;
  host?: string;
  llm: SmartServerLlmConfig;
  rag?: SmartServerRagConfig;
  mcp?: SmartServerMcpConfig;
  agent?: SmartServerAgentConfig;
  prompts?: SmartServerPromptsConfig;
  mode?: SmartServerMode;
  pipeline?: PipelineConfig;
  log?: (event: Record<string, unknown>) => void;
  logDir?: string;
}

export interface SmartServerHandle {
  port: number;
  close(): Promise<void>;
  getUsage(): TokenUsage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: StopReason): 'stop' | 'length' {
  return r === 'stop' ? 'stop' : 'length';
}

function jsonError(message: string, type: string, code?: string): string {
  return JSON.stringify({
    error: { message, type, ...(code ? { code } : {}) },
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// SmartServer
// ---------------------------------------------------------------------------

export {
  generateConfigTemplate,
  loadYamlConfig,
  type ResolveConfigArgs,
  resolveEnvVars,
  resolveSmartServerConfig,
  YAML_TEMPLATE,
  type YamlConfig,
} from './config.js';

export class SmartServer {
  private readonly cfg: SmartServerConfig;
  private readonly noop = () => {};

  constructor(config: SmartServerConfig) {
    this.cfg = config;
  }

  async start(): Promise<SmartServerHandle> {
    const log = this.cfg.log ?? this.noop;
    const fileLogger: ILogger = {
      log: (e) => log(e as unknown as Record<string, unknown>),
    };
    const pipeline = this.cfg.pipeline;

    let builder = new SmartAgentBuilder({
      llm: this.cfg.llm,
      rag: this.cfg.rag,
      mcp: pipeline?.mcp ?? this.cfg.mcp,
      agent: this.cfg.agent,
      prompts: this.cfg.prompts,
    }).withLogger(fileLogger);

    if (pipeline?.llm?.main) {
      const temp = pipeline.llm.main.temperature ?? 0.7;
      builder = builder.withMainLlm(
        makeLlmFromProvider(pipeline.llm.main, temp),
      );
      const classifierCfg = pipeline.llm.classifier ?? pipeline.llm.main;
      const classifierTemp = pipeline.llm.classifier?.temperature ?? 0.1;
      builder = builder.withClassifierLlm(
        makeLlmFromProvider(classifierCfg, classifierTemp),
      );
      if (pipeline.llm.helper) {
        const helperTemp = pipeline.llm.helper.temperature ?? 0.1;
        builder = builder.withHelperLlm(
          makeLlmFromProvider(pipeline.llm.helper, helperTemp),
        );
      }
    } else if (pipeline?.llm?.classifier) {
      const temp = pipeline.llm.classifier.temperature ?? 0.1;
      builder = builder.withClassifierLlm(
        makeLlmFromProvider(pipeline.llm.classifier, temp),
      );
    }
    if (pipeline?.rag) {
      const stores: Partial<SmartAgentRagStores> = {};
      if (pipeline.rag.facts)
        stores.facts = makeRagFromStoreConfig(pipeline.rag.facts);
      if (pipeline.rag.feedback)
        stores.feedback = makeRagFromStoreConfig(pipeline.rag.feedback);
      if (pipeline.rag.state)
        stores.state = makeRagFromStoreConfig(pipeline.rag.state);
      builder = builder.withRag(stores);
    }

    const agentHandle = await builder.build();
    const {
      agent: smartAgent,
      chat,
      streamChat,
      getUsage,
      close: closeAgent,
    } = agentHandle;

    // Run health check on startup
    smartAgent
      .healthCheck()
      .then((res) => {
        if (res.ok) {
          const v = res.value;
          const mcpStatus =
            v.mcp.length === 0
              ? 'NONE'
              : v.mcp.every((m) => m.ok)
                ? 'OK'
                : 'PARTIAL/FAIL';
          process.stderr.write(
            `[Health] LLM: ${v.llm ? 'OK' : 'FAIL'}, RAG: ${v.rag ? 'OK' : 'FAIL'}, MCP: ${mcpStatus}\n`,
          );
          v.mcp
            .filter((m) => !m.ok)
            .forEach((m) => {
              process.stderr.write(`  - MCP Error: ${m.error}\n`);
            });
        }
      })
      .catch((e) =>
        process.stderr.write(`[Health] Unexpected check error: ${e}\n`),
      );

    const server = http.createServer((req, res) =>
      this._handle(req, res, getUsage, smartAgent, chat, streamChat, log).catch(
        (err) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(jsonError(String(err), 'server_error'));
          }
        },
      ),
    );

    return new Promise((resolve, reject) => {
      const port = this.cfg.port ?? 4004;
      const host = this.cfg.host ?? '0.0.0.0';
      server.on('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort =
          typeof addr === 'object' && addr !== null ? addr.port : port;
        log({ event: 'server_started', port: actualPort, host });
        resolve({
          port: actualPort,
          close: async () => {
            await closeAgent();
            await new Promise<void>((res, rej) =>
              server.close((e) => (e ? rej(e) : res())),
            );
          },
          getUsage,
        });
      });
    });
  }

  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
  ): Promise<void> {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0].replace(/\/$/, '') || '/';
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    log({
      event: 'http_request',
      method: req.method,
      url: rawUrl,
      normalizedPath: urlPath,
    });

    if (
      req.method === 'GET' &&
      (urlPath === '/v1/models' || urlPath === '/models')
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'smart-agent',
              object: 'model',
              owned_by: 'smart-agent',
              context_window: 2000000,
            },
          ],
        }),
      );
      return;
    }
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getUsage()));
      return;
    }
    if (
      req.method === 'POST' &&
      (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')
    ) {
      await this._handleChat(
        req,
        res,
        getUsage,
        smartAgent,
        chat,
        streamChat,
        log,
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      jsonError(`Cannot ${req.method} ${urlPath}`, 'invalid_request_error'),
    );
  }

  private async _handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    _getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    _chat: SmartAgentHandle['chat'],
    _streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
  ): Promise<void> {
    const rawBody = await readBody(req);
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
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown[];
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    const externalTools = normalizeExternalTools(body.tools);

    const extractText = (c: unknown): string => {
      if (c === null || c === undefined) return '';
      if (typeof c === 'string') return c;
      if (!Array.isArray(c)) return '';
      return c
        .filter(
          (b): b is { type: 'text'; text: string } =>
            typeof b === 'object' &&
            b !== null &&
            (b as { type?: unknown }).type === 'text' &&
            typeof (b as { text?: unknown }).text === 'string',
        )
        .map((b) => b.text)
        .join('\n');
    };

    const userMessages = body.messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        jsonError(
          'at least one message with role "user" is required',
          'invalid_request_error',
        ),
      );
      return;
    }

    const traceId = randomUUID();
    const sessionId = (req.headers['x-session-id'] as string) || 'default';
    const sessionLogger = new SessionLogger(
      this.cfg.logDir || null,
      sessionId,
      traceId,
    );

    const t0 = Date.now();
    log({ event: 'request_start', stream: body.stream ?? false, traceId });

    const opts = {
      stream: body.stream,
      externalTools,
      trace: { traceId },
      sessionLogger,
    };

    const normalizedMessages = body.messages.map((m) => ({
      role: m.role as Message['role'],
      content: extractText(m.content),
    }));

    if (body.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);

      const stream = smartAgent.streamProcess(normalizedMessages, opts);
      let firstChunk = true;
      let lastUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;

      for await (const chunk of stream) {
        if (!chunk.ok) {
          res.write(
            `data: ${jsonError(chunk.error.message, 'server_error')}\n\n`,
          );
          break;
        }
        if (chunk.value.usage) {
          lastUsage = {
            prompt_tokens: chunk.value.usage.promptTokens,
            completion_tokens: chunk.value.usage.completionTokens,
            total_tokens: chunk.value.usage.totalTokens,
          };
        }
        const baseResponse = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: 'smart-agent',
          usage: null,
        };

        if (firstChunk) {
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: { role: 'assistant', content: chunk.value.content || '' }, finish_reason: null }] })}\n\n`,
          );
          firstChunk = false;
          if (!chunk.value.finishReason && !chunk.value.toolCalls) continue;
        }

        if (chunk.value.content || chunk.value.toolCalls) {
          const delta: Record<string, unknown> = {};
          if (chunk.value.content) delta.content = chunk.value.content;
          if (chunk.value.toolCalls) {
            delta.tool_calls = chunk.value.toolCalls.map((call, index) => {
              const tc = toToolCallDelta(call, index);
              return {
                index: tc.index,
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.name,
                  arguments: tc.arguments || '',
                },
              };
            });
          }
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
          );
        }

        if (chunk.value.finishReason) {
          res.write(
            `data: ${JSON.stringify({ ...baseResponse, choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(chunk.value.finishReason as StopReason) }] })}\n\n`,
          );
        }
      }

      if (body.stream_options?.include_usage && lastUsage) {
        res.write(
          `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [], usage: lastUsage })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const result = await smartAgent.process(normalizedMessages, opts);
    log({ event: 'request_done', ok: result.ok, durationMs: Date.now() - t0 });
    const finalContent = result.ok
      ? result.value.content || '(no response)'
      : `Error: ${result.error.message}`;
    const finalFinishReason = result.ok
      ? mapStopReason(result.value.stopReason)
      : 'stop';
    let finalUsage = null;
    if (result.ok && result.value.usage) {
      finalUsage = {
        prompt_tokens: result.value.usage.promptTokens,
        completion_tokens: result.value.usage.completionTokens,
        total_tokens: result.value.usage.totalTokens,
      };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'smart-agent',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: finalContent },
            finish_reason: finalFinishReason,
          },
        ],
        usage: finalUsage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      }),
    );
  }
}
