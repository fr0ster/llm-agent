import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import { NoopToolCache } from './cache/noop-tool-cache.js';
import type { IToolCache } from './cache/types.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { IClientAdapter } from './interfaces/client-adapter.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IMcpConnectionStrategy } from './interfaces/mcp-connection-strategy.js';
import type { IEmbedder, IRag } from './interfaces/rag.js';
import type { IRequestLogger } from './interfaces/request-logger.js';
import type { ISkillManager } from './interfaces/skill.js';
import type {
  CallOptions,
  LlmFinishReason,
  LlmStreamChunk,
  LlmTool,
  McpTool,
  ModelUsageEntry,
  RagMetadata,
  RagResult,
  Result,
  StreamHookContext,
  Subprompt,
  TimingEntry,
} from './interfaces/types.js';

export {
  type AgentCallOptions,
  OrchestratorError,
  type SmartAgentResponse,
  type StopReason,
} from './interfaces/agent-contracts.js';

import {
  type AgentCallOptions,
  OrchestratorError,
  type SmartAgentResponse,
  type StopReason,
} from './interfaces/agent-contracts.js';
import type { ILogger } from './logger/index.js';
import { NoopRequestLogger } from './logger/noop-request-logger.js';
import { NoopMetrics } from './metrics/noop-metrics.js';
import type { IMetrics } from './metrics/types.js';
import type { PipelineContext } from './pipeline/context.js';
import type { PipelineExecutor } from './pipeline/executor.js';
import type { StageDefinition } from './pipeline/types.js';
import { fireInternalToolsAsync } from './policy/mixed-tool-call-handler.js';
import { PendingToolResultsRegistry } from './policy/pending-tool-results-registry.js';
import {
  isToolContextUnavailableError,
  ToolAvailabilityRegistry,
} from './policy/tool-availability-registry.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { QueryEmbedding, TextOnlyEmbedding } from './rag/query-embedding.js';
import {
  type IQueryExpander,
  NoopQueryExpander,
} from './rag/query-expander.js';
import { NoopReranker } from './reranker/noop-reranker.js';
import type { IReranker } from './reranker/types.js';
import { NoopSessionManager } from './session/noop-session-manager.js';
import type { ISessionManager } from './session/types.js';
import { NoopTracer } from './tracer/noop-tracer.js';
import type { ISpan, ITracer } from './tracer/types.js';
import { normalizeExternalTools } from './utils/external-tools-normalizer.js';
import {
  getStreamToolCallName,
  toToolCallDelta,
} from './utils/tool-call-deltas.js';
import { NoopValidator } from './validator/noop-validator.js';
import type { IOutputValidator } from './validator/types.js';

export type SmartAgentRagStores<K extends string = string> = Record<K, IRag>;

export interface SmartAgentDeps {
  mainLlm: ILlm;
  helperLlm?: ILlm;
  mcpClients: IMcpClient[];
  ragStores: SmartAgentRagStores;
  classifier: ISubpromptClassifier;
  assembler: IContextAssembler;
  reranker?: IReranker;
  queryExpander?: IQueryExpander;
  logger?: ILogger;
  requestLogger?: IRequestLogger;
  toolPolicy?: IToolPolicy;
  injectionDetector?: IPromptInjectionDetector;
  tracer?: ITracer;
  metrics?: IMetrics;
  toolCache?: IToolCache;
  outputValidator?: IOutputValidator;
  sessionManager?: ISessionManager;
  skillManager?: ISkillManager;
  clientAdapters?: IClientAdapter[];
  /** Shared embedder for RAG queries. When set, creates memoized IQueryEmbedding per request. */
  embedder?: IEmbedder;
  connectionStrategy?: IMcpConnectionStrategy;
}
export interface SmartAgentConfig {
  maxIterations: number;
  maxToolCalls?: number;
  toolUnavailableTtlMs?: number;
  timeoutMs?: number;
  tokenLimit?: number;
  ragQueryK?: number;
  smartAgentEnabled?: boolean;
  sessionPolicy?: SessionPolicy;
  showReasoning?: boolean;
  ragTranslatePrompt?: string;
  historySummaryPrompt?: string;
  historyAutoSummarizeLimit?: number;
  mode?: 'hard' | 'pass' | 'smart';
  queryExpansionEnabled?: boolean;
  toolResultCacheTtlMs?: number;
  sessionTokenBudget?: number;
  /** Interval (ms) for SSE heartbeat comments during MCP tool execution. Default: 5000. */
  heartbeatIntervalMs?: number;

  // -- Pipeline stage toggles -----------------------------------------------

  /** Whether classification stage runs. Default: true. When false, input is treated as a single action. */
  classificationEnabled?: boolean;
  /** RAG retrieval behavior. 'auto': based on SAP context detection (default), 'always': force retrieval, 'never': skip. */
  ragRetrievalMode?: 'auto' | 'always' | 'never';
  /** Whether to translate non-ASCII RAG queries to English. Default: true. */
  ragTranslationEnabled?: boolean;
  /** Whether to upsert classified subprompts to RAG stores. Default: true. */
  ragUpsertEnabled?: boolean;
  /** Whether to inject matched skills into the system prompt. Default: true (when skillManager is configured). */
  skillInjectionEnabled?: boolean;
  /**
   * Whether to re-fetch MCP tool list on each tool-loop iteration. Default: true.
   * @deprecated No-op since 2.15.0 — tool lists are cached in McpClientAdapter.
   */
  refreshToolsPerIteration?: boolean;
  /** Re-select tools via RAG on each tool-loop iteration. Default: false. */
  toolReselectPerIteration?: boolean;
  /** Retry options for transient LLM failures (429, 5xx). When set, wraps LLM with RetryLlm. */
  retry?: {
    maxAttempts?: number;
    backoffMs?: number;
    retryOn?: number[];
    retryOnMidStream?: string[];
  };
  /**
   * Streaming behavior for multi-iteration tool loops.
   * - `'full'` (default): stream all chunks immediately, including intermediate iterations.
   * - `'final'`: buffer intermediate iterations; only stream the final response.
   * External tool calls and heartbeats are always streamed regardless of mode.
   */
  streamMode?: 'full' | 'final';
  /** Called before streaming the final response. Consumer can transform or pass through. */
  onBeforeStream?: (
    content: string,
    ctx: StreamHookContext,
  ) => AsyncIterable<string>;
}
function mergeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortController {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl;
    }
    s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl;
}

function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('Timeout')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

export class SmartAgent {
  private readonly toolAvailabilityRegistry: ToolAvailabilityRegistry;
  private readonly tracer: ITracer;
  private readonly metrics: IMetrics;
  private readonly reranker: IReranker;
  private readonly queryExpander: IQueryExpander;
  private readonly toolCache: IToolCache;
  private readonly outputValidator: IOutputValidator;
  private readonly sessionManager: ISessionManager;
  private readonly pendingToolResults: PendingToolResultsRegistry;
  private readonly requestLogger: IRequestLogger;
  private _activeClients: IMcpClient[];

