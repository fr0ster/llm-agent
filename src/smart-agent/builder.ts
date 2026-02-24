/**
 * SmartAgentBuilder — fluent builder for SmartAgent.
 *
 * Wires together default implementations (DeepSeek LLM, Ollama/InMemory RAG,
 * MCP via HTTP or stdio) and allows overriding any component with a custom
 * implementation that satisfies the corresponding interface.
 *
 * Usage — all defaults:
 *   const { agent, getUsage, close } = await new SmartAgentBuilder({ llm: { apiKey } }).build();
 *
 * Usage — swap RAG and logger:
 *   const handle = await new SmartAgentBuilder({ llm: { apiKey } })
 *     .withRag({ facts: myRag, feedback: myRag, state: myRag })
 *     .withLogger(myLogger)
 *     .build();
 */

import { DeepSeekAgent } from '../agents/deepseek-agent.js';
import { DeepSeekProvider } from '../llm-providers/deepseek.js';
import { MCPClientWrapper } from '../mcp/client.js';
import { LlmAdapter } from './adapters/llm-adapter.js';
import { McpClientAdapter } from './adapters/mcp-client-adapter.js';
import { SmartAgent, type SmartAgentConfig, type SmartAgentRagStores } from './agent.js';
import { LlmClassifier, type LlmClassifierConfig } from './classifier/llm-classifier.js';
import { ContextAssembler, type ContextAssemblerConfig } from './context/context-assembler.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import type { ILogger } from './logger/types.js';
import type { IPromptInjectionDetector, IToolPolicy, SessionPolicy } from './policy/types.js';
import { OllamaEmbedder } from './rag/embedders/ollama-embedder.js';
import { OpenAIEmbedder } from './rag/embedders/openai-embedder.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { VectorRag } from './rag/vector-rag.js';
import { TokenCountingLlm, type TokenUsage } from './llm/token-counting-llm.js';

// ---------------------------------------------------------------------------
// Config types (builder-owned — no dependency on SmartServerConfig)
// ---------------------------------------------------------------------------

export interface BuilderLlmConfig {
  /** DeepSeek API key (required for default LLM) */
  apiKey: string;
  /** Default: 'deepseek-chat' */
  model?: string;
  /** Main LLM temperature. Default: 0.7 */
  temperature?: number;
  /** Classifier LLM temperature. Default: 0.1 */
  classifierTemperature?: number;
}

export interface BuilderRagConfig {
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

export interface BuilderMcpConfig {
  type: 'http' | 'stdio';
  /** HTTP: MCP endpoint URL */
  url?: string;
  /** stdio: command to spawn */
  command?: string;
  /** stdio: command arguments */
  args?: string[];
}

export interface BuilderPromptsConfig {
  /** Preamble prepended to the ContextAssembler system message. */
  system?: string;
  /** Override the intent-classifier system prompt. */
  classifier?: string;
  /**
   * System prompt used when translating non-ASCII user text to English for
   * cross-lingual RAG matching. Override to match your domain (e.g. SAP,
   * 3D printing, medical). Default: neutral translation instruction.
   */
  ragTranslation?: string;
  /**
   * Instruction appended to the system message when `debug.llmReasoning` is
   * true. Override to customise the reasoning format / tag names.
   */
  reasoning?: string;
}

export interface SmartAgentBuilderConfig {
  /** LLM credentials (required for default LLM factory). */
  llm: BuilderLlmConfig;
  /** RAG store config for default Ollama/InMemory stores. */
  rag?: BuilderRagConfig;
  /** MCP connection(s). Pass an array to connect multiple servers simultaneously. */
  mcp?: BuilderMcpConfig | BuilderMcpConfig[];
  /**
   * SmartAgent orchestration limits.
   * Includes `ragMinScore` to filter irrelevant tool facts from LLM context.
   */
  agent?: Partial<SmartAgentConfig>;
  /** System / classifier prompt overrides. */
  prompts?: BuilderPromptsConfig;
  /** Data governance policy for RAG records. */
  sessionPolicy?: SessionPolicy;
}

// ---------------------------------------------------------------------------
// Handle returned by build()
// ---------------------------------------------------------------------------

export interface SmartAgentHandle {
  /** The built and wired SmartAgent, ready to call .process(). */
  agent: SmartAgent;
  /**
   * Direct LLM chat — bypasses SmartAgent pipeline.
   * Used by SmartServer passthrough mode to forward the full message history.
   */
  chat: ILlm['chat'];
  /**
   * Returns accumulated LLM token usage (prompt + completion + total + requests).
   * Only counts calls made through the default DeepSeek LLM.
   * Returns zeroes if both mainLlm and classifierLlm were overridden.
   */
  getUsage(): TokenUsage;
  /** Gracefully close MCP connections. Call on shutdown. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SmartAgentBuilder
// ---------------------------------------------------------------------------

export class SmartAgentBuilder {
  private readonly cfg: SmartAgentBuilderConfig;

  // Custom overrides — when set, the corresponding default is not created
  private _mainLlm?: ILlm;
  private _classifierLlm?: ILlm;
  private _ragStores?: Partial<SmartAgentRagStores>;
  private _mcpClients?: IMcpClient[];
  private _classifier?: ISubpromptClassifier;
  private _assembler?: IContextAssembler;
  private _logger?: ILogger;
  private _toolPolicy?: IToolPolicy;
  private _injectionDetector?: IPromptInjectionDetector;

  constructor(cfg: SmartAgentBuilderConfig) {
    this.cfg = cfg;
  }

  // -------------------------------------------------------------------------
  // Fluent setters
  // -------------------------------------------------------------------------

  /** Override the main LLM used in the tool loop. */
  withMainLlm(llm: ILlm): this {
    this._mainLlm = llm;
    return this;
  }

