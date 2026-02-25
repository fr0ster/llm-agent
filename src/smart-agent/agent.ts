import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import { ThinkingStreamParser } from './utils/thinking-stream-parser.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import {
  type CallOptions,
  type LlmStreamChunk,
  type LlmTool,
  type LlmToolCall,
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
   * Minimum cosine similarity score for a RAG result to be included in the LLM
   * context. Results below this threshold are discarded.
   *
   * - When a tool fact's score is below the threshold it is excluded from both
   *   `## Known Facts` and the `tools` parameter sent to the LLM.
   * - If ALL tool facts are excluded the LLM receives NO tools and answers
   *   freely (e.g. a math question with an ABAP-only MCP server).
   * - The threshold only applies to the facts store. feedback / state results
   *   are always included (they carry session context, not tool descriptions).
   * - Set to 0 (default) to disable filtering and keep current behaviour.
   */
  ragMinScore?: number;
  /**
   * Master enable/disable switch. When false, process() returns DISABLED immediately.
   * Default: true (undefined = enabled).
   */
  smartAgentEnabled?: boolean;
  /** Data governance policy: namespace isolation and TTL for RAG records. */
  sessionPolicy?: SessionPolicy;
  /**
   * When true, injects a reasoning instruction into the system prompt and
   * parses <thinking>/<reasoning> blocks from streamed text, re-emitting them
   * as { type: 'reasoning' } chunks in processStream().
   */
  llmReasoning?: boolean;
  /**
   * System prompt used when translating non-ASCII user text to English for
   * cross-lingual RAG matching. Override to match your domain.
   * Default: neutral translation instruction.
   */
  ragTranslationPrompt?: string;
  /**
   * Instruction appended to the system message when `llmReasoning` is true.
   * Override to customise the reasoning format.
   * Default: instructs the LLM to use <thinking> tags.
   */
  reasoningPrompt?: string;
}

export type StopReason = 'stop' | 'iteration_limit' | 'tool_call_limit';

export interface SmartAgentResponse {
  content: string;
  iterations: number;
  toolCallCount: number;
  stopReason: StopReason;
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
    text: string,
    options?: CallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
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
      const result = await this._runPipeline(text, opts, traceId, pipelineT0);
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

  // -------------------------------------------------------------------------
  // Private: pipeline steps 4–13
  // -------------------------------------------------------------------------

