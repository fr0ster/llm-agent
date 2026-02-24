import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import {
  type CallOptions,
  type LlmStreamChunk,
  type LlmTool,
  type McpTool,
  type RagMetadata,
  type RagResult,
  type Result,
  SmartAgentError,
  type Subprompt,
} from './interfaces/types.js';
import type { ILogger } from './logger/index.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';

// ---------------------------------------------------------------------------
// OrchestratorError
// ---------------------------------------------------------------------------

export class OrchestratorError extends SmartAgentError {
  constructor(message: string, code = 'ORCHESTRATOR_ERROR') {
    super(message, code);
    this.name = 'OrchestratorError';
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SmartAgentRagStores {
  facts: IRag;
  feedback: IRag;
  state: IRag;
}

export interface SmartAgentDeps {
  mainLlm: ILlm;
  /** Reserved for future phases; not used in Phase 6. */
  helperLlm?: ILlm;
  mcpClients: IMcpClient[];
  ragStores: SmartAgentRagStores;
  classifier: ISubpromptClassifier;
  assembler: IContextAssembler;
  logger?: ILogger;
  /** Optional tool execution policy. When absent, all tools are allowed. */
  toolPolicy?: IToolPolicy;
  /** Optional prompt-injection detector. When absent, detection is skipped. */
  injectionDetector?: IPromptInjectionDetector;
}

export interface SmartAgentConfig {
  /** Max number of LLM requests in the tool loop. */
  maxIterations: number;
  /** Max total tool executions across all iterations. */
  maxToolCalls?: number;
  /** Timeout for the entire request pipeline in ms. */
  timeoutMs?: number;
  /** Passed to assembler via CallOptions. */
  tokenLimit?: number;
  /** Number of RAG results to retrieve. Default: 5. */
  ragQueryK?: number;
  /**
   * Master enable/disable switch. When false, process() returns DISABLED immediately.
   * Default: true (undefined = enabled).
   */
  smartAgentEnabled?: boolean;
  /** Data governance policy: namespace isolation and TTL for RAG records. */
  sessionPolicy?: SessionPolicy;
}

export type StopReason = 'stop' | 'iteration_limit' | 'tool_call_limit';

export interface SmartAgentResponse {
  content: string;
  iterations: number;
  toolCallCount: number;
  stopReason: StopReason;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Merges ≥1 AbortSignals into a single AbortController. */
function mergeSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortController {
  const ctrl = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      return ctrl;
    }
    signal.addEventListener('abort', () => ctrl.abort(signal.reason), {
      once: true,
    });
  }
  return ctrl;
}

/** Creates a signal that aborts after `ms` ms. Returns a cleanup function. */
function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  clear: () => void;
} {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('Timeout')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// ---------------------------------------------------------------------------
// SmartAgent
// ---------------------------------------------------------------------------

export class SmartAgent {
  private readonly deps: SmartAgentDeps;
  private readonly config: SmartAgentConfig;

  constructor(deps: SmartAgentDeps, config: SmartAgentConfig) {
    this.deps = deps;
    this.config = config;
  }

  async process(
    textOrMessages: string | Message[],
    options?: CallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const text = typeof textOrMessages === 'string'
      ? textOrMessages
      : textOrMessages.filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';

    // Step 0: smartAgentEnabled guard
    if (this.config.smartAgentEnabled === false) {
      return {
        ok: false,
        error: new OrchestratorError('SmartAgent is disabled', 'DISABLED'),
      };
    }

    // Step 1: pre-abort check
    if (options?.signal?.aborted) {
      return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
    }

    const traceId = options?.trace?.traceId ?? randomUUID();
    const pipelineT0 = Date.now();

    // Step 2: set up timeout + merge signals
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;

    if (this.config.timeoutMs) {
      const { signal: timeoutSignal, clear } = createTimeoutSignal(
        this.config.timeoutMs,
      );
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, timeoutSignal);
      opts = { ...options, signal: merged.signal };
    }

    // Step 3: run pipeline with cleanup guarantee
    try {
      const result = await this._runPipeline(textOrMessages, opts, traceId, pipelineT0);
      const durationMs = Date.now() - pipelineT0;
      if (result.ok) {
        this.deps.logger?.log({
          type: 'pipeline_done',
          traceId,
          stopReason: result.value.stopReason,
          iterations: result.value.iterations,
          toolCallCount: result.value.toolCallCount,
          durationMs,
        });
      } else {
        this.deps.logger?.log({
          type: 'pipeline_error',
          traceId,
          code: result.error.code,
          message: result.error.message,
          durationMs,
        });
      }
      return result;
    } finally {
      timeoutCleanup?.();
    }
  }

  async *streamProcess(
    textOrMessages: string | Message[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    // 0. enabled guard
    if (this.config.smartAgentEnabled === false) {
      yield {
        ok: false,
        error: new OrchestratorError('SmartAgent is disabled', 'DISABLED'),
      };
      return;
    }

    const traceId = options?.trace?.traceId ?? randomUUID();
    const pipelineT0 = Date.now();

    // Setup timeout/signal
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) {
      const { signal: timeoutSignal, clear } = createTimeoutSignal(
        this.config.timeoutMs,
      );
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, timeoutSignal);
      opts = { ...options, signal: merged.signal };
    }

    try {
      // Run pipeline up to tool loop
      // For streaming, we mostly care about the final tool loop call
      // We can't reuse _runPipeline easily because it returns a Promise.
      // I'll refactor _runPipeline to return the state needed for _runToolLoop.

      const preLoop = await this._preparePipeline(textOrMessages, opts, traceId, pipelineT0);
      if (!preLoop.ok) {
        yield preLoop;
        return;
      }

      const { action, retrieved, messages, toolClientMap } = preLoop.value;

      // Run tool loop with streaming for the final call
      const stream = this._runStreamingToolLoop(
        action,
        retrieved,
        messages,
        toolClientMap,
        opts,
        traceId,
      );

      for await (const chunk of stream) {
        yield chunk;
      }
    } finally {
      timeoutCleanup?.();
    }
  }

  // -------------------------------------------------------------------------
  // Private: pipeline steps 4–13
  // -------------------------------------------------------------------------

  private async _preparePipeline(
    textOrMessages: string | Message[],
    opts: CallOptions | undefined,
    traceId: string,
    pipelineT0: number,
  ): Promise<Result<{
    action: Subprompt;
    retrieved: any;
    messages: Message[];
    toolClientMap: Map<string, IMcpClient>;
  }, OrchestratorError>> {
    const logger = this.deps.logger;
    const text = typeof textOrMessages === 'string'
      ? textOrMessages
      : textOrMessages.filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';

    // Step 3.5: prompt-injection detection (before classification)
    if (this.deps.injectionDetector) {
      const detection = this.deps.injectionDetector.detect(text);
      if (detection.detected) {
        logger?.log({
          type: 'pipeline_error',
          traceId,
          code: 'PROMPT_INJECTION',
          message: `Injection detected: pattern=${detection.pattern ?? 'unknown'}`,
          durationMs: Date.now() - pipelineT0,
        });
        return {
          ok: false,
          error: new OrchestratorError(
            `Prompt injection detected: pattern=${detection.pattern ?? 'unknown'}`,
            'PROMPT_INJECTION',
          ),
        };
      }
    }

    // Step 4: classify
    const classifyT0 = Date.now();
    const classifyResult = await this.deps.classifier.classify(text, opts);
    logger?.log({
      type: 'classify',
      traceId,
      inputLength: text.length,
      subpromptCount: classifyResult.ok ? classifyResult.value.length : 0,
      durationMs: Date.now() - classifyT0,
    });
    if (!classifyResult.ok) {
      const code =
        classifyResult.error.code === 'ABORTED'
          ? 'ABORTED'
          : 'CLASSIFIER_ERROR';
      return {
        ok: false,
        error: new OrchestratorError(classifyResult.error.message, code),
      };
    }

    const subprompts = classifyResult.value;

    // Step 5: split into actions vs. non-actions
    const actions = subprompts.filter((sp) => sp.type === 'action');
    const others = subprompts.filter((sp) => sp.type !== 'action');

    // Step 6: upsert non-action subprompts (non-fatal)
    const ragStoreMap = new Map<string, IRag>([
      ['fact', this.deps.ragStores.facts],
      ['feedback', this.deps.ragStores.feedback],
      ['state', this.deps.ragStores.state],
    ]);
    await Promise.allSettled(
      others.map(async (sp) => {
        const store = ragStoreMap.get(sp.type);
        if (!store) return;
        const t0 = Date.now();
        await store.upsert(sp.text, this._buildRagMetadata(), opts);
        logger?.log({
          type: 'rag_upsert',
          traceId,
          store: sp.type,
          durationMs: Date.now() - t0,
        });
      }),
    );

    // Step 7: no actions
    if (actions.length === 0) {
      return {
        ok: false,
        error: new OrchestratorError('No actions found in prompt', 'NO_ACTIONS'),
      };
    }

    // Step 8: take first action
    const action = actions[0];

    // Step 9: RAG retrieval
    const ragText = await this._toEnglishForRag(action.text, opts);
    logger?.log({ type: 'rag_translate', traceId, original: action.text, translated: ragText });

    const k = this.config.ragQueryK ?? 5;
    const timeQuery = async (store: IRag, storeName: string) => {
      const t0 = Date.now();
      const result = await store.query(ragText, k, opts);
      logger?.log({
        type: 'rag_query',
        traceId,
        store: storeName,
        k,
        resultCount: result.ok ? result.value.length : 0,
        durationMs: Date.now() - t0,
      });
      return result;
    };
    const [factsR, feedbackR, stateR] = await Promise.all([
      timeQuery(this.deps.ragStores.facts, 'facts'),
      timeQuery(this.deps.ragStores.feedback, 'feedback'),
      timeQuery(this.deps.ragStores.state, 'state'),
    ]);
    const facts: RagResult[] = factsR.ok ? factsR.value : [];
    const feedback: RagResult[] = feedbackR.ok ? feedbackR.value : [];
    const state: RagResult[] = stateR.ok ? stateR.value : [];

    // Step 10: list all MCP tools
    const { tools: mcpTools, toolClientMap } = await this._listAllTools(opts);

    // Step 10.5: filter tools to RAG-selected ones.
    const ragToolNames = new Set(
      facts
        .map((r) => r.metadata.id as string | undefined)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('tool:'))
        .map((id) => id.slice('tool:'.length)),
    );
    const selectedTools =
      ragToolNames.size > 0
        ? mcpTools.filter((t) => ragToolNames.has(t.name))
        : mcpTools;
    logger?.log({
      type: 'tools_selected',
      traceId,
      total: mcpTools.length,
      selected: selectedTools.length,
      names: selectedTools.map((t) => t.name),
    });

    // Step 11: initial context assembly
    const retrieved = { facts, feedback, state, tools: selectedTools };
    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;
    const assembleResult = await this.deps.assembler.assemble(
      action,
      retrieved,
      history,
      opts,
    );
    if (!assembleResult.ok) {
      const code =
        assembleResult.error.code === 'ABORTED' ? 'ABORTED' : 'ASSEMBLER_ERROR';
      return {
        ok: false,
        error: new OrchestratorError(assembleResult.error.message, code),
      };
    }

    return {
      ok: true,
      value: {
        action,
        retrieved,
        messages: assembleResult.value,
        toolClientMap,
      },
    };
  }

  private async _runPipeline(
    textOrMessages: string | Message[],
    opts: CallOptions | undefined,
    traceId: string,
    pipelineT0: number,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const preLoop = await this._preparePipeline(textOrMessages, opts, traceId, pipelineT0);
    if (!preLoop.ok) {
      // Special case: no actions means empty response (valid success)
      if (preLoop.error.code === 'NO_ACTIONS') {
        return {
          ok: true,
          value: {
            content: '',
            iterations: 0,
            toolCallCount: 0,
            stopReason: 'stop',
          },
        };
      }
      return preLoop;
    }

    const { action, retrieved, messages, toolClientMap } = preLoop.value;

    // Step 12: tool loop
    return this._runToolLoop(
      action,
      retrieved,
      messages,
      toolClientMap,
      opts,
      traceId,
    );
  }

  private async *_runStreamingToolLoop(
    _action: Subprompt,
    retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    traceId: string,
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    const logger = this.deps.logger;
    let toolCallCount = 0;
    let messages = initialMessages;

    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) {
        yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
        return;
      }

      if (iteration >= this.config.maxIterations) {
        yield {
          ok: true,
          value: { content: '', finishReason: 'length' },
        };
        return;
      }

      // We don't know if this is the last iteration yet.
      // But we can try to call chat() first to see if it wants tool calls.
      // If it DOES NOT want tool calls, we should have used streamChat().
      // This is a bit tricky. A better way: always use chat() until it's a stop reason.
      // Then, re-run the final call with streamChat(). 
      // Downside: double call for the final message. 
      // Alternative: always stream and buffer tool calls.

      const llmT0 = Date.now();
      const resp = await this.deps.mainLlm.chat(
        messages,
        retrieved.tools as LlmTool[],
        opts,
      );

      if (!resp.ok) {
        yield {
          ok: false,
          error: new OrchestratorError(resp.error.message, 'LLM_ERROR'),
        };
        return;
      }

      const toolCalls = resp.value.toolCalls;

      // No tool calls → this was the final response. 
      // To provide a real stream, we should have streamed this. 
      // Since we already have the full response, we yield it as one chunk or split it.
      if (resp.value.finishReason !== 'tool_calls' || !toolCalls?.length) {
        yield {
          ok: true,
          value: {
            content: resp.value.content,
            finishReason: resp.value.finishReason,
            usage: resp.value.usage,
          },
        };
        return;
      }

      // Handle tool calls (same logic as _runToolLoop)
      messages = [
        ...messages,
        {
          role: 'assistant' as const,
          content: resp.value.content || '',
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

      for (const toolCall of toolCalls) {
        if (
          this.config.maxToolCalls !== undefined &&
          toolCallCount >= this.config.maxToolCalls
        ) {
          yield { ok: true, value: { content: '', finishReason: 'length' } };
          return;
        }

        const toolT0 = Date.now();
        let resultContent: string;

        const client = toolClientMap.get(toolCall.name);
        if (!client) {
          resultContent = `Tool "${toolCall.name}" not found`;
        } else {
          const callResult = await client.callTool(
            toolCall.name,
            toolCall.arguments,
            opts,
          );
          resultContent = !callResult.ok
            ? callResult.error.message
            : typeof callResult.value.content === 'string'
              ? callResult.value.content
              : JSON.stringify(callResult.value.content);
        }

        logger?.log({
          type: 'tool_call',
          traceId,
          toolName: toolCall.name,
          isError: false,
          durationMs: Date.now() - toolT0,
        });
        toolCallCount++;

        messages = [
          ...messages,
          {
            role: 'tool' as const,
            content: resultContent,
            tool_call_id: toolCall.id,
          },
        ];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: list tools from all clients (non-fatal per client)
  // -------------------------------------------------------------------------

  private async _listAllTools(opts: CallOptions | undefined): Promise<{
    tools: McpTool[];
    toolClientMap: Map<string, IMcpClient>;
  }> {
    const tools: McpTool[] = [];
    const toolClientMap = new Map<string, IMcpClient>();

    const settled = await Promise.allSettled(
      this.deps.mcpClients.map(async (client) => {
        const result = await client.listTools(opts);
        return { client, result };
      }),
    );

    for (const entry of settled) {
      if (entry.status === 'rejected') continue;
      const { client, result } = entry.value;
      if (!result.ok) continue;
      for (const tool of result.value) {
        if (!toolClientMap.has(tool.name)) {
          tools.push(tool);
          toolClientMap.set(tool.name, client);
        }
      }
    }

    return { tools, toolClientMap };
  }

  // -------------------------------------------------------------------------
  // Private: LLM + tool execution loop
  // -------------------------------------------------------------------------

  private async _runToolLoop(
    _action: Subprompt,
    retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    traceId: string,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const logger = this.deps.logger;
    let toolCallCount = 0;
    // Maintain the full conversation history; initialMessages comes from the
    // assembler (system + user context). We append assistant/tool messages
    // directly — OpenAI/DeepSeek protocol requires the assistant message with
    // tool_calls to precede the corresponding tool result messages.
    let messages = initialMessages;
    let content = '';
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let iteration = 0; ; iteration++) {
      // Abort check at top of each iteration
      if (opts?.signal?.aborted) {
        return {
          ok: false,
          error: new OrchestratorError('Aborted', 'ABORTED'),
        };
      }

      // Iteration limit guard
      if (iteration >= this.config.maxIterations) {
        return {
          ok: true,
          value: {
            content,
            iterations: iteration,
            toolCallCount,
            stopReason: 'iteration_limit',
            usage,
          },
        };
      }

      // LLM call — McpTool and LlmTool are structurally identical; cast directly
      const llmT0 = Date.now();
      const resp = await this.deps.mainLlm.chat(
        messages,
        retrieved.tools as LlmTool[],
        opts,
      );

      if (resp.ok && resp.value.usage) {
        usage.promptTokens += resp.value.usage.promptTokens;
        usage.completionTokens += resp.value.usage.completionTokens;
        usage.totalTokens += resp.value.usage.totalTokens;
      }

      logger?.log({
        type: 'llm_call',
        traceId,
        iteration,
        finishReason: resp.ok ? resp.value.finishReason : 'error',
        durationMs: Date.now() - llmT0,
      });
      if (!resp.ok) {
        const code = resp.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR';
        return {
          ok: false,
          error: new OrchestratorError(resp.error.message, code),
        };
      }

      content = resp.value.content;
      const toolCalls = resp.value.toolCalls;

      // No tool calls → done
      if (resp.value.finishReason !== 'tool_calls' || !toolCalls?.length) {
        return {
          ok: true,
          value: {
            content,
            iterations: iteration + 1,
            toolCallCount,
            stopReason: 'stop',
            usage,
          },
        };
      }

      // Append assistant message with tool_calls to conversation history.
      // This is required by the OpenAI/DeepSeek protocol before tool results.
      messages = [
        ...messages,
        {
          role: 'assistant' as const,
          content: content || '',
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

      // Execute each tool call and append result messages
      for (const toolCall of toolCalls) {
        if (
          this.config.maxToolCalls !== undefined &&
          toolCallCount >= this.config.maxToolCalls
        ) {
          return {
            ok: true,
            value: {
              content,
              iterations: iteration + 1,
              toolCallCount,
              stopReason: 'tool_call_limit',
              usage,
            },
          };
        }

        const toolT0 = Date.now();
        let isError = false;
        let resultContent: string;

        // Policy check — before client lookup
        if (this.deps.toolPolicy) {
          const verdict = this.deps.toolPolicy.check(toolCall.name);
          if (!verdict.allowed) {
            isError = true;
            resultContent =
              verdict.reason ?? `Tool "${toolCall.name}" blocked by policy`;
            logger?.log({
              type: 'tool_call',
              traceId,
              toolName: toolCall.name,
              isError: true,
              durationMs: Date.now() - toolT0,
            });
            toolCallCount++;
            messages = [
              ...messages,
              {
                role: 'tool' as const,
                content: resultContent,
                tool_call_id: toolCall.id,
              },
            ];
            continue;
          }
        }

        const client = toolClientMap.get(toolCall.name);
        if (!client) {
          isError = true;
          resultContent = `Tool "${toolCall.name}" not found`;
        } else {
          const callResult = await client.callTool(
            toolCall.name,
            toolCall.arguments,
            opts,
          );
          if (!callResult.ok) {
            isError = true;
            resultContent = callResult.error.message;
          } else {
            resultContent =
              typeof callResult.value.content === 'string'
                ? callResult.value.content
                : JSON.stringify(callResult.value.content);
          }
        }

        logger?.log({
          type: 'tool_call',
          traceId,
          toolName: toolCall.name,
          isError,
          durationMs: Date.now() - toolT0,
        });
        toolCallCount++;

        // Append tool result with tool_call_id (required by OpenAI/DeepSeek protocol)
        messages = [
          ...messages,
          {
            role: 'tool' as const,
            content: resultContent,
            tool_call_id: toolCall.id,
          },
        ];
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private: RAG metadata builder (data governance)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Private: translate action text to English for cross-lingual RAG matching
  // -------------------------------------------------------------------------

  /** Returns an English translation of `text` for RAG queries.
   *  If `text` is already ASCII (English), returns it unchanged.
   *  Falls back to the original on LLM error. */
  private async _toEnglishForRag(
    text: string,
    opts: CallOptions | undefined,
  ): Promise<string> {
    // Skip translation if already ASCII (covers English + SAP identifiers)
    if (/^[\x00-\x7F]+$/.test(text)) return text;

    const result = await this.deps.mainLlm.chat(
      [
        {
          role: 'system',
          content:
            'You are an SAP ABAP expert. Translate the following user request to English and expand it with relevant SAP technical terms: ABAP object types, SAP table names (e.g. TDEVC for packages, TADIR for repository objects, T100 for messages), operation keywords (read, search, filter, list, create, update), and function descriptors. This expansion is used for semantic tool search. Reply with only the expanded English terms, no explanation.',
        },
        { role: 'user', content: text },
      ],
      [],
      opts,
    );
    return result.ok && result.value.content.trim() ? result.value.content.trim() : text;
  }

  // -------------------------------------------------------------------------
  // Private: RAG metadata builder (data governance)
  // -------------------------------------------------------------------------

  private _buildRagMetadata(): RagMetadata {
    const policy = this.config.sessionPolicy;
    if (!policy) return {};
    const metadata: RagMetadata = {};
    if (policy.namespace !== undefined) {
      metadata.namespace = policy.namespace;
    }
    if (policy.maxSessionAgeMs !== undefined) {
      metadata.ttl = Math.floor((Date.now() + policy.maxSessionAgeMs) / 1000);
    }
    return metadata;
  }
}
