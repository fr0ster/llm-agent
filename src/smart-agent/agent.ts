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
  timeoutMs?: number;
  tokenLimit?: number;
  ragQueryK?: number;
  smartAgentEnabled?: boolean;
  sessionPolicy?: SessionPolicy;
  showReasoning?: boolean;
  ragTranslatePrompt?: string;
  historySummaryPrompt?: string;
  historyAutoSummarizeLimit?: number;
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

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortController {
  const ctrl = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { ctrl.abort(signal.reason); return ctrl; }
    signal.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  }
  return ctrl;
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(new Error('Timeout')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

// ---------------------------------------------------------------------------
// SmartAgent
// ---------------------------------------------------------------------------

export class SmartAgent {
  constructor(private readonly deps: SmartAgentDeps, private readonly config: SmartAgentConfig) {}

  async process(textOrMessages: string | Message[], options?: CallOptions): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) return { ok: false, error: new OrchestratorError('SmartAgent is disabled', 'DISABLED') };
    if (options?.signal?.aborted) return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };

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
      const result = await this._runPipeline(textOrMessages, opts, traceId, pipelineT0);
      const durationMs = Date.now() - pipelineT0;
      if (result.ok) {
        this.deps.logger?.log({ type: 'pipeline_done', traceId, stopReason: result.value.stopReason, iterations: result.value.iterations, toolCallCount: result.value.toolCallCount, durationMs });
      } else {
        this.deps.logger?.log({ type: 'pipeline_error', traceId, code: result.error.code, message: result.error.message, durationMs });
      }
      return result;
    } finally {
      timeoutCleanup?.();
    }
  }

  async *streamProcess(textOrMessages: string | Message[], options?: CallOptions & { externalTools?: LlmTool[] }): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) { yield { ok: false, error: new OrchestratorError('SmartAgent is disabled', 'DISABLED') }; return; }
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
      const preLoop = await this._preparePipeline(textOrMessages, opts, traceId, pipelineT0);
      if (!preLoop.ok) { yield preLoop; return; }

      const { action, retrieved, messages, toolClientMap, isChat } = preLoop.value;

      if (isChat) {
        const stream = this.deps.mainLlm.streamChat(messages, [], opts);
        for await (const chunk of stream) yield chunk;
        return;
      }

      if (options?.externalTools && options.externalTools.length > 0) {
        const stream = this.deps.mainLlm.streamChat(messages, options.externalTools, opts);
        for await (const chunk of stream) yield chunk;
        return;
      }

      const stream = this._runStreamingToolLoop(action, retrieved, messages, toolClientMap, opts, traceId);
      for await (const chunk of stream) yield chunk;
    } finally {
      timeoutCleanup?.();
    }
  }

  private async _preparePipeline(textOrMessages: string | Message[], opts: CallOptions | undefined, traceId: string, pipelineT0: number): Promise<Result<{ action: Subprompt; retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }; messages: Message[]; toolClientMap: Map<string, IMcpClient>; isChat?: boolean }, OrchestratorError>> {
    const logger = this.deps.logger;
    const text = typeof textOrMessages === 'string' ? textOrMessages : textOrMessages.filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';

    if (this.deps.injectionDetector) {
      const detection = this.deps.injectionDetector.detect(text);
      if (detection.detected) {
        logger?.log({ type: 'pipeline_error', traceId, code: 'PROMPT_INJECTION', message: `Injection detected: pattern=${detection.pattern ?? 'unknown'}`, durationMs: Date.now() - pipelineT0 });
        return { ok: false, error: new OrchestratorError(`Prompt injection detected: pattern=${detection.pattern ?? 'unknown'}`, 'PROMPT_INJECTION') };
      }
    }

    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;
    let processedHistory = history;
    const summarizeLimit = this.config.historyAutoSummarizeLimit ?? 10;
    if (this.deps.helperLlm && history.length > summarizeLimit) {
      const summaryResult = await this._summarizeHistory(history, opts);
      if (summaryResult.ok) processedHistory = summaryResult.value;
    }

    const classifyResult = await this.deps.classifier.classify(text, opts);
    if (!classifyResult.ok) return { ok: false, error: new OrchestratorError(classifyResult.error.message, classifyResult.error.code === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR') };

    const subprompts = classifyResult.value;
    const actions = subprompts.filter(sp => sp.type === 'action');
    const chats = subprompts.filter(sp => sp.type === 'chat');
    const others = subprompts.filter(sp => sp.type !== 'action' && sp.type !== 'chat');

    const ragStoreMap = new Map<string, IRag>([['fact', this.deps.ragStores.facts], ['feedback', this.deps.ragStores.feedback], ['state', this.deps.ragStores.state]]);
    await Promise.allSettled(others.map(async sp => {
      const store = ragStoreMap.get(sp.type);
      if (!store) return;
      await store.upsert(sp.text, this._buildRagMetadata(), opts);
    }));

    if (chats.length > 0 && actions.length === 0) {
      return { ok: true, value: { action: chats[0], retrieved: { facts: [], feedback: [], state: [], tools: [] }, messages: [...processedHistory, { role: 'user', content: chats.map(c => c.text).join('\n') }], toolClientMap: new Map(), isChat: true } };
    }

    if (actions.length === 0) return { ok: false, error: new OrchestratorError('No actionable intent found', 'NO_ACTIONS') };

    const action = actions[0];
    const ragText = await this._toEnglishForRag(action.text, opts);
    const k = this.config.ragQueryK ?? 5;
    const [factsR, feedbackR, stateR] = await Promise.all([this.deps.ragStores.facts.query(ragText, k, opts), this.deps.ragStores.feedback.query(ragText, k, opts), this.deps.ragStores.state.query(ragText, k, opts)]);
    
    const { tools: mcpTools, toolClientMap } = await this._listAllTools(opts);
    const facts = factsR.ok ? factsR.value : [];
    const ragToolNames = new Set(facts.map(r => r.metadata.id as string).filter(id => id?.startsWith('tool:')).map(id => id.slice(5)));
    const selectedTools = ragToolNames.size > 0 ? mcpTools.filter(t => ragToolNames.has(t.name)) : mcpTools;

    const retrieved = { facts, feedback: feedbackR.ok ? feedbackR.value : [], state: stateR.ok ? stateR.value : [], tools: selectedTools };
    const assembleResult = await this.deps.assembler.assemble(action, retrieved, processedHistory, opts);
    if (!assembleResult.ok) return { ok: false, error: new OrchestratorError(assembleResult.error.message, 'ASSEMBLER_ERROR') };

    return { ok: true, value: { action, retrieved, messages: assembleResult.value, toolClientMap } };
  }

  private async _runPipeline(textOrMessages: string | Message[], opts: CallOptions | undefined, traceId: string, pipelineT0: number): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const preLoop = await this._preparePipeline(textOrMessages, opts, traceId, pipelineT0);
    if (!preLoop.ok) return preLoop.error.code === 'NO_ACTIONS' ? { ok: true, value: { content: '', iterations: 0, toolCallCount: 0, stopReason: 'stop' } } : preLoop;

    const { action, retrieved, messages, toolClientMap, isChat } = preLoop.value;
    if (isChat) {
      const resp = await this.deps.mainLlm.chat(messages, [], opts);
      if (!resp.ok) return { ok: false, error: new OrchestratorError(resp.error.message, 'LLM_ERROR') };
      return { ok: true, value: { content: resp.value.content, iterations: 1, toolCallCount: 0, stopReason: 'stop', usage: resp.value.usage } };
    }

    return this._runToolLoop(action, retrieved, messages, toolClientMap, opts, traceId);
  }

  private async *_runStreamingToolLoop(_action: Subprompt, retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }, initialMessages: Message[], toolClientMap: Map<string, IMcpClient>, opts: CallOptions | undefined, traceId: string): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    const logger = this.deps.logger;
    let toolCallCount = 0;
    let messages = initialMessages;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) { yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') }; return; }
      if (iteration >= this.config.maxIterations) { yield { ok: true, value: { content: '', finishReason: 'length', usage } }; return; }

      const stream = this.deps.mainLlm.streamChat(messages, retrieved.tools as LlmTool[], opts);
      let content = '';
      let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunkResult of stream) {
        if (!chunkResult.ok) { yield { ok: false, error: new OrchestratorError(chunkResult.error.message, 'LLM_ERROR') }; return; }
        const chunk = chunkResult.value;
        if (chunk.content) { content += chunk.content; yield { ok: true, value: { content: chunk.content } }; }
        if (chunk.toolCalls) {
          yield { ok: true, value: { content: '', toolCalls: chunk.toolCalls } };
          for (const tc of chunk.toolCalls as any[]) {
            if (!toolCallsMap.has(tc.index)) { toolCallsMap.set(tc.index, { id: tc.id || '', name: tc.name || '', arguments: tc.arguments || '' }); }
            else { const ex = toolCallsMap.get(tc.index)!; if (tc.id) ex.id = tc.id; if (tc.name) ex.name = tc.name; if (tc.arguments) ex.arguments += tc.arguments; }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) { usage.promptTokens += chunk.usage.promptTokens; usage.completionTokens += chunk.usage.completionTokens; usage.totalTokens += chunk.usage.totalTokens; }
      }

      const toolCalls = Array.from(toolCallsMap.values()).map(tc => {
        let args = {}; try { args = JSON.parse(tc.arguments); } catch { args = {}; }
        return { id: tc.id, name: tc.name, arguments: args };
      });

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) { yield { ok: true, value: { content: '', finishReason: finishReason || 'stop', usage } }; return; }

      messages = [...messages, { role: 'assistant', content: content || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }];

      for (const toolCall of toolCalls) {
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) { yield { ok: true, value: { content: '', finishReason: 'length', usage } }; return; }
        yield { ok: true, value: { content: `\n\n[SmartAgent: Executing ${toolCall.name}...]\n` } };
        const t0 = Date.now();
        let result: string;
        const client = toolClientMap.get(toolCall.name);
        if (!client) result = `Tool "${toolCall.name}" not found`;
        else {
          const res = await client.callTool(toolCall.name, toolCall.arguments, opts);
          result = !res.ok ? res.error.message : typeof res.value.content === 'string' ? res.value.content : JSON.stringify(res.value.content);
        }
        logger?.log({ type: 'tool_call', traceId, toolName: toolCall.name, isError: false, durationMs: Date.now() - t0 });
        toolCallCount++;
        messages = [...messages, { role: 'tool', content: result, tool_call_id: toolCall.id }];
      }
    }
  }

  private async _listAllTools(opts: CallOptions | undefined): Promise<{ tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }> {
    const tools: McpTool[] = [];
    const toolClientMap = new Map<string, IMcpClient>();
    const settled = await Promise.allSettled(this.deps.mcpClients.map(async client => ({ client, result: await client.listTools(opts) })));
    for (const entry of settled) {
      if (entry.status === 'rejected' || !entry.value.result.ok) continue;
      for (const tool of entry.value.result.value) { if (!toolClientMap.has(tool.name)) { tools.push(tool); toolClientMap.set(tool.name, entry.value.client); } }
    }
    return { tools, toolClientMap };
  }

  private async _runToolLoop(_action: Subprompt, retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }, initialMessages: Message[], toolClientMap: Map<string, IMcpClient>, opts: CallOptions | undefined, traceId: string): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    const logger = this.deps.logger;
    let toolCallCount = 0;
    let messages = initialMessages;
    let content = '';
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
      if (iteration >= this.config.maxIterations) return { ok: true, value: { content, iterations: iteration, toolCallCount, stopReason: 'iteration_limit', usage } };

      const resp = await this.deps.mainLlm.chat(messages, retrieved.tools as LlmTool[], opts);
      if (resp.ok && resp.value.usage) { usage.promptTokens += resp.value.usage.promptTokens; usage.completionTokens += resp.value.usage.completionTokens; usage.totalTokens += resp.value.usage.totalTokens; }
      if (!resp.ok) return { ok: false, error: new OrchestratorError(resp.error.message, resp.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR') };

      content = resp.value.content;
      const toolCalls = resp.value.toolCalls;
      if (resp.value.finishReason !== 'tool_calls' || !toolCalls?.length) return { ok: true, value: { content, iterations: iteration + 1, toolCallCount, stopReason: 'stop', usage } };

      messages = [...messages, { role: 'assistant', content: content || '', tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }];

      for (const toolCall of toolCalls) {
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) return { ok: true, value: { content, iterations: iteration + 1, toolCallCount, stopReason: 'tool_call_limit', usage } };
        const t0 = Date.now();
        let result: string;
        if (this.deps.toolPolicy) {
          const verdict = this.deps.toolPolicy.check(toolCall.name);
          if (!verdict.allowed) {
            result = verdict.reason ?? `Tool "${toolCall.name}" blocked`;
            toolCallCount++;
            messages = [...messages, { role: 'tool', content: result, tool_call_id: toolCall.id }];
            continue;
          }
        }
        const client = toolClientMap.get(toolCall.name);
        if (!client) result = `Tool "${toolCall.name}" not found`;
        else {
          const res = await client.callTool(toolCall.name, toolCall.arguments, opts);
          result = !res.ok ? res.error.message : typeof res.value.content === 'string' ? res.value.content : JSON.stringify(res.value.content);
        }
        toolCallCount++;
        messages = [...messages, { role: 'tool', content: result, tool_call_id: toolCall.id }];
      }
    }
  }

  private async _toEnglishForRag(text: string, opts: CallOptions | undefined): Promise<string> {
    if (/^[\x00-\x7F]+$/.test(text)) return text;
    const defaultPrompt = 'You are an SAP ABAP expert. Translate the following user request to English and expand it with relevant SAP technical terms: ABAP object types, SAP table names (e.g. TDEVC for packages, TADIR for repository objects, T100 for messages), operation keywords (read, search, filter, list, create, update), and function descriptors. This expansion is used for semantic tool search. Reply with only the expanded English terms, no explanation.';
    const llm = this.deps.helperLlm || this.deps.mainLlm;
    const result = await llm.chat([{ role: 'system', content: this.config.ragTranslatePrompt || defaultPrompt }, { role: 'user', content: text }], [], opts);
    return result.ok && result.value.content.trim() ? result.value.content.trim() : text;
  }

  private async _summarizeHistory(history: Message[], opts?: CallOptions): Promise<Result<Message[], OrchestratorError>> {
    if (!this.deps.helperLlm) return { ok: true, value: history };
    const toSummarize = history.slice(0, -5);
    const recent = history.slice(-5);
    if (toSummarize.length === 0) return { ok: true, value: history };
    const defaultPrompt = 'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';
    const resp = await this.deps.helperLlm.chat([...toSummarize, { role: 'system', content: this.config.historySummaryPrompt || defaultPrompt }], [], opts);
    if (!resp.ok) return { ok: true, value: history };
    return { ok: true, value: [{ role: 'system', content: `Summary of previous conversation: ${resp.value.content}` }, ...recent] };
  }

  private _buildRagMetadata(): RagMetadata {
    const policy = this.config.sessionPolicy;
    if (!policy) return {};
    const metadata: RagMetadata = {};
    if (policy.namespace !== undefined) metadata.namespace = policy.namespace;
    if (policy.maxSessionAgeMs !== undefined) metadata.ttl = Math.floor((Date.now() + policy.maxSessionAgeMs) / 1000);
    return metadata;
  }
}
