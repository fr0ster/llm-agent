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

import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { MCPClientWrapper } from '../mcp/client.js';
import type { Message } from '../types.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { McpClientAdapter } from './adapters/mcp-client-adapter.js';
import { SmartAgent } from './agent.js';
import type { StopReason } from './agent.js';
import { LlmClassifier } from './classifier/llm-classifier.js';
import { ContextAssembler } from './context/context-assembler.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
import type { ILogger } from './logger/types.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaRag } from './rag/ollama-rag.js';

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
  /** 'ollama' uses real neural embeddings; 'in-memory' uses bag-of-words. Default: 'ollama' */
  type?: 'ollama' | 'in-memory';
  /** Ollama base URL. Default: 'http://localhost:11434' */
  url?: string;
  /** Ollama embedding model. Default: 'nomic-embed-text' */
  model?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
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
  /** RAG results per query. Default: 5 */
  ragQueryK?: number;
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
}

/**
 * Request routing mode:
 * - `smart`      — all requests go through SmartAgent (RAG tool selection). Best for SAP/ABAP work.
 * - `passthrough` — all requests go directly to the LLM, no agent. Preserves client tool protocols.
 * - `hybrid`     — auto-detect: Cline client → passthrough, everything else → SmartAgent. Default.
 */
export type SmartServerMode = 'smart' | 'passthrough' | 'hybrid';

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
   * Log callback. Called for every internal event.
   * Default: no-op. CLI passes a file-writer or console-writer.
   */
  log?: (event: Record<string, unknown>) => void;
}

export interface SmartServerHandle {
  /** Actual bound port */
  port: number;
  /** Gracefully close the HTTP server */
  close(): Promise<void>;
  /** Accumulated LLM token usage */
  getUsage(): { prompt_tokens: number; completion_tokens: number; total_tokens: number; requests: number };
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

    // ---- RAG stores --------------------------------------------------------
    const ragFactory = () => {
      const r = this.cfg.rag;
      if (!r || r.type === 'ollama') {
        return new OllamaRag({
          ollamaUrl: r?.url,
          model: r?.model,
          dedupThreshold: r?.dedupThreshold,
        });
      }
      return new InMemoryRag({ dedupThreshold: r.dedupThreshold });
    };
    const factsRag = ragFactory();
    const feedbackRag = ragFactory();
    const stateRag = ragFactory();

    // ---- LLM factory -------------------------------------------------------
    const makeLlm = (temperature: number): TokenCountingLlm => {
      const provider = new DeepSeekProvider({
        apiKey: this.cfg.llm.apiKey,
        model: this.cfg.llm.model ?? 'deepseek-chat',
        temperature,
      });
      const dummyMcp = new MCPClientWrapper({
        transport: 'embedded',
        listToolsHandler: async () => [],
      });
      const agent = new DeepSeekAgent({ llmProvider: provider, mcpClient: dummyMcp });
      return new TokenCountingLlm(new LlmAdapter(agent));
    };

    const mainLlm = makeLlm(this.cfg.llm.temperature ?? 0.7);
    const classifierLlm = makeLlm(this.cfg.llm.classifierTemperature ?? 0.1);

    // ---- MCP ---------------------------------------------------------------
    let mcpAdapter: McpClientAdapter | null = null;
    const mcpCfg = this.cfg.mcp;
    if (mcpCfg) {
      try {
        let wrapper: MCPClientWrapper;
        if (mcpCfg.type === 'stdio') {
          wrapper = new MCPClientWrapper({
            transport: 'stdio',
            command: mcpCfg.command,
            args: mcpCfg.args ?? [],
          });
        } else {
          wrapper = new MCPClientWrapper({ transport: 'auto', url: mcpCfg.url });
        }
        await wrapper.connect();
        mcpAdapter = new McpClientAdapter(wrapper);
        log({ event: 'mcp_connected', type: mcpCfg.type });

        // Vectorize tools at startup
        const toolsResult = await mcpAdapter.listTools();
        if (toolsResult.ok) {
          for (const t of toolsResult.value) {
            await factsRag.upsert(
              `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`,
              { id: `tool:${t.name}` },
            );
          }
          log({ event: 'tools_vectorized', count: toolsResult.value.length });
        }
      } catch (err) {
        log({ event: 'mcp_connect_failed', error: String(err) });
      }
    }

    // ---- SmartAgent --------------------------------------------------------
    const fileLogger: ILogger = { log: (e) => log(e as unknown as Record<string, unknown>) };
    const agentCfg = this.cfg.agent ?? {};