  constructor(
    private readonly deps: SmartAgentDeps,
    private config: SmartAgentConfig,
    private readonly pipelineExecutor?: PipelineExecutor,
    private readonly pipelineStages?: StageDefinition[],
  ) {
    this.toolAvailabilityRegistry = new ToolAvailabilityRegistry(
      this.config.toolUnavailableTtlMs,
    );
    this.tracer = deps.tracer ?? new NoopTracer();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.reranker = deps.reranker ?? new NoopReranker();
    this.queryExpander = deps.queryExpander ?? new NoopQueryExpander();
    this.toolCache = deps.toolCache ?? new NoopToolCache();
    this.outputValidator = deps.outputValidator ?? new NoopValidator();
    this.sessionManager = deps.sessionManager ?? new NoopSessionManager();
    this.pendingToolResults = new PendingToolResultsRegistry();
    this.requestLogger = deps.requestLogger ?? new NoopRequestLogger();
    this._activeClients = [...deps.mcpClients];
  }

  private async _resolveActiveClients(opts?: CallOptions): Promise<void> {
    if (!this.deps.connectionStrategy) return;
    const result = await this.deps.connectionStrategy.resolve(
      this._activeClients,
      opts,
    );
    this._activeClients = result.clients;
    if (result.toolsChanged) {
      await this._revectorizeTools(result.clients, opts);
    }
  }

  private async _revectorizeTools(
    clients: IMcpClient[],
    opts?: CallOptions,
  ): Promise<void> {
    const toolsRag =
      this.deps.ragStores.tools ?? Object.values(this.deps.ragStores)[0];
    if (!toolsRag) return;
    for (const client of clients) {
      const result = await client.listTools(opts);
      if (!result.ok) continue;
      for (const tool of result.value) {
        const text = `Tool: ${tool.name}\nDescription: ${tool.description}\nSchema: ${JSON.stringify(tool.inputSchema)}`;
        await toolsRag.upsert(text, { id: `tool:${tool.name}` });
      }
    }
  }

  /** Apply a partial config update at runtime (hot-reload). */
  applyConfigUpdate(update: Partial<SmartAgentConfig>): void {
    this.config = { ...this.config, ...update };
  }