  /** Override the LLM used by the intent classifier. */
  withClassifierLlm(llm: ILlm): this {
    this._classifierLlm = llm;
    return this;
  }

  /**
   * Override individual RAG stores. Unspecified stores use the default.
   * Pass the same instance for all three to share a single store.
   */
  withRag(stores: Partial<SmartAgentRagStores>): this {
    this._ragStores = { ...this._ragStores, ...stores };
    return this;
  }

  /**
   * Override MCP clients. When set, auto-connect and tool vectorization
   * are skipped — the caller is responsible for connecting clients.
   */
  withMcpClients(clients: IMcpClient[]): this {
    this._mcpClients = clients;
    return this;
  }

  /** Override the intent classifier. */
  withClassifier(classifier: ISubpromptClassifier): this {
    this._classifier = classifier;
    return this;
  }

  /** Override the context assembler. */
  withAssembler(assembler: IContextAssembler): this {
    this._assembler = assembler;
    return this;
  }

  /** Set a logger for internal pipeline events. */
  withLogger(logger: ILogger): this {
    this._logger = logger;
    return this;
  }

  /** Set a tool execution policy (allow/deny list). */
  withToolPolicy(policy: IToolPolicy): this {
    this._toolPolicy = policy;
    return this;
  }

  /** Set a prompt-injection detector. */
  withInjectionDetector(detector: IPromptInjectionDetector): this {
    this._injectionDetector = detector;
    return this;
  }

  // -------------------------------------------------------------------------
  // build()
  // -------------------------------------------------------------------------

