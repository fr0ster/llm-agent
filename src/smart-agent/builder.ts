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
import {
  SmartAgent,
  type SmartAgentConfig,
  type SmartAgentRagStores,
} from './agent.js';
import {
  LlmClassifier,
  type LlmClassifierConfig,
} from './classifier/llm-classifier.js';
import {
  ContextAssembler,
  type ContextAssemblerConfig,
} from './context/context-assembler.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import { TokenCountingLlm, type TokenUsage } from './llm/token-counting-llm.js';
import type { ILogger } from './logger/types.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { InMemoryRag } from './rag/in-memory-rag.js';
import { OllamaRag } from './rag/ollama-rag.js';
import type { ITracer } from './tracer/types.js';

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
  /** 'ollama' | 'openai' | 'in-memory'. Default: 'ollama' */
  type?: 'ollama' | 'openai' | 'in-memory';
  /** Base URL for embedding service */
  url?: string;
  /** API key (for openai type) */
  apiKey?: string;
  /** Embedding model name */
  model?: string;
  /** Cosine similarity dedup threshold. Default: 0.92 */
  dedupThreshold?: number;
  /** Per-request timeout for embedding calls in milliseconds. Default: 30 000 */
  timeoutMs?: number;
  /** Semantic similarity weight 0..1. Default: 0.7 */
  vectorWeight?: number;
  /** Lexical matching weight 0..1. Default: 0.3 */
  keywordWeight?: number;
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
  /** Instruction for the reasoning/strategy block. */
  reasoning?: string;
  /** Prompt for query translation for RAG. */
  ragTranslate?: string;
  /** Prompt for history summarization. */
  historySummary?: string;
}

export interface SmartAgentBuilderConfig {
  /** LLM credentials (required for default LLM factory). */
  llm: BuilderLlmConfig;
  /** RAG store config for default Ollama/InMemory stores. */
  rag?: BuilderRagConfig;
  /** MCP connection(s). Pass an array to connect multiple servers simultaneously. */
  mcp?: BuilderMcpConfig | BuilderMcpConfig[];
  /** SmartAgent orchestration limits. */
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
  /** Direct LLM streaming chat. */
  streamChat: ILlm['streamChat'];
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
  private _helperLlm?: ILlm;
  private _classifierLlm?: ILlm;
  private _ragStores?: Partial<SmartAgentRagStores>;
  private _mcpClients?: IMcpClient[];
  private _classifier?: ISubpromptClassifier;
  private _assembler?: IContextAssembler;
  private _logger?: ILogger;
  private _toolPolicy?: IToolPolicy;
  private _injectionDetector?: IPromptInjectionDetector;
  private _tracer?: ITracer;

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