  async healthCheck(options?: CallOptions): Promise<
    Result<
      {
        llm: boolean;
        rag: boolean;
        mcp: { name: string; ok: boolean; error?: string }[];
      },
      OrchestratorError
    >
  > {
    const HEALTH_TIMEOUT_MS = 5_000;
    const healthSignal = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
    const healthOptions: CallOptions = {
      ...options,
      signal: healthSignal,
      maxTokens: 1,
    };

    const results = {
      llm: false,
      rag: false,
      mcp: [] as { name: string; ok: boolean; error?: string }[],
    };
    try {
      if (this.deps.mainLlm.healthCheck) {
        const hc = await this.deps.mainLlm.healthCheck(healthOptions);
        results.llm = hc.ok && hc.value;
      } else {
        // Fallback for ILlm implementations without healthCheck
        const llmRes = await this.deps.mainLlm.chat(
          [{ role: 'user' as const, content: 'ping' }],
          [],
          healthOptions,
        );
        results.llm = llmRes.ok;
      }
    } catch {
      results.llm = false;
    }
    try {
      const firstStore = Object.values(this.deps.ragStores)[0];
      const ragRes = firstStore
        ? await firstStore.healthCheck(healthOptions)
        : { ok: true as const, value: undefined };
      results.rag = ragRes.ok;
    } catch {
      results.rag = false;
    }
    try {
      const mcpChecks = await Promise.all(
        this._activeClients.map(async (client) => {
          try {
            if (client.healthCheck) {
              const hc = await client.healthCheck(healthOptions);
              return {
                name: 'mcp-client',
                ok: hc.ok,
                error:
                  hc.ok || !hc.error
                    ? undefined
                    : hc.error instanceof Error
                      ? hc.error.message
                      : String(hc.error),
              };
            }
            // Fallback for IMcpClient implementations without healthCheck
            const tools = await client.listTools(healthOptions);
            return {
              name: 'mcp-client',
              ok: tools.ok,
              error:
                tools.ok || !tools.error
                  ? undefined
                  : tools.error instanceof Error
                    ? tools.error.message
                    : String(tools.error),
            };
          } catch (err) {
            return {
              name: 'mcp-client',
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      results.mcp = mcpChecks;
    } catch {
      // AbortSignal timeout — leave mcp as empty
    }
    return { ok: true, value: results };
  }

  async process(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    let content = '';
    const totalUsage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      models?: Record<string, ModelUsageEntry>;
    } = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let stopReason: StopReason = 'stop';
    const collectedToolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    for await (const chunk of this.streamProcess(textOrMessages, options)) {
      if (!chunk.ok) return chunk;
      if (chunk.value.content) content += chunk.value.content;
      if (chunk.value.toolCalls) {
        for (const tc of chunk.value.toolCalls) {
          const delta = toToolCallDelta(tc, collectedToolCalls.length);
          if (!delta.id) continue;
          const existing = collectedToolCalls.find((c) => c.id === delta.id);
          if (existing) {
            if (delta.arguments) existing.function.arguments += delta.arguments;
          } else if (delta.name) {
            collectedToolCalls.push({
              id: delta.id,
              type: 'function',
              function: {
                name: delta.name,
                arguments: delta.arguments || '',
              },
            });
          }
        }
      }
      if (chunk.value.finishReason === 'tool_calls') {
        stopReason = 'tool_calls';
      }
      if (chunk.value.usage) {
        totalUsage.promptTokens += chunk.value.usage.promptTokens;
        totalUsage.completionTokens += chunk.value.usage.completionTokens;
        totalUsage.totalTokens += chunk.value.usage.totalTokens;
        if (chunk.value.usage.models) {
          totalUsage.models = chunk.value.usage.models;
        }
      }
    }
    return {
      ok: true,
      value: {
        content,
        iterations: 1,
        toolCallCount: collectedToolCalls.length,
        stopReason,
        ...(collectedToolCalls.length > 0
          ? { toolCalls: collectedToolCalls }
          : {}),
        usage: totalUsage,
      },
    };
  }

  async *streamProcess(
    textOrMessages: string | Message[],
    options?: AgentCallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) {
      yield {
        ok: false,
        error: new OrchestratorError('SmartAgent is disabled', 'DISABLED'),
      };
      return;
    }
    this.metrics.requestCount.add();
    const requestStart = Date.now();
    const traceId = options?.trace?.traceId ?? randomUUID();
    const rootSpan = this.tracer.startSpan('smart_agent.process', {
      traceId,
      attributes: { 'smart_agent.mode': this.config.mode || 'smart' },
    });
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) {
      const { signal, clear } = createTimeoutSignal(this.config.timeoutMs);
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, signal);
      opts = { ...options, signal: merged.signal };
    }

    const mode = this.config.mode || 'smart';

    // Per-request client adapter detection from system prompt
    let detectedAdapter: IClientAdapter | undefined;
    const messages =
      typeof textOrMessages === 'string' ? undefined : textOrMessages;
    if (messages && this.deps.clientAdapters?.length) {
      const systemMsg = messages.find((m) => m.role === 'system');
      if (systemMsg?.content) {
        detectedAdapter = this.deps.clientAdapters.find((a) =>
          a.detect(
            typeof systemMsg.content === 'string' ? systemMsg.content : '',
          ),
        );
      }
    }
    const sessionId = options?.sessionId ?? 'default';
    const normalizedExternalTools = normalizeExternalTools(
      options?.externalTools,
    );

    const { allowed: externalTools, blocked: blockedExternalTools } =
      this.toolAvailabilityRegistry.filterTools(
        sessionId,
        normalizedExternalTools,
      );
    if (blockedExternalTools.length > 0) {
      opts?.sessionLogger?.logStep('external_tools_filtered_by_registry', {
        blocked: blockedExternalTools,
      });
    }
    opts?.sessionLogger?.logStep('pipeline_start', { mode, textOrMessages });
    this.requestLogger.startRequest();

    try {
      if (mode === 'pass') {
        const messages: Message[] =
          typeof textOrMessages === 'string'
            ? [{ role: 'user' as const, content: textOrMessages }]
            : textOrMessages;
        opts?.sessionLogger?.logStep('client_request', { textOrMessages });
        const stream = this.deps.mainLlm.streamChat(
          messages,
          externalTools,
          opts,
        );
        let passContent = '';
        const passToolCalls: unknown[] = [];
        for await (const chunk of stream) {
          if (chunk.ok) {
            if (chunk.value.reset) {
              passContent = '';
              passToolCalls.length = 0;
              continue;
            }
            if (chunk.value.content) passContent += chunk.value.content;
            if (chunk.value.toolCalls)
              passToolCalls.push(...chunk.value.toolCalls);
          }
          yield chunk;
        }
        opts?.sessionLogger?.logStep('llm_response_pass', {
          content: passContent,
          toolCalls: passToolCalls.length > 0 ? passToolCalls : undefined,
        });
        rootSpan.setStatus('ok');
        rootSpan.end();
        return;
      }

      // Structured pipeline path (when configured via Builder.withPipeline)
      if (this.pipelineExecutor && this.pipelineStages) {
        const stream = this._runStructuredPipeline(
          textOrMessages,
          externalTools,
          opts,
          rootSpan,
          sessionId,
        );
        for await (const chunk of stream) yield chunk;
        rootSpan.setStatus('ok');
        rootSpan.end();
        return;
      }

      // 1. Unified Preparation (default hardcoded flow)
      const initResult = await this._preparePipeline(
        textOrMessages,
        opts,
        rootSpan,
      );
      if (!initResult.ok) {
        rootSpan.setStatus('error', initResult.error.message);
        rootSpan.end();
        yield initResult;
        return;
      }
      let { processedHistory } = initResult.value;
      const { subprompts, toolClientMap } = initResult.value;

      // Token budget check — summarize if over budget
      if (this.sessionManager.isOverBudget()) {
        const sumResult = await this._summarizeHistory(processedHistory, opts);
        if (sumResult.ok) processedHistory = sumResult.value;
        this.sessionManager.reset();
      }

      // 2. Decide context and tools for the WHOLE request
      await this._resolveActiveClients(opts);
      const actions = subprompts.filter((sp) => sp.type === 'action');
      const ragMode = this.config.ragRetrievalMode ?? 'auto';
      const hasActions = actions.length > 0;
      const hasMcpClients = this._activeClients.length > 0;
      const hasRagStores = Object.keys(this.deps.ragStores).length > 0;
      const shouldRetrieve =
        ragMode === 'always' ||
        mode === 'hard' ||
        (ragMode === 'auto' && hasActions && (hasMcpClients || hasRagStores));

      let finalTools: LlmTool[] = [];
      let retrieved: {
        ragResults: Record<string, RagResult[]>;
        tools: McpTool[];
      } = {
        ragResults: {},
        tools: [],
      };
      let skillContent = '';

      if (shouldRetrieve) {
        // Collect all action texts for RAG
        const combinedActionText = actions.map((a) => a.text).join(' ');
        let ragText =
          this.config.ragTranslationEnabled !== false
            ? await this._toEnglishForRag(combinedActionText, opts)
            : combinedActionText;
        if (this.config.queryExpansionEnabled) {
          const expandResult = await this.queryExpander.expand(ragText, opts);
          if (expandResult.ok) ragText = expandResult.value;
        }
        const k = this.config.ragQueryK ?? 10;
        const ragSpan = this.tracer.startSpan('smart_agent.rag_query', {
          parent: rootSpan,
          attributes: { 'rag.k': k },
        });
        const storeEntries = Object.entries(this.deps.ragStores);
        const embedding = this.deps.embedder
          ? new QueryEmbedding(ragText, this.deps.embedder, opts)
          : new TextOnlyEmbedding(ragText);
        const ragQueryResults = await Promise.all(
          storeEntries.map(([name, store]) =>
            store.query(embedding, k, opts).then((r) => ({ name, result: r })),
          ),
        );
        ragSpan.end();
        const ragResultsMap: Record<string, RagResult[]> = {};
        for (const { name, result: r } of ragQueryResults) {
          ragResultsMap[name] = r.ok ? r.value : [];
          this.metrics.ragQueryCount.add(1, {
            store: name,
            hit: String(r.ok && r.value.length > 0),
          });
        }

        // Rerank results
        // Rerank all stores in parallel
        const rerankedEntries = await Promise.all(
          Object.entries(ragResultsMap).map(async ([name, results]) => {
            if (results.length > 0) {
              const rr = await this.reranker.rerank(ragText, results, opts);
              return { name, results: rr.ok ? rr.value : results };
            }
            return { name, results };
          }),
        );
        const rerankedMap: Record<string, RagResult[]> = {};
        for (const { name, results } of rerankedEntries) {
          rerankedMap[name] = results;
        }

        const { tools: mcpTools } = await this._listAllTools(opts);

        // Collect all RAG results for tool discovery
        const allRagResults = Object.values(rerankedMap).flat();

        // Log RAG results with scores for diagnostics
        for (const [storeName, results] of Object.entries(rerankedMap)) {
          opts?.sessionLogger?.logStep(`rag_query_${storeName}`, {
            query: ragText.slice(0, 200),
            k,
            resultCount: results.length,
            results: results.map((r) => ({
              id: r.metadata.id,
              score: r.score,
              text: r.text.slice(0, 120),
            })),
          });
        }

        const ragToolNames = new Set(
          allRagResults
            .map((r) => r.metadata.id as string)
            .filter((id) => id?.startsWith('tool:'))
            .map((id) => id.slice(5)),
        );
        const selectedMcpTools =
          ragToolNames.size > 0
            ? mcpTools.filter((t) => ragToolNames.has(t.name))
            : mode === 'hard'
              ? mcpTools
              : [];

        // Log tool selection diagnostics
        opts?.sessionLogger?.logStep('tools_selected', {
          totalMcp: mcpTools.length,
          ragMatchedTools: [...ragToolNames],
          selectedCount: selectedMcpTools.length + externalTools.length,
          selectedNames: [
            ...selectedMcpTools.map((t) => t.name),
            ...externalTools.map((t) => t.name),
          ],
        });

        retrieved = {
          ragResults: rerankedMap,
          tools: selectedMcpTools,
        };
        finalTools =
          mode === 'hard'
            ? (selectedMcpTools as LlmTool[])
            : [...(selectedMcpTools as LlmTool[]), ...externalTools];

        // Skill injection (when enabled and skillManager configured)
        if (
          this.config.skillInjectionEnabled !== false &&
          this.deps.skillManager
        ) {
          const ragSkillNames = new Set(
            allRagResults
              .map((r) => r.metadata.id as string)
              .filter((id) => id?.startsWith('skill:'))
              .map((id) => id.slice(6)),
          );

          // Fallback: dedicated RAG query when no skill:* in existing results
          if (ragSkillNames.size === 0) {
            const k = this.config.ragQueryK ?? 15;
            const queryText = ragText;
            const storeEntries = Object.entries(this.deps.ragStores);
            const fallbackEmbedding = this.deps.embedder
              ? new QueryEmbedding(queryText, this.deps.embedder, opts)
              : new TextOnlyEmbedding(queryText);
            const fallbackResults = await Promise.all(
              storeEntries.map(([, store]) =>
                store.query(fallbackEmbedding, k, opts),
              ),
            );
            for (const result of fallbackResults) {
              if (result.ok) {
                for (const r of result.value) {
                  const id = r.metadata.id as string;
                  if (id?.startsWith('skill:')) {
                    ragSkillNames.add(id.slice(6));
                  }
                }
              }
            }
            if (ragSkillNames.size > 0) {
              opts?.sessionLogger?.logStep('skill_select_rag_fallback', {
                query: queryText.slice(0, 200),
                k,
                matchedSkills: [...ragSkillNames],
              });
            }
          }

          const allSkillsResult = await this.deps.skillManager.listSkills(opts);
          if (allSkillsResult.ok) {
            const allSkills = allSkillsResult.value;
            const matched =
              ragSkillNames.size > 0
                ? allSkills.filter((s) => ragSkillNames.has(s.name))
                : mode === 'hard'
                  ? allSkills
                  : [];
            const contentParts: string[] = [];
            for (const skill of matched) {
              const contentResult = await skill.getContent(undefined, opts);
              if (contentResult.ok && contentResult.value) {
                contentParts.push(
                  `### Skill: ${skill.name}\n${contentResult.value}`,
                );
              }
            }
            skillContent = contentParts.join('\n\n');
            opts?.sessionLogger?.logStep('skills_selected', {
              totalSkills: allSkills.length,
              ragMatchedSkills: [...ragSkillNames],
              selectedCount: matched.length,
              selectedNames: matched.map((s) => s.name),
            });
          }
        }
      } else {
        // If we're here, mode is definitely 'smart' (not 'hard' or 'pass')
        finalTools = externalTools;
      }
      const filteredTools = this.toolAvailabilityRegistry.filterTools(
        sessionId,
        finalTools,
      );
      finalTools = filteredTools.allowed;
      if (filteredTools.blocked.length > 0) {
        opts?.sessionLogger?.logStep('active_tools_filtered_by_registry', {
          blocked: filteredTools.blocked,
        });
      }

      // 3. Assemble Context once
      const mainAction =
        actions.length > 1
          ? {
              type: 'action' as const,
              text: actions.map((a) => a.text).join('\n'),
              context: actions.find((a) => a.context)?.context,
              dependency: 'independent' as const,
            }
          : actions.length === 1
            ? actions[0]
            : subprompts.find((sp) => sp.type === 'chat') || subprompts[0];

      if (actions.length > 1) {
        opts?.sessionLogger?.logStep('actions_merged', {
          count: actions.length,
          actions: actions.map((a) => ({
            text: a.text,
            dependency: a.dependency,
          })),
        });
      }
      const assembleSpan = this.tracer.startSpan('smart_agent.assemble', {
        parent: rootSpan,
      });
      const assembleResult = await this.deps.assembler.assemble(
        mainAction,
        retrieved,
        processedHistory,
        opts,
      );
      if (!assembleResult.ok) {
        assembleSpan.setStatus('error', assembleResult.error.message);
        assembleSpan.end();
        rootSpan.setStatus('error', assembleResult.error.message);
        rootSpan.end();
        yield {
          ok: false,
          error: new OrchestratorError(
            assembleResult.error.message,
            'ASSEMBLER_ERROR',
          ),
        };
        return;
      }
      assembleSpan.setStatus('ok');
      assembleSpan.end();

      // Inject skill content into system message (post-assembly)
      if (skillContent) {
        const sysMsg = assembleResult.value.find((m) => m.role === 'system');
        if (sysMsg) {
          sysMsg.content += `\n\n## Active Skills\n${skillContent}`;
        } else {
          assembleResult.value.unshift({
            role: 'system' as const,
            content: `## Active Skills\n${skillContent}`,
          });
        }
      }

      opts?.sessionLogger?.logStep(`final_context_assembled`, {
        messages: assembleResult.value,
        tools: finalTools.map((t) => t.name),
      });

      // 4. Single Streaming Loop
      const stream = this._runStreamingToolLoop(
        mainAction,
        retrieved,
        assembleResult.value,
        toolClientMap,
        opts,
        rootSpan,
        sessionId,
        mode === 'hard' ? [] : externalTools,
        finalTools,
        detectedAdapter,
      );
      for await (const chunk of stream) yield chunk;
      rootSpan.setStatus('ok');
    } finally {
      this.requestLogger.endRequest();
      rootSpan.end();
      timeoutCleanup?.();
      this.metrics.requestLatency.record(Date.now() - requestStart);
    }
  }

  private async _preparePipeline(
    textOrMessages: string | Message[],
    opts: CallOptions | undefined,
    parentSpan: ISpan,
  ): Promise<
    Result<
      {
        subprompts: Subprompt[];
        processedHistory: Message[];
        toolClientMap: Map<string, IMcpClient>;
      },
      OrchestratorError
    >
  > {
    opts?.sessionLogger?.logStep('client_request', { textOrMessages });
    const text =
      typeof textOrMessages === 'string'
        ? textOrMessages
        : (textOrMessages.filter((m) => m.role === 'user').slice(-1)[0]
            ?.content ?? '');
    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;
    let processedHistory = history;
    const summarizeLimit = this.config.historyAutoSummarizeLimit ?? 10;
    if (this.deps.helperLlm && history.length > summarizeLimit) {
      const res = await this._summarizeHistory(history, opts);
      if (res.ok) processedHistory = res.value;
    }

    let subprompts: Subprompt[];

    if (this.config.classificationEnabled === false) {
      // Skip classification — treat entire input as a single action
      subprompts = [
        { type: 'action', text, dependency: 'independent' as const },
      ];
      opts?.sessionLogger?.logStep('classification_skipped', { text });
    } else {
      const classifySpan = this.tracer.startSpan('smart_agent.classify', {
        parent: parentSpan,
      });
      const classifyResult = await this.deps.classifier.classify(text, opts);
      if (!classifyResult.ok) {
        classifySpan.setStatus('error', classifyResult.error.message);
        classifySpan.end();
        return {
          ok: false,
          error: new OrchestratorError(
            classifyResult.error.message,
            'CLASSIFIER_ERROR',
          ),
        };
      }
      classifySpan.setStatus('ok');
      classifySpan.end();
      opts?.sessionLogger?.logStep('classifier_response', {
        subprompts: classifyResult.value,
      });
      subprompts = classifyResult.value;
    }
    for (const sp of subprompts) {
      this.metrics.classifierIntentCount.add(1, { intent: sp.type });
    }
    const resolveStore = (type: string): IRag | undefined =>
      this.deps.ragStores[type] ?? this.deps.ragStores[`${type}s`];
    const others =
      this.config.ragUpsertEnabled !== false
        ? subprompts.filter(
            (sp) =>
              sp.type !== 'action' &&
              sp.type !== 'chat' &&
              resolveStore(sp.type),
          )
        : [];
    if (others.length > 0) {
      const upsertSpan = this.tracer.startSpan('smart_agent.rag_upsert', {
        parent: parentSpan,
        attributes: { 'rag.upsert_count': others.length },
      });
      await Promise.allSettled(
        others.map(async (sp) => {
          const s = resolveStore(sp.type);
          if (s) await s.upsert(sp.text, this._buildRagMetadata(), opts);
        }),
      );
      upsertSpan.end();
    }

    const { toolClientMap } = await this._listAllTools(opts);
    return { ok: true, value: { subprompts, processedHistory, toolClientMap } };
  }

  private async *_runStreamingToolLoop(
    _action: Subprompt,
    _retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    parentSpan: ISpan,
    sessionId: string,
    externalTools: LlmTool[],
    activeTools: LlmTool[],
    clientAdapter?: IClientAdapter,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    const toolLoopSpan = this.tracer.startSpan('smart_agent.tool_loop', {
      parent: parentSpan,
    });
    let toolCallCount = 0;
    let messages = initialMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const externalToolNames = new Set(externalTools.map((t) => t.name));
    const timingLog: TimingEntry[] = [];
    const loopStart = Date.now();
    let currentTools = activeTools;

    // Inject tool priority instruction when external tools are present
    if (externalTools.length > 0) {
      const systemIdx = messages.findIndex((m) => m.role === 'system');
      if (systemIdx >= 0) {
        const sys = messages[systemIdx];
        messages = [...messages];
        messages[systemIdx] = {
          ...sys,
          content: `${sys.content}\n\nIMPORTANT: You have internal tools and client-provided tools (marked [client-provided] in their description). Always prefer internal tools when they can accomplish the task. Use client-provided tools only when no internal tool can do the job.`,
        };
      }
    }

    // Inject pending internal tool results from previous mixed-call request
    if (this.pendingToolResults.has(sessionId)) {
      const pending = await this.pendingToolResults.consume(sessionId);
      if (pending) {
        messages = [
          ...messages,
          pending.assistantMessage,
          ...pending.results.map((r) => ({
            role: 'tool' as const,
            content: r.text,
            tool_call_id: r.toolCallId,
          })),
        ];
        opts?.sessionLogger?.logStep('pending_tool_results_injected', {
          toolNames: pending.results.map((r) => r.toolName),
        });
      }
    }

    for (let iteration = 0; ; iteration++) {
      let iterationBuffer = '';
      if (opts?.signal?.aborted) {
        toolLoopSpan.setStatus('error', 'Aborted');
        toolLoopSpan.end();
        yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
        return;
      }
      if (iteration >= this.config.maxIterations) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.addEvent('iteration_limit_reached');
        toolLoopSpan.end();
        yield {
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage: {
              ...usage,
              models: this.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        };
        return;
      }
      // Refresh MCP tools on each iteration (when enabled)
      if (iteration > 0 && this.config.refreshToolsPerIteration !== false) {
        const refreshSpan = this.tracer.startSpan('smart_agent.refresh_tools', {
          parent: toolLoopSpan,
          attributes: { 'llm.iteration': iteration + 1 },
        });
        const refreshed = await this._listAllTools(opts);
        const prevNames = [...toolClientMap.keys()];
        toolClientMap.clear();
        for (const [name, client] of refreshed.toolClientMap) {
          toolClientMap.set(name, client);
        }
        currentTools = [...(refreshed.tools as LlmTool[]), ...externalTools];
        opts?.sessionLogger?.logStep('tools_refreshed', {
          iteration: iteration + 1,
          previous: prevNames,
          current: currentTools.map((t) => t.name),
        });
        refreshSpan.end();
      }

      // Per-iteration RAG tool re-selection (when enabled)
      if (
        iteration > 0 &&
        this.config.toolReselectPerIteration &&
        this.deps.ragStores?.tools
      ) {
        const reselectSpan = this.tracer.startSpan(
          'smart_agent.tool_reselect',
          {
            parent: toolLoopSpan,
            attributes: { 'llm.iteration': iteration + 1 },
          },
        );

        try {
          // Extract last tool calls
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => m.role === 'assistant');
          const toolCallNames: string[] = [];
          if (lastAssistant && 'tool_calls' in lastAssistant) {
            const tcs = lastAssistant.tool_calls;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                const name = tc?.function?.name || '';
                if (name) toolCallNames.push(name);
              }
            }
          }

          // Skip for read-only tools — they rarely need different tools on retry
          const readOnlyPrefixes = [
            'Search',
            'Read',
            'Get',
            'List',
            'Describe',
          ];
          const allReadOnly =
            toolCallNames.length > 0 &&
            toolCallNames.every((n) =>
              readOnlyPrefixes.some((p) => n.startsWith(p)),
            );

          if (!allReadOnly) {
            // Build context-aware query from error/result context
            const lastToolMsg = [...messages]
              .reverse()
              .find((m) => m.role === 'tool');
            const toolResult =
              typeof lastToolMsg?.content === 'string'
                ? lastToolMsg.content.slice(0, 200)
                : '';
            const isError =
              toolResult.toLowerCase().includes('error') ||
              toolResult.toLowerCase().includes('already exist') ||
              toolResult.toLowerCase().includes('failed');

            const inputText = _action.text;
            let reSelectQuery: string;
            if (toolCallNames.length > 0 && isError) {
              const updateHints = toolCallNames
                .filter((n) => n.startsWith('Create'))
                .map((n) => n.replace(/^Create/, 'Update'))
                .join(', ');
              const hints = updateHints ? ` Need ${updateHints}.` : '';
              reSelectQuery = `${toolCallNames.join(', ')} failed: ${toolResult.slice(0, 150)}.${hints} ${inputText.slice(0, 200)}`;
            } else if (toolCallNames.length > 0) {
              reSelectQuery = `After ${toolCallNames.join(', ')}: ${toolResult}\n${inputText.slice(0, 200)}`;
            } else {
              reSelectQuery = inputText;
            }

            // Query tools RAG
            const embedding = this.deps.embedder
              ? new QueryEmbedding(reSelectQuery, this.deps.embedder, opts)
              : new TextOnlyEmbedding(reSelectQuery);

            const ragK = this.config.ragQueryK ?? 20;
            const ragResult = await this.deps.ragStores.tools.query(
              embedding,
              ragK,
              opts,
            );

            if (ragResult.ok && ragResult.value.length > 0) {
              const newToolNames = new Set(
                ragResult.value
                  .map((r) => (r.metadata?.id as string) || '')
                  .filter((id) => id.startsWith('tool:'))
                  .map((id) => id.slice(5)),
              );

              if (newToolNames.size > 0) {
                const refreshed = await this._listAllTools(opts);
                const newMcpTools = refreshed.tools.filter((t) =>
                  newToolNames.has(t.name),
                );
                currentTools = [
                  ...(newMcpTools as LlmTool[]),
                  ...externalTools,
                ];

                // Update system message "Available Tools" section
                const sysIdx = messages.findIndex((m) => m.role === 'system');
                if (
                  sysIdx >= 0 &&
                  typeof messages[sysIdx].content === 'string'
                ) {
                  const toolsSection = currentTools
                    .filter((t) => !externalToolNames.has(t.name))
                    .map((t) => `- ${t.name}: ${t.description || ''}`)
                    .join('\n');
                  messages[sysIdx] = {
                    ...messages[sysIdx],
                    content: (messages[sysIdx].content as string).replace(
                      /## Available Tools\n[\s\S]*?(?=\n##|$)/,
                      `## Available Tools\n${toolsSection}`,
                    ),
                  };
                }

                opts?.sessionLogger?.logStep('tools_reselected', {
                  iteration: iteration + 1,
                  query: reSelectQuery.slice(0, 100),
                  previousTools: toolCallNames,
                  newTools: [...newToolNames],
                });
              }
            }
          } else {
            opts?.sessionLogger?.logStep('tools_reselect_skipped', {
              iteration: iteration + 1,
              reason: 'read-only tools only',
              tools: toolCallNames,
            });
          }
        } finally {
          reselectSpan.end();
        }
      }