  async build(): Promise<SmartAgentHandle> {
    const log = this._logger;

    // ---- Default LLM factory ---------------------------------------------
    const makeDefaultLlm = (temperature: number): TokenCountingLlm => {
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

    const defaultMainLlm = this._mainLlm ? null : makeDefaultLlm(this.cfg.llm.temperature ?? 0.7);
    const defaultClassifierLlm = this._classifierLlm ? null : makeDefaultLlm(this.cfg.llm.classifierTemperature ?? 0.1);

    const mainLlm: ILlm = this._mainLlm ?? defaultMainLlm!;
    const classifierLlm: ILlm = this._classifierLlm ?? defaultClassifierLlm!;

    // ---- Default RAG factory ---------------------------------------------
    const makeDefaultRag = (): IRag => {
      const r = this.cfg.rag;
      const provider = r?.provider ?? r?.type ?? 'ollama';

      if (provider === 'in-memory') {
        return new InMemoryRag({ dedupThreshold: r?.dedupThreshold });
      }

      if (provider === 'openai') {
        const embedder = new OpenAIEmbedder({
          apiKey: r?.apiKey ?? '',
          model: r?.model,
          timeoutMs: r?.timeoutMs,
        });
        return new VectorRag({ embedder, dedupThreshold: r?.dedupThreshold });
      }

      // ollama (default)
      const embedder = new OllamaEmbedder({
        url: r?.url,
        model: r?.model,
        timeoutMs: r?.timeoutMs,
      });
      return new VectorRag({ embedder, dedupThreshold: r?.dedupThreshold });
    };

    const factsRag: IRag = this._ragStores?.facts ?? makeDefaultRag();
    const feedbackRag: IRag = this._ragStores?.feedback ?? makeDefaultRag();
    const stateRag: IRag = this._ragStores?.state ?? makeDefaultRag();

    // Startup health check — non-fatal; logs a warning if embedder is unreachable
    for (const [name, rag] of [
      ['facts', factsRag],
      ['feedback', feedbackRag],
      ['state', stateRag],
    ] as const) {
      if (rag.checkHealth) {
        rag.checkHealth().catch((err: unknown) => {
          log?.log({
            type: 'pipeline_error',
            traceId: 'builder',
            code: 'EMBED_HEALTH_WARN',
            message: `${name} embedder unreachable: ${err}`,
            durationMs: 0,
          });
        });
      }
    }

    // ---- MCP clients + tool vectorization --------------------------------
    let mcpClients: IMcpClient[];
    const closeFns: Array<() => Promise<void>> = [];

    if (this._mcpClients) {
      // Caller-provided clients: skip auto-connect and vectorization
      mcpClients = this._mcpClients;
    } else {
      const mcpList = this.cfg.mcp
        ? (Array.isArray(this.cfg.mcp) ? this.cfg.mcp : [this.cfg.mcp])
        : [];
      const connected: IMcpClient[] = [];
      for (const mcpCfg of mcpList) {
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
          const adapter = new McpClientAdapter(wrapper);
          log?.log({ type: 'pipeline_done', traceId: 'builder', stopReason: 'stop', iterations: 0, toolCallCount: 0, durationMs: 0 });

          // Vectorize tools into factsRag for RAG-based tool selection
          const toolsResult = await adapter.listTools();
          if (toolsResult.ok) {
            for (const t of toolsResult.value) {
              await factsRag.upsert(
                `Tool: ${t.name}\nDescription: ${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`,
                { id: `tool:${t.name}` },
              );
            }
          }

          connected.push(adapter);
          closeFns.push(() => wrapper.disconnect?.() ?? Promise.resolve());
        } catch {
          // Skip failed MCP connections — agent continues without that server
        }
      }
      mcpClients = connected;
    }

    // ---- Classifier -------------------------------------------------------
    const classifierCfg: LlmClassifierConfig = {};
    if (this.cfg.prompts?.classifier) classifierCfg.systemPrompt = this.cfg.prompts.classifier;
    const classifier: ISubpromptClassifier = this._classifier ?? new LlmClassifier(classifierLlm, classifierCfg);

    // ---- Assembler --------------------------------------------------------
    const assemblerCfg: ContextAssemblerConfig = {};
    if (this.cfg.prompts?.system) assemblerCfg.systemPromptPreamble = this.cfg.prompts.system;
    const assembler: IContextAssembler = this._assembler ?? new ContextAssembler(assemblerCfg);

    // ---- SmartAgent -------------------------------------------------------
    const agentCfg: SmartAgentConfig = {
      maxIterations: 10,
      maxToolCalls: 30,
      ragQueryK: 10,
      ...this.cfg.agent,
      ...(this.cfg.sessionPolicy ? { sessionPolicy: this.cfg.sessionPolicy } : {}),
      ...(this.cfg.prompts?.ragTranslation ? { ragTranslationPrompt: this.cfg.prompts.ragTranslation } : {}),
      ...(this.cfg.prompts?.reasoning ? { reasoningPrompt: this.cfg.prompts.reasoning } : {}),
    };

    const agent = new SmartAgent(
      {
        mainLlm,
        mcpClients,
        ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
        classifier,
        assembler,
        ...(log ? { logger: log } : {}),
        ...(this._toolPolicy ? { toolPolicy: this._toolPolicy } : {}),
        ...(this._injectionDetector ? { injectionDetector: this._injectionDetector } : {}),
      },
      agentCfg,
    );

    return {
      agent,
      chat: (messages, tools, options) => mainLlm.chat(messages, tools, options),
      getUsage: () => {
        const main = defaultMainLlm?.getUsage() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
        const classifier = defaultClassifierLlm?.getUsage() ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, requests: 0 };
        return {
          prompt_tokens: main.prompt_tokens + classifier.prompt_tokens,
          completion_tokens: main.completion_tokens + classifier.completion_tokens,
          total_tokens: main.total_tokens + classifier.total_tokens,
          requests: main.requests + classifier.requests,
        };
      },
      close: async () => {
        for (const fn of closeFns) await fn();
      },
    };
  }
}