  /** Override the helper LLM used for summarization and translation. */
  withHelperLlm(llm: ILlm): this {
    this._helperLlm = llm;
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

  /** Set a tracer for pipeline span instrumentation. */
  withTracer(tracer: ITracer): this {
    this._tracer = tracer;
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
      const agent = new DeepSeekAgent({
        llmProvider: provider,
        mcpClient: dummyMcp,
      });
      return new TokenCountingLlm(new LlmAdapter(agent));
    };

    const defaultMainLlm = this._mainLlm
      ? null
      : makeDefaultLlm(this.cfg.llm.temperature ?? 0.7);
    const defaultClassifierLlm = this._classifierLlm
      ? null
      : makeDefaultLlm(this.cfg.llm.classifierTemperature ?? 0.1);

    const mainLlmCandidate = this._mainLlm ?? defaultMainLlm;
    const classifierLlmCandidate = this._classifierLlm ?? defaultClassifierLlm;
    if (!mainLlmCandidate || !classifierLlmCandidate) {
      throw new Error('Failed to initialize default LLM dependencies');
    }
    const mainLlm: ILlm = mainLlmCandidate;
    const classifierLlm: ILlm = classifierLlmCandidate;

    // ---- Default RAG factory ---------------------------------------------
    const makeDefaultRag = (): IRag => {
      const r = this.cfg.rag;
      if (!r || r.type !== 'in-memory') {
        return new OllamaRag({
          ollamaUrl: r?.url,
          model: r?.model,
          timeoutMs: r?.timeoutMs,
          dedupThreshold: r?.dedupThreshold,
          vectorWeight: r?.vectorWeight,
          keywordWeight: r?.keywordWeight,
        });
      }
      return new InMemoryRag({ dedupThreshold: r.dedupThreshold });
    };

    const factsRag: IRag = this._ragStores?.facts ?? makeDefaultRag();
    const feedbackRag: IRag = this._ragStores?.feedback ?? makeDefaultRag();
    const stateRag: IRag = this._ragStores?.state ?? makeDefaultRag();

    // ---- MCP clients + tool vectorization --------------------------------
    let mcpClients: IMcpClient[];
    const closeFns: Array<() => Promise<void>> = [];

    if (this._mcpClients) {
      // Caller-provided clients: skip auto-connect and vectorization
      mcpClients = this._mcpClients;
    } else {
      const mcpList = this.cfg.mcp
        ? Array.isArray(this.cfg.mcp)
          ? this.cfg.mcp
          : [this.cfg.mcp]
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
            wrapper = new MCPClientWrapper({
              transport: 'auto',
              url: mcpCfg.url,
            });
          }
          await wrapper.connect();
          const adapter = new McpClientAdapter(wrapper);
          log?.log({
            type: 'pipeline_done',
            traceId: 'builder',
            stopReason: 'stop',
            iterations: 0,
            toolCallCount: 0,
            durationMs: 0,
          });

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

    // ---- SmartAgent Config (needed for assembler) ------------------------
    const agentCfg: SmartAgentConfig = {
      maxIterations: 10,
      maxToolCalls: 30,
      ragQueryK: 10,
      ragTranslatePrompt: this.cfg.prompts?.ragTranslate,
      historySummaryPrompt: this.cfg.prompts?.historySummary,
      historyAutoSummarizeLimit: this.cfg.agent?.historyAutoSummarizeLimit,
      ...this.cfg.agent,
      ...(this.cfg.sessionPolicy
        ? { sessionPolicy: this.cfg.sessionPolicy }
        : {}),
    };

    // ---- Classifier -------------------------------------------------------
    const classifierCfg: LlmClassifierConfig = {};
    if (this.cfg.prompts?.classifier)
      classifierCfg.systemPrompt = this.cfg.prompts.classifier;
    const classifier: ISubpromptClassifier =
      this._classifier ?? new LlmClassifier(classifierLlm, classifierCfg);

    // ---- Assembler --------------------------------------------------------
    const assemblerCfg: ContextAssemblerConfig = {
      showReasoning: agentCfg.showReasoning,
      reasoningInstruction: this.cfg.prompts?.reasoning,
    };
    if (this.cfg.prompts?.system)
      assemblerCfg.systemPromptPreamble = this.cfg.prompts.system;
    const assembler: IContextAssembler =
      this._assembler ?? new ContextAssembler(assemblerCfg);

    const agent = new SmartAgent(
      {
        mainLlm,
        helperLlm: this._helperLlm,
        mcpClients,
        ragStores: { facts: factsRag, feedback: feedbackRag, state: stateRag },
        classifier,
        assembler,
        ...(log ? { logger: log } : {}),
        ...(this._toolPolicy ? { toolPolicy: this._toolPolicy } : {}),
        ...(this._injectionDetector
          ? { injectionDetector: this._injectionDetector }
          : {}),
        ...(this._tracer ? { tracer: this._tracer } : {}),
      },
      agentCfg,
    );

    return {
      agent,
      chat: (messages, tools, options) =>
        mainLlm.chat(messages, tools, options),
      streamChat: (messages, tools, options) =>
        mainLlm.streamChat(messages, tools, options),
      getUsage: () => {
        const main = defaultMainLlm?.getUsage() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          requests: 0,
        };
        const classifier = defaultClassifierLlm?.getUsage() ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          requests: 0,
        };
        return {
          prompt_tokens: main.prompt_tokens + classifier.prompt_tokens,
          completion_tokens:
            main.completion_tokens + classifier.completion_tokens,
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
