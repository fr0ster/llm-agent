import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import {
  type CallOptions,
  type LlmFinishReason,
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
import {
  isToolContextUnavailableError,
  ToolAvailabilityRegistry,
} from './policy/tool-availability-registry.js';
import type {
  IPromptInjectionDetector,
  IToolPolicy,
  SessionPolicy,
} from './policy/types.js';
import { normalizeExternalTools } from './utils/external-tools-normalizer.js';
import {
  getStreamToolCallName,
  toToolCallDelta,
} from './utils/tool-call-deltas.js';

export class OrchestratorError extends SmartAgentError {
  constructor(message: string, code = 'ORCHESTRATOR_ERROR') {
    super(message, code);
    this.name = 'OrchestratorError';
  }
}

export interface SmartAgentRagStores {
  facts: IRag;
  feedback: IRag;
  state: IRag;
}
export interface SmartAgentDeps {
  mainLlm: ILlm;
  helperLlm?: ILlm;
  mcpClients: IMcpClient[];
  ragStores: SmartAgentRagStores;
  classifier: ISubpromptClassifier;
  assembler: IContextAssembler;
  logger?: ILogger;
  toolPolicy?: IToolPolicy;
  injectionDetector?: IPromptInjectionDetector;
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

  constructor(
    private readonly deps: SmartAgentDeps,
    private readonly config: SmartAgentConfig,
  ) {
    this.toolAvailabilityRegistry = new ToolAvailabilityRegistry(
      this.config.toolUnavailableTtlMs,
    );
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
    const results = {
      llm: false,
      rag: false,
      mcp: [] as { name: string; ok: boolean; error?: string }[],
    };
    try {
      const llmRes = await this.deps.mainLlm.chat(
        [{ role: 'user' as const, content: 'ping' }],
        [],
        { ...options, maxTokens: 1 },
      );
      results.llm = llmRes.ok;
    } catch {
      results.llm = false;
    }
    const ragRes = await this.deps.ragStores.facts.healthCheck(options);
    results.rag = ragRes.ok;
    const mcpChecks = await Promise.all(
      this.deps.mcpClients.map(async (client) => {
        const tools = await client.listTools(options);
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
      }),
    );
    results.mcp = mcpChecks;
    return { ok: true, value: results };
  }

  async process(
    textOrMessages: string | Message[],
    options?: CallOptions,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    let content = '';
    const totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for await (const chunk of this.streamProcess(textOrMessages, options)) {
      if (!chunk.ok) return chunk;
      if (chunk.value.content) content += chunk.value.content;
      if (chunk.value.usage) {
        totalUsage.promptTokens += chunk.value.usage.promptTokens;
        totalUsage.completionTokens += chunk.value.usage.completionTokens;
        totalUsage.totalTokens += chunk.value.usage.totalTokens;
      }
    }
    return {
      ok: true,
      value: {
        content,
        iterations: 1,
        toolCallCount: 0,
        stopReason: 'stop',
        usage: totalUsage,
      },
    };
  }

  async *streamProcess(
    textOrMessages: string | Message[],
    options?: CallOptions & { externalTools?: unknown[] },
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) {
      yield {
        ok: false,
        error: new OrchestratorError('SmartAgent is disabled', 'DISABLED'),
      };
      return;
    }
    const traceId = options?.trace?.traceId ?? randomUUID();
    const pipelineT0 = Date.now();
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) {
      const { signal, clear } = createTimeoutSignal(this.config.timeoutMs);
      timeoutCleanup = clear;
      const merged = mergeSignals(options?.signal, signal);
      opts = { ...options, signal: merged.signal };
    }

    const mode = this.config.mode || 'smart';
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

    try {
      if (mode === 'pass') {
        const messages: Message[] =
          typeof textOrMessages === 'string'
            ? [{ role: 'user' as const, content: textOrMessages }]
            : textOrMessages;
        const stream = this.deps.mainLlm.streamChat(
          messages,
          externalTools,
          opts,
        );
        for await (const chunk of stream) yield chunk;
        return;
      }

      // 1. Unified Preparation
      const initResult = await this._preparePipeline(
        textOrMessages,
        opts,
        traceId,
        pipelineT0,
      );
      if (!initResult.ok) {
        yield initResult;
        return;
      }
      const { subprompts, processedHistory, toolClientMap } = initResult.value;

      // 2. Decide context and tools for the WHOLE request
      const actions = subprompts.filter((sp) => sp.type === 'action');
      const isSapRequired =
        actions.some((a) => a.context === 'sap-abap') || mode === 'hard';

      let finalTools: LlmTool[] = [];
      let retrieved = {
        facts: [] as RagResult[],
        feedback: [] as RagResult[],
        state: [] as RagResult[],
        tools: [] as McpTool[],
      };

      if (isSapRequired) {
        // Collect all action texts for RAG
        const combinedActionText = actions.map((a) => a.text).join(' ');
        const ragText = await this._toEnglishForRag(combinedActionText, opts);
        const k = this.config.ragQueryK ?? 10;
        const [fR, fbR, sR] = await Promise.all([
          this.deps.ragStores.facts.query(ragText, k, opts),
          this.deps.ragStores.feedback.query(ragText, k, opts),
          this.deps.ragStores.state.query(ragText, k, opts),
        ]);

        const { tools: mcpTools } = await this._listAllTools(opts);
        const facts = fR.ok ? fR.value : [];
        const ragToolNames = new Set(
          facts
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

        retrieved = {
          facts,
          feedback: fbR.ok ? fbR.value : [],
          state: sR.ok ? sR.value : [],
          tools: selectedMcpTools,
        };
        finalTools =
          mode === 'hard'
            ? (selectedMcpTools as LlmTool[])
            : [...(selectedMcpTools as LlmTool[]), ...externalTools];
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
        actions.length > 0
          ? actions[0]
          : subprompts.find((sp) => sp.type === 'chat') || subprompts[0];
      const assembleResult = await this.deps.assembler.assemble(
        mainAction,
        retrieved,
        processedHistory,
        opts,
      );
      if (!assembleResult.ok) {
        yield {
          ok: false,
          error: new OrchestratorError(
            assembleResult.error.message,
            'ASSEMBLER_ERROR',
          ),
        };
        return;
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
        traceId,
        sessionId,
        mode === 'hard' ? [] : externalTools,
        finalTools,
      );
      for await (const chunk of stream) yield chunk;
    } finally {
      timeoutCleanup?.();
    }
  }

  private async _preparePipeline(
    textOrMessages: string | Message[],
    opts: CallOptions | undefined,
    _traceId: string,
    _pipelineT0: number,
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

    const classifyResult = await this.deps.classifier.classify(text, opts);
    if (!classifyResult.ok)
      return {
        ok: false,
        error: new OrchestratorError(
          classifyResult.error.message,
          'CLASSIFIER_ERROR',
        ),
      };
    opts?.sessionLogger?.logStep('classifier_response', {
      subprompts: classifyResult.value,
    });

    const subprompts = classifyResult.value;
    const others = subprompts.filter(
      (sp) =>
        sp.type === 'fact' || sp.type === 'state' || sp.type === 'feedback',
    );
    const ragStoreMap = new Map<string, IRag>([
      ['fact', this.deps.ragStores.facts],
      ['feedback', this.deps.ragStores.feedback],
      ['state', this.deps.ragStores.state],
    ]);
    await Promise.allSettled(
      others.map(async (sp) => {
        const s = ragStoreMap.get(sp.type);
        if (s) await s.upsert(sp.text, this._buildRagMetadata(), opts);
      }),
    );

    const { toolClientMap } = await this._listAllTools(opts);
    return { ok: true, value: { subprompts, processedHistory, toolClientMap } };
  }

  private async *_runStreamingToolLoop(
    _action: Subprompt,
    _retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
    _traceId: string,
    sessionId: string,
    externalTools: LlmTool[],
    activeTools: LlmTool[],
  ): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    let toolCallCount = 0;
    let messages = initialMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const externalToolNames = new Set(externalTools.map((t) => t.name));
    let currentTools = activeTools;
    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) {
        yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
        return;
      }
      if (iteration >= this.config.maxIterations) {
        yield {
          ok: true,
          value: { content: '', finishReason: 'length', usage },
        };
        return;
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
      const stream = this.deps.mainLlm.streamChat(messages, currentTools, opts);
      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      for await (const chunkResult of stream) {
        if (!chunkResult.ok) {
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
        if (chunk.content) {
          content += chunk.content;
          yield { ok: true, value: { content: chunk.content } };
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
        }
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
        opts?.sessionLogger?.logStep('final_response', { content, usage });
        yield {
          ok: true,
          value: { content: '', finishReason: finishReason || 'stop', usage },
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
        yield {
          ok: true,
          value: { content: '', finishReason: 'tool_calls', usage },
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
      for (const tc of internalCalls) {
        if (
          this.config.maxToolCalls !== undefined &&
          toolCallCount >= this.config.maxToolCalls
        ) {
          yield {
            ok: true,
            value: { content: '', finishReason: 'length', usage },
          };
          return;
        }
        yield {
          ok: true,
          value: { content: `\n\n[SmartAgent: Executing ${tc.name}...]\n` },
        };
        opts?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
          arguments: tc.arguments,
        });
        const client = toolClientMap.get(tc.name);
        if (!client) continue;
        const res = await client.callTool(tc.name, tc.arguments, opts);
        const text = !res.ok
          ? res.error.message
          : typeof res.value.content === 'string'
            ? res.value.content
            : JSON.stringify(res.value.content);
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
        opts?.sessionLogger?.logStep(`mcp_result_${tc.name}`, { result: text });
        toolCallCount++;
        messages = [
          ...messages,
          { role: 'tool' as const, content: text, tool_call_id: tc.id },
        ];
      }
    }
  }

  private async _listAllTools(
    opts: CallOptions | undefined,
  ): Promise<{ tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }> {
    const tools: McpTool[] = [];
    const toolClientMap = new Map<string, IMcpClient>();
    const settled = await Promise.allSettled(
      this.deps.mcpClients.map(async (client) => ({
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
}