    const promptsCfg = this.cfg.prompts ?? {};

    const smartAgent = new SmartAgent(
      {
        mainLlm,
        mcpClients: mcpAdapter ? [mcpAdapter] : [],
        ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
        classifier: new LlmClassifier(classifierLlm, {
          ...(promptsCfg.classifier ? { systemPrompt: promptsCfg.classifier } : {}),
        }),
        assembler: new ContextAssembler({
          ...(promptsCfg.system ? { systemPromptPreamble: promptsCfg.system } : {}),
        }),
        logger: fileLogger,
      },
      {
        maxIterations: agentCfg.maxIterations ?? 10,
        maxToolCalls: agentCfg.maxToolCalls ?? 30,
        ragQueryK: agentCfg.ragQueryK ?? 5,
      },
    );

    // ---- HTTP server -------------------------------------------------------
    const server = http.createServer((req, res) =>
      this._handle(req, res, mainLlm, smartAgent, log).catch((err) => {
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
          close: () =>
            new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
          getUsage: () => mainLlm.getUsage(),
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
    mainLlm: TokenCountingLlm,
    smartAgent: SmartAgent,
    log: (e: Record<string, unknown>) => void,
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
      res.end(JSON.stringify(mainLlm.getUsage()));
      return;
    }

    // POST /v1/chat/completions
    if (req.method === 'POST' && (urlPath === '/v1/chat/completions' || urlPath === '/chat/completions')) {
      await this._handleChat(req, res, mainLlm, smartAgent, log);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(jsonError(`Cannot ${req.method} ${urlPath}`, 'invalid_request_error'));
  }

  private async _handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    mainLlm: TokenCountingLlm,
    smartAgent: SmartAgent,
    log: (e: Record<string, unknown>) => void,
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
    type MsgContent = string | ContentBlock[];
    const body = parsed as {
      messages: Array<{ role: string; content: MsgContent }>;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };

    const extractText = (c: MsgContent): string => {
      if (typeof c === 'string') return c;
      return c.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('\n');
    };

    const userMessages = body.messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('at least one message with role "user" is required', 'invalid_request_error'));
      return;
    }

    // Resolve effective routing mode
    const serverMode = this.cfg.mode ?? 'hybrid';
    const isCline =
      serverMode === 'hybrid' &&
      (() => {
        const systemMsg = body.messages.find((m) => m.role === 'system');
        return typeof systemMsg?.content === 'string' && systemMsg.content.trimStart().startsWith('You are Cline');
      })();
    const usePassthrough = serverMode === 'passthrough' || isCline;

    const t0 = Date.now();
    log({ event: 'request_start', mode: usePassthrough ? 'passthrough' : 'smart', serverMode, stream: body.stream ?? false });

    let finalContent: string;
    let finalFinishReason: 'stop' | 'length';

    if (usePassthrough) {
      // Passthrough: full message history → LLM directly. Preserves client tool protocols (e.g. Cline XML).
      const normalizedMessages = body.messages.map((m) => ({
        role: m.role as Message['role'],
        content: extractText(m.content),
      }));
      const llmResult = await mainLlm.chat(normalizedMessages);
      log({ event: 'request_done', mode: 'passthrough', ok: llmResult.ok, durationMs: Date.now() - t0 });
      finalContent = llmResult.ok ? (llmResult.value.content || '(no response)') : `Error: ${llmResult.error.message}`;
      finalFinishReason = llmResult.ok && llmResult.value.finishReason === 'length' ? 'length' : 'stop';
    } else {
      // SmartAgent: classify + RAG tool selection + MCP orchestration — use the LAST user message
      const text = extractText(userMessages[userMessages.length - 1].content);
      const result = await smartAgent.process(text);
      log({ event: 'request_done', mode: 'smart', ok: result.ok, durationMs: Date.now() - t0 });
      finalContent = result.ok ? (result.value.content || '(no response)') : `Error: ${result.error.message}`;
      finalFinishReason = result.ok ? mapStopReason(result.value.stopReason) : 'stop';
    }

    this._sendResponse(res, body.stream ?? false, body.stream_options?.include_usage ?? false, mainLlm, finalContent, finalFinishReason);
  }

  private _sendResponse(
    res: ServerResponse,
    stream: boolean,
    includeUsage: boolean,
    mainLlm: TokenCountingLlm,
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
        const u = mainLlm.getUsage();
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
