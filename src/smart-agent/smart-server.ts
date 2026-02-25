/**
 * SmartServer — embeddable OpenAI-compatible HTTP server backed by SmartAgent.
 *
 * Can be used standalone (via CLI) or embedded in any Node.js application:
 *
 *   const server = new SmartServer({ llm: { apiKey: 'sk-...' } });
 *   const { port, close } = await server.start();
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Message } from '../types.js';
import type { SmartAgent, SmartAgentRagStores, StopReason } from './agent.js';
import { SmartAgentBuilder, type SmartAgentHandle } from './builder.js';
import type { TokenUsage } from './llm/token-counting-llm.js';
import type { ILogger } from './logger/types.js';
import { SessionLogger } from './logger/session-logger.js';
import { makeLlmFromProvider, makeRagFromStoreConfig, type PipelineConfig } from './pipeline.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SmartServerLlmConfig {
  /** DeepSeek API key (required) */
  apiKey: string;
  /** Default: 'deepseek-chat' */
  model?: string;
  /** Main LLM temperature. Default: 0.7 */
  temperature?: number;
  /** Classifier LLM temperature. Default: 0.1 */
  classifierTemperature?: number;
}

export interface SmartServerRagConfig {
  /**
   * Embedding provider. Default: 'ollama'.
   * 'openai' requires `apiKey`. 'in-memory' uses bag-of-words (no network).
   */
  provider?: 'openai' | 'ollama' | 'in-memory';
  /**
   * Backward-compat alias for `provider`. If both are set, `provider` wins.
   * @deprecated Use `provider` instead.
   */
  type?: 'ollama' | 'in-memory';
  /** API key — required when `provider: openai`. */
  apiKey?: string;
  /** Embedder base URL. Default: 'http://localhost:11434' (Ollama). */
  url?: string;
  /** Embedding model name. */
  model?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Timeout for embed HTTP calls in ms. Default: 30 000 */
  timeoutMs?: number;
}

export interface SmartServerMcpConfig {
  type: 'http' | 'stdio';
  /** HTTP: MCP endpoint URL */
  url?: string;
  /** stdio: command to spawn */
  command?: string;
  /** stdio: command arguments */
  args?: string[];
}

export interface SmartServerAgentConfig {
  /** Max LLM iterations in tool loop. Default: 10 */
  maxIterations?: number;
  /** Max total tool calls. Default: 30 */
  maxToolCalls?: number;
  /** RAG results per query. Default: 10 */
  ragQueryK?: number;
  /**
   * Minimum cosine similarity score [0–1] for a RAG fact to be included in
   * the LLM context. Facts below this threshold — including tool descriptions
   * — are excluded. If no tool facts pass, the LLM receives NO tools and
   * answers freely. Default: 0 (no filtering).
   */
  ragMinScore?: number;
  /** Timeout for the entire request pipeline in ms. Unset = no timeout. */
  timeoutMs?: number;
}

export interface SmartServerDebugConfig {
  /**
   * When true, injects a reasoning instruction into the system prompt and
   * parses <thinking>/<reasoning> blocks from streamed text, re-emitting them
   * as `{ delta: { reasoning } }` SSE chunks. Default: false.
   */
  llmReasoning?: boolean;
  /**
   * Directory for per-session debug logs. When set, each client request gets
   * a sub-directory with an `events.ndjson` file that contains:
   *   - client_request  — full incoming message array
   *   - rag_translate, rag_query, tools_selected, llm_context — pipeline events
   *   - llm_request / llm_response — full LLM message context and responses
   *   - client_response — final content sent back to the client
   * Omit to disable session logging.
   */
  sessions?: string;
}

export interface SmartServerPromptsConfig {
  /**
   * Preamble prepended to the system message assembled by ContextAssembler.
   * Use it to give the agent a persona or domain instructions.
   */
  system?: string;
  /**
   * Override the intent-classifier system prompt.
   * Must instruct the LLM to return a JSON array of { type, text } objects.
   */
  classifier?: string;
  /**
   * System prompt used when translating non-ASCII user text to English for
   * cross-lingual RAG tool matching. Tailor it to your domain so ambiguous
   * words resolve correctly (e.g. add SAP / 3D-printing context).
   * Default: neutral translation instruction.
   */
  ragTranslation?: string;
  /**
   * Instruction appended to the system message when `debug.llmReasoning` is
   * enabled. Override to customise the reasoning tag format.
   */
  reasoning?: string;
}