      const filteredForIteration = this.toolAvailabilityRegistry.filterTools(
        sessionId,
        currentTools,
      );
      currentTools = filteredForIteration.allowed;
      if (filteredForIteration.blocked.length > 0) {
        opts?.sessionLogger?.logStep('active_tools_filtered_in_iteration', {
          iteration: iteration + 1,
          blocked: filteredForIteration.blocked,
        });
      }
      opts?.sessionLogger?.logStep(`llm_request_iter_${iteration + 1}`, {
        messages,
        tools: currentTools,
      });
      const llmSpan = this.tracer.startSpan('smart_agent.llm_call', {
        parent: toolLoopSpan,
        attributes: { 'llm.iteration': iteration + 1 },
      });
      this.metrics.llmCallCount.add();
      const llmCallStart = Date.now();
      const stream = this.deps.mainLlm.streamChat(messages, currentTools, opts);
      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      for await (const chunkResult of stream) {
        if (!chunkResult.ok) {
          llmSpan.setStatus('error', chunkResult.error.message);
          llmSpan.end();
          toolLoopSpan.setStatus('error', chunkResult.error.message);
          toolLoopSpan.end();
          yield {
            ok: false,
            error: new OrchestratorError(
              chunkResult.error.message,
              'LLM_ERROR',
            ),
          };
          return;
        }
        const chunk = chunkResult.value;
        // Mid-stream retry: discard accumulated state and restart accumulation
        if (chunk.reset) {
          content = '';
          iterationBuffer = '';
          toolCallsMap.clear();
          finishReason = undefined;
          continue;
        }
        if (chunk.content) {
          content += chunk.content;
          // When a client adapter is detected, buffer content — it will be wrapped after the stream completes
          if (!clientAdapter) {
            if (this.config.streamMode === 'final') {
              iterationBuffer += chunk.content;
            } else {
              yield { ok: true, value: { content: chunk.content } };
            }
          }
        }
        if (chunk.toolCalls) {
          const externalDeltas = chunk.toolCalls.filter((tc) =>
            externalToolNames.has(getStreamToolCallName(tc) ?? ''),
          );
          if (externalDeltas.length > 0) {
            yield {
              ok: true,
              value: { content: '', toolCalls: externalDeltas },
            };
          }
          for (const [
            fallbackIndex,
            rawToolCall,
          ] of chunk.toolCalls.entries()) {
            const tc = toToolCallDelta(rawToolCall, fallbackIndex);
            if (!toolCallsMap.has(tc.index)) {
              toolCallsMap.set(tc.index, {
                id: tc.id || '',
                name: tc.name || '',
                arguments: tc.arguments || '',
              });
            } else {
              const ex = toolCallsMap.get(tc.index);
              if (ex) {
                if (tc.id) ex.id = tc.id;
                if (tc.name) ex.name = tc.name;
                if (tc.arguments) ex.arguments += tc.arguments;
              }
            }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) {
          usage.promptTokens += chunk.usage.promptTokens;
          usage.completionTokens += chunk.usage.completionTokens;
          usage.totalTokens += chunk.usage.totalTokens;
          this.sessionManager.addTokens(chunk.usage.totalTokens);
        }
      }
      llmSpan.setStatus('ok');
      llmSpan.end();
      const llmCallDuration = Date.now() - llmCallStart;
      this.metrics.llmCallLatency.record(llmCallDuration);
      timingLog.push({
        phase: `llm_call_${iteration + 1}`,
        duration: llmCallDuration,
      });
      // In 'final' mode: yield buffered content only if this is the last iteration
      if (this.config.streamMode === 'final' && iterationBuffer) {
        if (finishReason !== 'tool_calls') {
          // Final iteration — stream the buffered content
          yield { ok: true, value: { content: iterationBuffer } };
        }
        iterationBuffer = '';
      }
      const toolCalls = Array.from(toolCallsMap.values()).map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.name, arguments: args };
      });
      opts?.sessionLogger?.logStep(`llm_response_iter_${iteration + 1}`, {
        content,
        toolCalls,
        finishReason,
      });
      if (finishReason !== 'tool_calls' || toolCalls.length === 0) {
        // Output validation
        const valResult = await this.outputValidator.validate(
          content,
          { messages, tools: currentTools },
          opts,
        );
        if (valResult.ok && !valResult.value.valid) {
          const correction =
            valResult.value.correctedContent ?? valResult.value.reason;
          messages = [
            ...messages,
            { role: 'assistant' as const, content },
            {
              role: 'user' as const,
              content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
            },
          ];
          continue;
        }
        opts?.sessionLogger?.logStep('final_response', { content, usage });

        // onBeforeStream hook — consumer transforms content before streaming
        if (this.config.onBeforeStream) {
          const hookCtx: StreamHookContext = { messages };
          for await (const chunk of this.config.onBeforeStream(
            content,
            hookCtx,
          )) {
            if (clientAdapter) {
              yield {
                ok: true,
                value: { content: clientAdapter.wrapResponse(chunk) },
              };
            } else {
              yield { ok: true, value: { content: chunk } };
            }
          }
        } else if (clientAdapter && content) {
          yield {
            ok: true,
            value: { content: clientAdapter.wrapResponse(content) },
          };
        }

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.setStatus('ok');
        toolLoopSpan.end();
        const summary = this.requestLogger.getSummary();
        yield {
          ok: true,
          value: {
            content: '',
            finishReason: finishReason || 'stop',
            usage: {
              ...usage,
              models: summary.byModel,
            },
            timing: timingLog,
          },
        };
        return;
      }
      const internalCalls = toolCalls.filter((tc) =>
        toolClientMap.has(tc.name),
      );
      const validExternalCalls = toolCalls.filter((tc) =>
        externalToolNames.has(tc.name),
      );
      const blockedToolNames =
        this.toolAvailabilityRegistry.getBlockedToolNames(sessionId);
      const blockedCalls = toolCalls.filter((tc) =>
        blockedToolNames.has(tc.name),
      );
      const hallucinations = toolCalls.filter(
        (tc) =>
          !blockedToolNames.has(tc.name) &&
          !toolClientMap.has(tc.name) &&
          !externalToolNames.has(tc.name),
      );
      if (blockedCalls.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: blockedCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const blocked of blockedCalls) {
          messages = [
            ...messages,
            {
              role: 'tool' as const,
              content: `Error: Tool "${blocked.name}" is temporarily unavailable in this session.`,
              tool_call_id: blocked.id,
            },
          ];
        }
        opts?.sessionLogger?.logStep('blocked_tool_calls_intercepted', {
          toolNames: blockedCalls.map((tc) => tc.name),
        });
        continue;
      }
      if (hallucinations.length > 0) {
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
        for (const h of hallucinations) {
          messages = [
            ...messages,
            {
              role: 'tool' as const,
              content: `Error: Tool "${h.name}" not found.`,
              tool_call_id: h.id,
            },
          ];
        }
        continue;
      }
      if (validExternalCalls.length > 0) {
        // Mixed calls: fire internal tools async, store pending results
        if (internalCalls.length > 0) {
          fireInternalToolsAsync(
            content,
            internalCalls,
            this.pendingToolResults,
            sessionId,
            {
              toolClientMap,
              toolCache: this.toolCache,
              metrics: this.metrics,
              options: opts,
            },
          );
          opts?.sessionLogger?.logStep('mixed_tool_calls', {
            internal: internalCalls.map((tc) => tc.name),
            external: validExternalCalls.map((tc) => tc.name),
          });
        }

        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.setStatus('ok');
        toolLoopSpan.end();
        yield {
          ok: true,
          value: {
            content: '',
            finishReason: 'tool_calls',
            usage: {
              ...usage,
              models: this.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        };
        return;
      }
      if (content || internalCalls.length > 0)
        messages = [
          ...messages,
          {
            role: 'assistant' as const,
            content: content || null,
            tool_calls: internalCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          },
        ];
      // Truncate batch to remaining budget
      const remaining =
        this.config.maxToolCalls !== undefined
          ? this.config.maxToolCalls - toolCallCount
          : internalCalls.length;
      if (remaining <= 0) {
        timingLog.push({ phase: 'total', duration: Date.now() - loopStart });
        toolLoopSpan.addEvent('tool_call_limit_reached');
        toolLoopSpan.end();
        yield {
          ok: true,
          value: {
            content: '',
            finishReason: 'length',
            usage: {
              ...usage,
              models: this.requestLogger.getSummary().byModel,
            },
            timing: timingLog,
          },
        };
        return;
      }
      const batch = internalCalls.slice(0, remaining);
      const heartbeatMs = this.config.heartbeatIntervalMs ?? 5000;

      // Yield all progress messages before execution
      for (const tc of batch) {
        yield {
          ok: true,
          value: { content: `\n\n[SmartAgent: Executing ${tc.name}...]\n` },
        };
      }

      // Execute all tool calls concurrently with heartbeat
      type ToolExecResult = {
        tc: { id: string; name: string; arguments: Record<string, unknown> };
        text: string;
        res: Result<
          { content: string | Record<string, unknown>; isError?: boolean },
          { message: string }
        > | null;
        duration: number;
      };

      const toolExecPromises = batch.map(
        async (tc): Promise<ToolExecResult> => {
          const toolStart = Date.now();
          opts?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
            arguments: tc.arguments,
          });
          const client = toolClientMap.get(tc.name);
          if (!client) return { tc, text: '', res: null, duration: 0 };
          const toolSpan = this.tracer.startSpan('smart_agent.tool_call', {
            parent: toolLoopSpan,
            attributes: { 'tool.name': tc.name },
          });
          const cached = this.toolCache.get(tc.name, tc.arguments);
          const res = cached
            ? (() => {
                this.metrics.toolCacheHitCount.add();
                toolSpan.setAttribute('cache', 'hit');
                return { ok: true as const, value: cached };
              })()
            : await (async () => {
                const r = await client.callTool(tc.name, tc.arguments, opts);
                if (r.ok) this.toolCache.set(tc.name, tc.arguments, r.value);
                return r;
              })();
          const text = !res.ok
            ? res.error.message
            : typeof res.value.content === 'string'
              ? res.value.content
              : JSON.stringify(res.value.content);
          toolSpan.setStatus(
            res.ok ? 'ok' : 'error',
            res.ok ? undefined : text,
          );
          toolSpan.end();
          return { tc, text, res, duration: Date.now() - toolStart };
        },
      );

      // Race: tool execution vs periodic heartbeat
      const allDone = Promise.all(toolExecPromises);
      const pendingTools = new Set(batch.map((tc) => tc.name));
      const toolStartTime = Date.now();
      let results: ToolExecResult[] = [];
      let settled = false;

      // Mark individual tools as done when they resolve
      for (const [i, p] of toolExecPromises.entries()) {
        p.then(() => pendingTools.delete(batch[i].name));
      }

      while (!settled) {
        const winner = await Promise.race([
          allDone.then((r) => ({ tag: 'done' as const, results: r })),
          new Promise<{ tag: 'tick' }>((resolve) =>
            setTimeout(() => resolve({ tag: 'tick' }), heartbeatMs),
          ),
        ]);
        if (winner.tag === 'done') {
          results = winner.results;
          settled = true;
        } else {
          // Yield heartbeat for each still-pending tool
          for (const tool of pendingTools) {
            yield {
              ok: true,
              value: {
                content: '',
                heartbeat: {
                  tool,
                  elapsed: Date.now() - toolStartTime,
                },
              },
            };
          }
        }
      }

      // Collect per-tool timing into the shared timing log
      for (const r of results) {
        timingLog.push({
          phase: `tool_${r.tc.name}`,
          duration: r.duration,
        });
      }

      // Process results: update availability, metrics, messages
      const toolMessages: Message[] = [];
      for (const { tc, text, res } of results) {
        if (!res) continue;
        if (!res.ok && isToolContextUnavailableError(text)) {
          const entry = this.toolAvailabilityRegistry.block(
            sessionId,
            tc.name,
            text,
          );
          currentTools = currentTools.filter((t) => t.name !== tc.name);
          opts?.sessionLogger?.logStep(`tool_blacklisted_${tc.name}`, {
            reason: text,
            blockedUntil: entry.blockedUntil,
          });
        }
        opts?.sessionLogger?.logStep(`mcp_result_${tc.name}`, {
          result: text,
        });
        toolCallCount++;
        this.metrics.toolCallCount.add();
        toolMessages.push({
          role: 'tool' as const,
          content: text,
          tool_call_id: tc.id,
        });
      }
      messages = [...messages, ...toolMessages];
    }
  }

  private async _listAllTools(
    opts: CallOptions | undefined,
  ): Promise<{ tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }> {
    await this._resolveActiveClients(opts);
    const tools: McpTool[] = [];
    const toolClientMap = new Map<string, IMcpClient>();
    const settled = await Promise.allSettled(
      this._activeClients.map(async (client) => ({
        client,
        result: await client.listTools(opts),
      })),
    );
    for (const e of settled) {
      if (e.status === 'fulfilled' && e.value.result.ok) {
        for (const t of e.value.result.value) {
          if (!toolClientMap.has(t.name)) {
            tools.push(t);
            toolClientMap.set(t.name, e.value.client);
          }
        }
      }
    }
    return { tools, toolClientMap };
  }

  private async _toEnglishForRag(
    text: string,
    opts: CallOptions | undefined,
  ): Promise<string> {
    if (/^[\p{ASCII}]+$/u.test(text) || text.length < 15) return text;
    const dp =
      'Translate the user request to English for search purposes. Preserve technical terms if present. Reply with only the expanded English terms, no explanation.';
    const llm = this.deps.helperLlm || this.deps.mainLlm;
    const res = await llm.chat(
      [
        {
          role: 'system' as const,
          content: this.config.ragTranslatePrompt || dp,
        },
        { role: 'user' as const, content: text },
      ],
      [],
      opts,
    );
    return res.ok && res.value.content.trim() ? res.value.content.trim() : text;
  }

  private async _summarizeHistory(
    h: Message[],
    opts?: CallOptions,
  ): Promise<Result<Message[], OrchestratorError>> {
    if (!this.deps.helperLlm) return { ok: true, value: h };
    const toS = h.slice(0, -5);
    const rec = h.slice(-5);
    if (toS.length === 0) return { ok: true, value: h };
    const dp =
      'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';
    const summarizeStart = Date.now();
    const res = await this.deps.helperLlm.chat(
      [
        ...toS,
        {
          role: 'system' as const,
          content: this.config.historySummaryPrompt || dp,
        },
      ],
      [],
      opts,
    );
    this.requestLogger.logLlmCall({
      component: 'helper',
      model: this.deps.helperLlm.model ?? 'unknown',
      promptTokens: res.ok ? (res.value.usage?.promptTokens ?? 0) : 0,
      completionTokens: res.ok ? (res.value.usage?.completionTokens ?? 0) : 0,
      totalTokens: res.ok ? (res.value.usage?.totalTokens ?? 0) : 0,
      durationMs: Date.now() - summarizeStart,
    });
    if (!res.ok) return { ok: true, value: h };
    return {
      ok: true,
      value: [
        {
          role: 'system' as const,
          content: `Summary of previous conversation: ${res.value.content}`,
        },
        ...rec,
      ],
    };
  }

  private _buildRagMetadata(): RagMetadata {
    const p = this.config.sessionPolicy;
    if (!p) return {};
    const m: RagMetadata = {};
    if (p.namespace !== undefined) m.namespace = p.namespace;
    if (p.maxSessionAgeMs !== undefined)
      m.ttl = Math.floor((Date.now() + p.maxSessionAgeMs) / 1000);
    return m;
  }

  /**
   * Execute the structured pipeline — delegates stage execution to
   * the PipelineExecutor instead of running the hardcoded flow.
   */
  private async *_runStructuredPipeline(
    textOrMessages: string | Message[],
    externalTools: LlmTool[],
    opts: CallOptions | undefined,
    parentSpan: ISpan,
    sessionId: string,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (!this.pipelineExecutor || !this.pipelineStages) return;

    const text =
      typeof textOrMessages === 'string'
        ? textOrMessages
        : (textOrMessages.filter((m) => m.role === 'user').slice(-1)[0]
            ?.content ?? '');
    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;

    // Collect yielded chunks via a queue
    const chunkQueue: Result<LlmStreamChunk, OrchestratorError>[] = [];
    let resolveWait: (() => void) | null = null;
    let done = false;

    await this._resolveActiveClients(opts);
    const ctx: PipelineContext = {
      // Immutable input
      textOrMessages,
      options: opts,
      config: this.config,
      sessionId,

      // Dependencies
      mainLlm: this.deps.mainLlm,
      helperLlm: this.deps.helperLlm,
      classifierLlm: this.deps.mainLlm,
      classifier: this.deps.classifier,
      assembler: this.deps.assembler,
      ragStores: this.deps.ragStores,
      mcpClients: this._activeClients,
      reranker: this.reranker,
      queryExpander: this.queryExpander,
      toolCache: this.toolCache,
      outputValidator: this.outputValidator,
      sessionManager: this.sessionManager,
      tracer: this.tracer,
      metrics: this.metrics,
      logger: this.deps.logger,
      requestLogger: this.requestLogger,
      toolPolicy: this.deps.toolPolicy,
      injectionDetector: this.deps.injectionDetector,
      toolAvailabilityRegistry: this.toolAvailabilityRegistry,
      pendingToolResults: this.pendingToolResults,
      skillManager: this.deps.skillManager,
      embedder: this.deps.embedder,

      // Mutable state
      inputText: text,
      history: [...history],
      subprompts: [],
      toolClientMap: new Map(),
      ragText: '',
      ragResults: Object.fromEntries(
        Object.keys(this.deps.ragStores).map((k) => [k, []]),
      ),
      mcpTools: [],
      selectedTools: [],
      externalTools,
      assembledMessages: [],
      activeTools: [],
      selectedSkills: [],
      skillContent: '',
      skillArgs: '',
      queryEmbedding: undefined,

      // Control flags
      shouldRetrieve: false,
      isAscii: true,
      isSapRequired: false,

      // Output
      timing: [],

      // Streaming yield
      yield: (chunk) => {
        chunkQueue.push(chunk);
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      },
    };

    // Run executor in background, yield chunks as they arrive
    const executorPromise = this.pipelineExecutor
      .executeStages(this.pipelineStages, ctx, parentSpan)
      .then(() => {
        done = true;
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      })
      .catch((err) => {
        chunkQueue.push({
          ok: false,
          error: new OrchestratorError(String(err), 'PIPELINE_ERROR'),
        });
        done = true;
        if (resolveWait) {
          resolveWait();
          resolveWait = null;
        }
      });

    while (!done || chunkQueue.length > 0) {
      if (chunkQueue.length > 0) {
        const chunk = chunkQueue.shift();
        if (chunk !== undefined) yield chunk;
      } else if (!done) {
        await new Promise<void>((r) => {
          resolveWait = r;
        });
      }
    }

    await executorPromise;
  }
}