  private async _runPipeline(
    text: string,
    opts: CallOptions | undefined,
    traceId: string,
    pipelineT0: number,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const logger = this.deps.logger;

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
      subprompts: classifyResult.ok ? classifyResult.value.map((sp) => ({ type: sp.type, text: sp.text })) : [],
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

    // Step 7: no actions → empty response
    if (actions.length === 0) {
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

    // Step 8: merge all action subprompts into one compound action so that
    // requests like "Add 5 and 9. Read table T100 structure." are fully handled.
    // Multiple actions are joined with newlines; single action is used as-is.
    const action: Subprompt = actions.length === 1
      ? actions[0]
      : { type: 'action', text: actions.map((a) => a.text).join('\n') };

    // Step 9: RAG retrieval (non-fatal — failures fall back to [])
    // Tools are vectorized in English; translate the action to English first so
    // that cross-lingual queries (e.g. Ukrainian) get accurate cosine matches.
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
        results: result.ok
          ? result.value.map((r) => ({ score: r.score, id: r.metadata.id, text: r.text.slice(0, 120) }))
          : [],
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
    // Tools are vectorized at startup with metadata.id = "tool:<name>".
    // RAG query returns the most relevant tool descriptions — use their ids
    // to select only those tools as native function definitions for the LLM.
    //
    // Score filtering: facts below ragMinScore are excluded so the LLM is not
    // offered irrelevant tools (e.g. ABAP tools for a math question).
    // Fallback to ALL tools only when the facts store is empty (tools not yet
    // vectorized), never when store has entries but none passed the threshold.
    const minScore = this.config.ragMinScore ?? 0;
    const relevantFacts = minScore > 0
      ? facts.filter((r) => r.score >= minScore)
      : facts;
    const ragToolNames = new Set(
      relevantFacts
        .map((r) => r.metadata.id as string | undefined)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('tool:'))
        .map((id) => id.slice('tool:'.length)),
    );
    const toolsVectorized = facts.length > 0; // store is non-empty → tools were indexed
    const selectedTools = toolsVectorized
      ? mcpTools.filter((t) => ragToolNames.has(t.name)) // empty set → no tools offered
      : mcpTools; // fallback: tools not indexed yet → offer all
    logger?.log({
      type: 'tools_selected',
      traceId,
      total: mcpTools.length,
      minScore,
      relevantFactsCount: relevantFacts.length,
      selected: selectedTools.length,
      names: selectedTools.map((t) => t.name),
      filteredOut: facts.length - relevantFacts.length,
    });

    // Step 11: initial context assembly
    // Use relevantFacts (score-filtered) so that low-score tool descriptions
    // are not injected into ## Known Facts in the system message.
    const retrieved = { facts: relevantFacts, feedback, state, tools: selectedTools };
    const assembleResult = await this.deps.assembler.assemble(
      action,
      retrieved,
      [],
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

    // Step 12: tool loop
    const initialMessages = this.config.llmReasoning
      ? this._injectReasoningInstruction(assembleResult.value)
      : assembleResult.value;

    return this._runToolLoop(
      action,
      retrieved,
      initialMessages,
      toolClientMap,
      opts,
      traceId,
    );
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
          },
        };
      }

      // LLM call — McpTool and LlmTool are structurally identical; cast directly
      const llmT0 = Date.now();
      // Log what context is sent to LLM before the call
      const sysMsg = messages.find((m) => m.role === 'system');
      logger?.log({
        type: 'llm_context',
        traceId,
        iteration,
        messageCount: messages.length,
        toolCount: retrieved.tools.length,
        toolNames: retrieved.tools.map((t) => t.name),
        systemPromptPreview: sysMsg ? (sysMsg.content as string).slice(0, 300) : null,
      });
      logger?.log({
        type: 'llm_request',
        traceId,
        iteration,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
        toolNames: (retrieved.tools as LlmTool[]).map((t) => t.name),
      });
      const resp = await this.deps.mainLlm.chat(
        messages,
        retrieved.tools as LlmTool[],
        opts,
      );
      logger?.log({
        type: 'llm_call',
        traceId,
        iteration,
        finishReason: resp.ok ? resp.value.finishReason : 'error',
        toolCallsRequested: resp.ok ? (resp.value.toolCalls?.length ?? 0) : 0,
        durationMs: Date.now() - llmT0,
      });
      if (resp.ok) {
        logger?.log({
          type: 'llm_response',
          traceId,
          iteration,
          content: resp.value.content,
          toolCalls: resp.value.toolCalls?.map((tc) => ({ name: tc.name, arguments: tc.arguments })) ?? [],
          finishReason: resp.value.finishReason,
        });
      }
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
  // Private: inject reasoning instruction into assembled messages
  // -------------------------------------------------------------------------

  private _injectReasoningInstruction(messages: Message[]): Message[] {
    const DEFAULT_REASONING_PROMPT =
      '\n\nBefore every response, tool call, or decision, explain your ' +
      'reasoning inside <thinking>...</thinking> tags. Be thorough and show ' +
      'your thought process. After the thinking block, give your actual response.';
    const INSTRUCTION = this.config.reasoningPrompt
      ? `\n\n${this.config.reasoningPrompt}`
      : DEFAULT_REASONING_PROMPT;

    const sysIdx = messages.findIndex((m) => m.role === 'system');
    if (sysIdx === -1) {
      return [{ role: 'system', content: INSTRUCTION.trim() }, ...messages];
    }
    return messages.map((m, i) =>
      i === sysIdx ? { ...m, content: m.content + INSTRUCTION } : m,
    );
  }

  // -------------------------------------------------------------------------
  // Private: RAG metadata builder (data governance)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Private: translate action text to English for cross-lingual RAG matching
  // -------------------------------------------------------------------------

  /**
   * Translates non-ASCII `text` to English for cross-lingual RAG matching.
   *
   * MCP tool descriptions are always in English, so users who write in other
   * languages need their query translated before the cosine similarity search.
   * The prompt must be domain-neutral — any domain bias causes ambiguous words
   * to be mis-translated (e.g. "Склади" → "Warehouses" instead of "Add").
   *
   * Alternative: switch to a multilingual embedding model (e.g.
   * `multilingual-e5-base`) — then translation is unnecessary and this step
   * can be disabled by setting `ragTranslationPrompt` to an empty string.
   */
  private async _toEnglishForRag(
    text: string,
    opts: CallOptions | undefined,
  ): Promise<string> {
    // Skip if already ASCII (English text, SAP identifiers, etc.)
    if (/^[\x00-\x7F]+$/.test(text)) return text;

    // Empty string disables translation (e.g. when using a multilingual model).
    if (this.config.ragTranslationPrompt === '') return text;

    const DEFAULT_TRANSLATION_PROMPT =
      'Translate the following text to English, preserving the exact original ' +
      'intent. Do not add domain-specific context or reinterpret ambiguous words. ' +
      'Reply with only the translation, no explanation.';

    const result = await this.deps.mainLlm.chat(
      [
        { role: 'system', content: this.config.ragTranslationPrompt ?? DEFAULT_TRANSLATION_PROMPT },
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

  // -------------------------------------------------------------------------
  // Public: streaming pipeline
  // -------------------------------------------------------------------------

  /**
   * Streaming version of `process()`.
   * Yields LlmStreamChunk objects as tokens arrive from the LLM.
   * Tool-call events are yielded between loop iterations.
   * Always ends with a { type: 'done' } chunk.
   */
  async *processStream(
    text: string,
    options?: CallOptions,
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    if (this.config.smartAgentEnabled === false) {
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    if (options?.signal?.aborted) {
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    const traceId = options?.trace?.traceId ?? randomUUID();
    const pipelineT0 = Date.now();

    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;

    if (this.config.timeoutMs) {
      const { signal: timeoutSignal, clear } = createTimeoutSignal(this.config.timeoutMs);
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, timeoutSignal);
      opts = { ...options, signal: merged.signal };
    }

    try {
      yield* this._runPipelineStream(text, opts, traceId, pipelineT0);
    } finally {
      timeoutCleanup?.();
    }
  }

  private async *_runPipelineStream(
    text: string,
    opts: CallOptions | undefined,
    traceId: string,
    pipelineT0: number,
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const logger = this.deps.logger;

    // Injection detection
    if (this.deps.injectionDetector) {
      const detection = this.deps.injectionDetector.detect(text);
      if (detection.detected) {
        logger?.log({ type: 'pipeline_error', traceId, code: 'PROMPT_INJECTION', message: `Injection detected`, durationMs: Date.now() - pipelineT0 });
        yield { type: 'done', finishReason: 'error' };
        return;
      }
    }

    // Classify
    const classifyT0Stream = Date.now();
    const classifyResult = await this.deps.classifier.classify(text, opts);
    logger?.log({
      type: 'classify',
      traceId,
      inputLength: text.length,
      subpromptCount: classifyResult.ok ? classifyResult.value.length : 0,
      subprompts: classifyResult.ok ? classifyResult.value.map((sp) => ({ type: sp.type, text: sp.text })) : [],
      durationMs: Date.now() - classifyT0Stream,
    });
    if (!classifyResult.ok) {
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    const subprompts = classifyResult.value;
    const actions = subprompts.filter((sp) => sp.type === 'action');
    const others = subprompts.filter((sp) => sp.type !== 'action');

    // Upsert non-actions (non-fatal)
    const ragStoreMap = new Map<string, IRag>([
      ['fact', this.deps.ragStores.facts],
      ['feedback', this.deps.ragStores.feedback],
      ['state', this.deps.ragStores.state],
    ]);
    await Promise.allSettled(
      others.map((sp) => {
        const store = ragStoreMap.get(sp.type);
        return store?.upsert(sp.text, this._buildRagMetadata(), opts);
      }),
    );

    if (actions.length === 0) {
      yield { type: 'done', finishReason: 'stop' };
      return;
    }

    // Step 8 (stream): merge all action subprompts into one compound action so that
    // requests like "Add 5 and 9. Read table T100 structure." are fully handled.
    const action: Subprompt = actions.length === 1
      ? actions[0]
      : { type: 'action', text: actions.map((a) => a.text).join('\n') };

    // RAG retrieval
    const ragText = await this._toEnglishForRag(action.text, opts);
    logger?.log({ type: 'rag_translate', traceId, original: action.text, translated: ragText });
    const k = this.config.ragQueryK ?? 5;
    const streamQuery = async (store: IRag, storeName: string) => {
      const t0 = Date.now();
      const result = await store.query(ragText, k, opts);
      logger?.log({
        type: 'rag_query',
        traceId,
        store: storeName,
        k,
        resultCount: result.ok ? result.value.length : 0,
        results: result.ok
          ? result.value.map((r) => ({ score: r.score, id: r.metadata.id, text: r.text.slice(0, 120) }))
          : [],
        durationMs: Date.now() - t0,
      });
      return result;
    };
    const [factsR, feedbackR, stateR] = await Promise.all([
      streamQuery(this.deps.ragStores.facts, 'facts'),
      streamQuery(this.deps.ragStores.feedback, 'feedback'),
      streamQuery(this.deps.ragStores.state, 'state'),
    ]);
    const facts: RagResult[] = factsR.ok ? factsR.value : [];
    const feedback: RagResult[] = feedbackR.ok ? feedbackR.value : [];
    const state: RagResult[] = stateR.ok ? stateR.value : [];

    // List tools
    const { tools: mcpTools, toolClientMap } = await this._listAllTools(opts);
    const minScore = this.config.ragMinScore ?? 0;
    const relevantFacts = minScore > 0
      ? facts.filter((r) => r.score >= minScore)
      : facts;
    const ragToolNames = new Set(
      relevantFacts
        .map((r) => r.metadata.id as string | undefined)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('tool:'))
        .map((id) => id.slice('tool:'.length)),
    );
    const toolsVectorized = facts.length > 0;
    const selectedTools = toolsVectorized
      ? mcpTools.filter((t) => ragToolNames.has(t.name))
      : mcpTools;
    logger?.log({
      type: 'tools_selected',
      traceId,
      total: mcpTools.length,
      minScore,
      relevantFactsCount: relevantFacts.length,
      selected: selectedTools.length,
      names: selectedTools.map((t) => t.name),
      filteredOut: facts.length - relevantFacts.length,
    });

    // Assemble initial context — use relevantFacts to avoid injecting
    // low-score tool descriptions into the system message.
    const retrieved = { facts: relevantFacts, feedback, state, tools: selectedTools };
    const assembleResult = await this.deps.assembler.assemble(action, retrieved, [], opts);
    if (!assembleResult.ok) {
      yield { type: 'done', finishReason: 'error' };
      return;
    }

    // Log context going into LLM
    const sysMsg = assembleResult.value.find((m) => m.role === 'system');
    logger?.log({
      type: 'llm_context',
      traceId,
      iteration: 0,
      messageCount: assembleResult.value.length,
      toolCount: selectedTools.length,
      toolNames: selectedTools.map((t) => t.name),
      systemPromptPreview: sysMsg ? (sysMsg.content as string).slice(0, 300) : null,
    });

    const streamInitialMessages = this.config.llmReasoning
      ? this._injectReasoningInstruction(assembleResult.value)
      : assembleResult.value;

    yield* this._runStreamingToolLoop(
      retrieved,
      streamInitialMessages,
      toolClientMap,
      opts,
      traceId,
    );

    // Log pipeline_done after streaming tool loop fully completes (not before).
    logger?.log({ type: 'pipeline_done', traceId, stopReason: 'stop', iterations: 0, toolCallCount: 0, durationMs: Date.now() - pipelineT0 });
  }

  // -------------------------------------------------------------------------
  // Private: streaming tool loop
  // -------------------------------------------------------------------------

  private async *_runStreamingToolLoop(
    retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    traceId: string,
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    const logger = this.deps.logger;
    let messages = initialMessages;
    let toolCallCount = 0;

    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) {
        yield { type: 'done', finishReason: 'error' };
        return;
      }

      if (iteration >= this.config.maxIterations) {
        yield { type: 'done', finishReason: 'stop' };
        return;
      }

      const llmT0 = Date.now();
      let accumulatedToolCalls: LlmToolCall[] | undefined;
      let finalFinishReason: LlmStreamChunk & { type: 'done' } extends { finishReason: infer R } ? R : never = 'stop';
      let isStreamingDone = false;
      let accumulatedContent = '';

      // Log full request context for session debugging.
      logger?.log({
        type: 'llm_request',
        traceId,
        iteration,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
        toolNames: (retrieved.tools as LlmTool[]).map((t) => t.name),
      });

      if (this.deps.mainLlm.streamChat) {
        // Streaming path — optionally parse <thinking>/<reasoning> blocks
        const parser = this.config.llmReasoning ? new ThinkingStreamParser() : null;

        for await (const chunk of this.deps.mainLlm.streamChat(messages, retrieved.tools as LlmTool[], opts)) {
          if (chunk.type === 'text') {
            accumulatedContent += chunk.delta;
            if (parser) {
              for (const parsed of parser.push(chunk.delta)) yield parsed;
            } else {
              yield chunk;
            }
          } else if (chunk.type === 'reasoning') {
            yield chunk; // pass through any reasoning from the provider itself
          } else if (chunk.type === 'tool_calls') {
            if (parser) {
              for (const parsed of parser.flush()) yield parsed;
            }
            accumulatedToolCalls = chunk.toolCalls;
            yield chunk;
          } else if (chunk.type === 'usage') {
            yield chunk;
          } else if (chunk.type === 'done') {
            if (parser) {
              for (const parsed of parser.flush()) yield parsed;
            }
            finalFinishReason = chunk.finishReason;
            if (chunk.finishReason !== 'tool_calls') {
              yield chunk;
              isStreamingDone = true;
            }
          }
        }
      } else {
        // Fallback: non-streaming chat, emit full content as single text chunk
        const resp = await this.deps.mainLlm.chat(messages, retrieved.tools as LlmTool[], opts);
        if (!resp.ok) {
          yield { type: 'done', finishReason: 'error' };
          return;
        }
        if (resp.value.content) {
          if (this.config.llmReasoning) {
            const parser = new ThinkingStreamParser();
            for (const parsed of parser.push(resp.value.content)) yield parsed;
            for (const parsed of parser.flush()) yield parsed;
          } else {
            yield { type: 'text', delta: resp.value.content };
          }
        }
        accumulatedToolCalls = resp.value.toolCalls;
        finalFinishReason = resp.value.finishReason === 'tool_calls' ? 'tool_calls' : 'stop';
        if (finalFinishReason !== 'tool_calls') {
          yield { type: 'done', finishReason: finalFinishReason };
          isStreamingDone = true;
        }
      }

      logger?.log({ type: 'llm_call', traceId, iteration, finishReason: finalFinishReason, toolCallsRequested: accumulatedToolCalls?.length ?? 0, durationMs: Date.now() - llmT0 });
      logger?.log({
        type: 'llm_response',
        traceId,
        iteration,
        content: accumulatedContent,
        toolCalls: accumulatedToolCalls?.map((tc) => ({ name: tc.name, arguments: tc.arguments })) ?? [],
        finishReason: finalFinishReason,
      });

      if (isStreamingDone || !accumulatedToolCalls?.length) {
        if (!isStreamingDone) yield { type: 'done', finishReason: 'stop' };
        return;
      }

      // Append assistant message with tool_calls before executing them
      messages = [
        ...messages,
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: accumulatedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        },
      ];

      // Execute tool calls
      for (const toolCall of accumulatedToolCalls) {
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }

        let resultContent: string;

        if (this.deps.toolPolicy) {
          const verdict = this.deps.toolPolicy.check(toolCall.name);
          if (!verdict.allowed) {
            resultContent = verdict.reason ?? `Tool "${toolCall.name}" blocked by policy`;
            logger?.log({ type: 'tool_call', traceId, toolName: toolCall.name, isError: true, durationMs: 0 });
            toolCallCount++;
            messages = [...messages, { role: 'tool' as const, content: resultContent, tool_call_id: toolCall.id }];
            continue;
          }
        }

        const client = toolClientMap.get(toolCall.name);
        if (!client) {
          resultContent = `Tool "${toolCall.name}" not found`;
        } else {
          const toolT0 = Date.now();
          const callResult = await client.callTool(toolCall.name, toolCall.arguments, opts);
          logger?.log({ type: 'tool_call', traceId, toolName: toolCall.name, isError: !callResult.ok, durationMs: Date.now() - toolT0 });
          resultContent = callResult.ok
            ? (typeof callResult.value.content === 'string' ? callResult.value.content : JSON.stringify(callResult.value.content))
            : callResult.error.message;
        }

        toolCallCount++;
        messages = [...messages, { role: 'tool' as const, content: resultContent, tool_call_id: toolCall.id }];
      }
    }
  }
}