/**
 * Request routing mode:
 * - `smart`      — all requests go through SmartAgent (RAG tool selection). Best for SAP/ABAP work.
 * - `passthrough` — all requests go directly to the LLM, no agent. Preserves client tool protocols.
 * - `hybrid`     — auto-detect: Cline client → passthrough, everything else → SmartAgent. Default.
 * - `hard`       — client system prompt and tools are ignored; SmartAgent builds everything from
 *                  the user message alone (strongest enrichment, maximum agent control).
 */
export type SmartServerMode = 'smart' | 'passthrough' | 'hybrid' | 'hard';

export interface SmartServerConfig {
  /** HTTP server port. Default: 3001 */
  port?: number;
  /** Bind host. Default: '0.0.0.0' */
  host?: string;
  /** LLM provider config (required) */
  llm: SmartServerLlmConfig;
  /** RAG / embeddings config. Default: ollama with nomic-embed-text */
  rag?: SmartServerRagConfig;
  /** MCP connection. If omitted, agent runs without tools */
  mcp?: SmartServerMcpConfig;
  /** SmartAgent orchestration config */
  agent?: SmartServerAgentConfig;
  /** Customise system / classifier prompts. */
  prompts?: SmartServerPromptsConfig;
  /**
   * Request routing mode. Default: 'hybrid'.
   * See SmartServerMode for details.
   */
  mode?: SmartServerMode;
  /**
   * Optional pipeline overrides. When present, takes precedence over the flat
   * llm / rag / mcp fields for the components it specifies.
   */
  pipeline?: PipelineConfig;
  /**
   * Debug / development flags.
   */
  debug?: SmartServerDebugConfig;
  /**
   * Log callback. Called for every internal event.
   * Default: no-op. CLI passes a file-writer or console-writer.
   */
  log?: (event: Record<string, unknown>) => void;
}

export interface SmartServerHandle {
  /** Actual bound port */
  port: number;
  /** Gracefully close the HTTP server and MCP connections */
  close(): Promise<void>;
  /** Accumulated LLM token usage (prompt + completion across all requests) */
  getUsage(): TokenUsage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(r: StopReason): 'stop' | 'length' {
  return r === 'stop' ? 'stop' : 'length';
}

function jsonError(message: string, type: string, code?: string): string {
  return JSON.stringify({ error: { message, type, ...(code ? { code } : {}) } });
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
  YAML_TEMPLATE,
  generateConfigTemplate,
  loadYamlConfig,
  resolveEnvVars,
  resolveSmartServerConfig,
  type ResolveConfigArgs,
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
    const fileLogger: ILogger = { log: (e) => log(e as unknown as Record<string, unknown>) };
    const sessionLogger = this.cfg.debug?.sessions
      ? new SessionLogger(this.cfg.debug.sessions)
      : null;
    const logger: ILogger = sessionLogger
      ? { log: (e) => { fileLogger.log(e); sessionLogger.log(e); } }
      : fileLogger;
    const pipeline = this.cfg.pipeline;

    // ---- Build SmartAgent via builder -------------------------------------
    // pipeline.mcp (if present) replaces the flat mcp field so that multiple
    // MCP servers can be connected simultaneously.
    let builder = new SmartAgentBuilder({
      llm: this.cfg.llm,
      rag: this.cfg.rag,
      mcp: pipeline?.mcp ?? this.cfg.mcp,
      agent: {
        ...this.cfg.agent,
        ...(this.cfg.debug?.llmReasoning ? { llmReasoning: true } : {}),
      },
      prompts: this.cfg.prompts,
    }).withLogger(logger);

    // Apply pipeline overrides — only the components explicitly specified
    if (pipeline?.llm?.main) {
      const temp = pipeline.llm.main.temperature ?? 0.7;
      builder = builder.withMainLlm(makeLlmFromProvider(pipeline.llm.main, temp));

      // If no explicit classifier, reuse main config at classifier temperature so
      // the builder never falls back to the (potentially absent) flat llm.apiKey.
      const classifierCfg = pipeline.llm.classifier ?? pipeline.llm.main;
      const classifierTemp = pipeline.llm.classifier?.temperature ?? 0.1;
      builder = builder.withClassifierLlm(makeLlmFromProvider(classifierCfg, classifierTemp));
    } else if (pipeline?.llm?.classifier) {
      // Classifier override without main override — unusual but valid
      const temp = pipeline.llm.classifier.temperature ?? 0.1;
      builder = builder.withClassifierLlm(makeLlmFromProvider(pipeline.llm.classifier, temp));
    }
    if (pipeline?.rag) {
      const stores: Partial<SmartAgentRagStores> = {};
      if (pipeline.rag.facts) stores.facts = makeRagFromStoreConfig(pipeline.rag.facts);
      if (pipeline.rag.feedback) stores.feedback = makeRagFromStoreConfig(pipeline.rag.feedback);
      if (pipeline.rag.state) stores.state = makeRagFromStoreConfig(pipeline.rag.state);
      builder = builder.withRag(stores);
    }

    const agentHandle = await builder.build();

    const { agent: smartAgent, chat, getUsage, close: closeAgent } = agentHandle;

    // ---- HTTP server -------------------------------------------------------
    const server = http.createServer((req, res) =>
      this._handle(req, res, getUsage, smartAgent, chat, log, logger).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(jsonError(String(err), 'server_error'));
        }
      }),
    );

    return new Promise((resolve, reject) => {
      const port = this.cfg.port ?? 3001;
      const host = this.cfg.host ?? '0.0.0.0';
      server.on('error', reject);
      server.listen(port, host, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        log({ event: 'server_started', port: actualPort, host });
        resolve({
          port: actualPort,
          close: async () => {
            await closeAgent();
            await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
          },
          getUsage,
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Request handler
  // -------------------------------------------------------------------------

  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    log: (e: Record<string, unknown>) => void,
    logger: ILogger,
  ): Promise<void> {
    const urlPath = req.url ?? '/';

    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    log({ event: 'http_request', method: req.method, url: urlPath });

    // GET /v1/models
    if (req.method === 'GET' && (urlPath === '/v1/models' || urlPath === '/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // context_window is intentionally large: smart-agent manages context via RAG,
      // so client-side context tracking is irrelevant.
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'smart-agent', object: 'model', owned_by: 'smart-agent', context_window: 2000000 }] }));
      return;
    }

    // GET /v1/usage
    if (req.method === 'GET' && urlPath === '/v1/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getUsage()));
      return;
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')) {
      await this._handleChat(req, res, getUsage, smartAgent, chat, log, logger);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(jsonError(`Cannot ${req.method} ${urlPath}`, 'invalid_request_error'));
  }

  private async _handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    log: (e: Record<string, unknown>) => void,
    logger: ILogger,
  ): Promise<void> {
    const rawBody = await readBody(req);

    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Record<string, unknown>).messages)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('messages must be a non-empty array', 'invalid_request_error'));
      return;
    }

    type ContentBlock = { type: string; text?: string };
    type MsgContent = string | ContentBlock[] | null;
    type BodyMessage = {
      role: string;
      content: MsgContent;
      /** Present on assistant messages that requested tool calls */
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      /** Present on tool result messages */
      tool_call_id?: string;
    };
    const body = parsed as {
      messages: Array<BodyMessage>;
      tools?: Array<{ type?: string; function?: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };

    // content may be null in assistant messages that only carry tool_calls
    const extractText = (c: MsgContent): string => {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      return c.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('\n');
    };

    // Preserve tool_calls / tool_call_id so conversation history stays intact
    // across multi-turn tool exchanges (smart / passthrough modes).
    const normalizeMessage = (m: BodyMessage): Message => {
      const msg: Message = {
        role: m.role as Message['role'],
        content: extractText(m.content),
      };
      if (m.tool_calls?.length) {
        msg.tool_calls = m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: tc.function,
        }));
      }
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    };

    const userMessages = body.messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('at least one message with role "user" is required', 'invalid_request_error'));
      return;
    }

    // Request ID — used for session logging and agent traceId correlation.
    const requestId = randomUUID();

    // Resolve effective routing mode
    const serverMode = this.cfg.mode ?? 'hybrid';
    const systemText = (() => {
      const systemMsg = body.messages.find((m) => m.role === 'system');
      return systemMsg ? extractText(systemMsg.content) : '';
    })();

    const isCline = serverMode === 'hybrid' && systemText.trimStart().startsWith('You are Cline');
    const usePass = serverMode === 'passthrough' || isCline;
    const useHard = serverMode === 'hard';
    const useSmart = serverMode === 'smart' || (serverMode === 'hybrid' && !isCline);

    const effectiveMode = usePass ? 'passthrough' : useHard ? 'hard' : 'smart';

    const t0 = Date.now();
    log({ event: 'request_start', mode: effectiveMode, serverMode, stream: body.stream ?? false });

    // Log full client request for session debugging.
    logger.log({
      type: 'client_request',
      traceId: requestId,
      messages: body.messages.map((m) => ({ role: m.role, content: extractText(m.content) })),
    });

    // Single AbortController handles client disconnect for all paths.
    const abortCtrl = new AbortController();
    req.on('close', () => abortCtrl.abort());

    // Parse client tools from the request body (used by smart mode)
    const clientTools: import('./interfaces/types.js').LlmTool[] = (body.tools ?? [])
      .filter((t) => t.function?.name)
      .map((t) => ({
        // biome-ignore lint/style/noNonNullAssertion: guarded by filter above
        name: t.function!.name,
        description: t.function?.description ?? '',
        inputSchema: (t.function?.parameters ?? {}) as Record<string, unknown>,
      }));

    let finalContent = '';
    if (usePass) {
      // Passthrough: full message history + client tools → LLM directly.
      // Tool calls in the response are forwarded to the client as OpenAI SSE
      // so the client (Cline, Goose) can execute them and continue the conversation.
      const normalizedMessages = body.messages.map(normalizeMessage);
      const llmResult = await chat(
        normalizedMessages,
        clientTools.length > 0 ? clientTools : undefined,
        { signal: abortCtrl.signal },
      );
      log({ event: 'request_done', mode: 'passthrough', ok: llmResult.ok, durationMs: Date.now() - t0 });

      const passToolCalls = llmResult.ok ? llmResult.value.toolCalls : undefined;
      finalContent = llmResult.ok ? (llmResult.value.content || '') : `Error: ${llmResult.error.message}`;

      if (body.stream === true && passToolCalls?.length) {
        // Streaming passthrough with tool_calls: send SSE and forward tool calls.
        const ptId = `chatcmpl-${randomUUID()}`;
        const ptCreated = Math.floor(Date.now() / 1000);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const sendPt = (data: unknown) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
        if (finalContent) {
          sendPt({ id: ptId, object: 'chat.completion.chunk', created: ptCreated, model: 'smart-agent', choices: [{ index: 0, delta: { content: finalContent }, finish_reason: null }] });
        }
        sendPt({ id: ptId, object: 'chat.completion.chunk', created: ptCreated, model: 'smart-agent', choices: [{ index: 0, delta: { tool_calls: passToolCalls.map((tc, idx) => ({ index: idx, id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }, finish_reason: null }] });
        sendPt({ id: ptId, object: 'chat.completion.chunk', created: ptCreated, model: 'smart-agent', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        if (body.stream_options?.include_usage) {
          const u = getUsage();
          sendPt({ id: ptId, object: 'chat.completion.chunk', created: ptCreated, model: 'smart-agent', choices: [], usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens } });
        }
        if (!res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
      } else {
        const finalFinishReason: 'stop' | 'length' = llmResult.ok && llmResult.value.finishReason === 'length' ? 'length' : 'stop';
        this._sendResponse(res, body.stream ?? false, body.stream_options?.include_usage ?? false, getUsage, finalContent || '(no response)', finalFinishReason);
      }
    } else if (useHard) {
      // Hard mode: client system prompt and tools ignored; agent builds everything from user text.
      const text = extractText(userMessages[userMessages.length - 1].content);
      if (body.stream === true) {
        finalContent = await this._handleSmartStream(res, smartAgent, text, undefined, undefined, { trace: { traceId: requestId }, signal: abortCtrl.signal }, log, t0, body.stream_options?.include_usage ?? false, getUsage);
      } else {
        const result = await smartAgent.process(text, { trace: { traceId: requestId }, signal: abortCtrl.signal });
        log({ event: 'request_done', mode: 'hard', ok: result.ok, durationMs: Date.now() - t0 });
        finalContent = result.ok ? (result.value.content || '(no response)') : `Error: ${result.error.message}`;
        const finalFinishReason: 'stop' | 'length' = result.ok ? mapStopReason(result.value.stopReason) : 'stop';
        this._sendResponse(res, false, body.stream_options?.include_usage ?? false, getUsage, finalContent, finalFinishReason);
      }
    } else if (useSmart) {
      // Smart mode: preserve client history + tools; augment with RAG context.
      const text = extractText(userMessages[userMessages.length - 1].content);
      const normalizedMessages: Message[] = body.messages.map(normalizeMessage);
      if (body.stream === true) {
        finalContent = await this._handleSmartStream(res, smartAgent, text, normalizedMessages, clientTools, { trace: { traceId: requestId }, signal: abortCtrl.signal }, log, t0, body.stream_options?.include_usage ?? false, getUsage);
      } else {
        // Non-streaming smart mode: use process() with hard fallback (clientMessages not supported by process())
        const result = await smartAgent.process(text, { trace: { traceId: requestId }, signal: abortCtrl.signal });
        log({ event: 'request_done', mode: 'smart', ok: result.ok, durationMs: Date.now() - t0 });
        finalContent = result.ok ? (result.value.content || '(no response)') : `Error: ${result.error.message}`;
        const finalFinishReason: 'stop' | 'length' = result.ok ? mapStopReason(result.value.stopReason) : 'stop';
        this._sendResponse(res, false, body.stream_options?.include_usage ?? false, getUsage, finalContent, finalFinishReason);
      }
    } else {
      // Unreachable fallback
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(jsonError('Unknown routing mode', 'server_error'));
      return;
    }

    // Log final response for session debugging.
    logger.log({
      type: 'client_response',
      traceId: requestId,
      content: finalContent,
      durationMs: Date.now() - t0,
    });
  }

  /** Returns the accumulated text content sent to the client. */
  private async _handleSmartStream(
    res: ServerResponse,
    smartAgent: SmartAgent,
    text: string,
    clientMessages: Message[] | undefined,
    clientTools: import('./interfaces/types.js').LlmTool[] | undefined,
    opts: import('./interfaces/types.js').CallOptions,
    log: (e: Record<string, unknown>) => void,
    t0: number,
    includeUsage: boolean,
    getUsage: () => TokenUsage,
  ): Promise<string> {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const sendEvent = (data: unknown): void => {
      if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const streamOpts = clientMessages
      ? { ...opts, clientMessages, ...(clientTools ? { clientTools } : {}) }
      : opts;

    let ok = true;
    let accumulated = '';
    try {
      for await (const chunk of smartAgent.processStream(text, streamOpts)) {
        if (chunk.type === 'text') {
          accumulated += chunk.delta;
          sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }] });
        } else if (chunk.type === 'reasoning') {
          sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [{ index: 0, delta: { reasoning: chunk.delta }, finish_reason: null }] });
        } else if (chunk.type === 'usage') {
          sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [], usage: { prompt_tokens: chunk.promptTokens, completion_tokens: chunk.completionTokens, total_tokens: chunk.promptTokens + chunk.completionTokens } });
        } else if (chunk.type === 'client_tool_calls') {
          // Forward client tool calls to the caller in OpenAI streaming format.
          // The client (Goose / Cline) will execute them and continue the conversation.
          sendEvent({
            id,
            object: 'chat.completion.chunk',
            created,
            model: 'smart-agent',
            choices: [{
              index: 0,
              delta: {
                tool_calls: chunk.toolCalls.map((tc, idx) => ({
                  index: idx,
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              },
              finish_reason: null,
            }],
          });
        } else if (chunk.type === 'done') {
          const finishReason: 'stop' | 'length' | 'tool_calls' =
            chunk.finishReason === 'length' ? 'length' :
            chunk.finishReason === 'tool_calls' ? 'tool_calls' : 'stop';
          sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
        }
        // Internal tool_calls chunks (agent MCP) are handled by SmartAgent — skip.
      }
    } catch {
      ok = false;
      sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }

    if (includeUsage) {
      const u = getUsage();
      sendEvent({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [], usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens } });
    }

    log({ event: 'request_done', mode: 'smart', ok, durationMs: Date.now() - t0 });

    if (!res.destroyed) {
      res.write('data: [DONE]\n\n');
      res.end();
    }

    return accumulated;
  }

  private _sendResponse(
    res: ServerResponse,
    stream: boolean,
    includeUsage: boolean,
    getUsage: () => TokenUsage,
    content: string,
    finishReason: 'stop' | 'length',
  ): void {
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });

      const chunk = (delta: Record<string, unknown>, fr: string | null) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [{ index: 0, delta, logprobs: null, finish_reason: fr }] })}\n\n`;

      res.write(chunk({ role: 'assistant', content: '' }, null));
      res.write(chunk({ content }, null));
      res.write(chunk({}, finishReason));

      if (includeUsage) {
        const u = getUsage();
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'smart-agent', choices: [], usage: { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens, total_tokens: u.total_tokens } })}\n\n`);
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created, model: 'smart-agent', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
    }
  }
}
