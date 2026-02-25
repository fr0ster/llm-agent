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
import type { IPromptInjectionDetector, IToolPolicy, SessionPolicy } from './policy/types.js';

export class OrchestratorError extends SmartAgentError {
  constructor(message: string, code = 'ORCHESTRATOR_ERROR') { super(message, code); this.name = 'OrchestratorError'; }
}

export interface SmartAgentRagStores { facts: IRag; feedback: IRag; state: IRag; }
export interface SmartAgentDeps { mainLlm: ILlm; helperLlm?: ILlm; mcpClients: IMcpClient[]; ragStores: SmartAgentRagStores; classifier: ISubpromptClassifier; assembler: IContextAssembler; logger?: ILogger; toolPolicy?: IToolPolicy; injectionDetector?: IPromptInjectionDetector; }
export interface SmartAgentConfig { maxIterations: number; maxToolCalls?: number; timeoutMs?: number; tokenLimit?: number; ragQueryK?: number; smartAgentEnabled?: boolean; sessionPolicy?: SessionPolicy; showReasoning?: boolean; ragTranslatePrompt?: string; historySummaryPrompt?: string; historyAutoSummarizeLimit?: number; }
export type StopReason = 'stop' | 'iteration_limit' | 'tool_call_limit';
export interface SmartAgentResponse { content: string; iterations: number; toolCallCount: number; stopReason: StopReason; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; }

function mergeSignals(...signals: (AbortSignal | undefined)[]): AbortController {
  const ctrl = new AbortController();
  for (const s of signals) { if (!s) continue; if (s.aborted) { ctrl.abort(s.reason); return ctrl; } s.addEventListener('abort', () => ctrl.abort(s.reason), { once: true }); }
  return ctrl;
}

function createTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController(); const id = setTimeout(() => ctrl.abort(new Error('Timeout')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(id) };
}

export class SmartAgent {
  constructor(private readonly deps: SmartAgentDeps, private readonly config: SmartAgentConfig) {}

  async healthCheck(options?: CallOptions): Promise<Result<{ llm: boolean; rag: boolean; mcp: { name: string; ok: boolean; error?: string }[] }, OrchestratorError>> {
    const results = { llm: false, rag: false, mcp: [] as { name: string; ok: boolean; error?: string }[] };
    try { const llmRes = await this.deps.mainLlm.chat([{ role: 'user', content: 'ping' }], [], { ...options, maxTokens: 1 }); results.llm = llmRes.ok; } catch { results.llm = false; }
    const ragRes = await this.deps.ragStores.facts.healthCheck(options); results.rag = ragRes.ok;
    const mcpChecks = await Promise.all(this.deps.mcpClients.map(async client => { const tools = await client.listTools(options); return { name: 'mcp-client', ok: tools.ok, error: tools.ok ? undefined : (tools.error as any).message }; }));
    results.mcp = mcpChecks; return { ok: true, value: results };
  }

  async process(textOrMessages: string | Message[], options?: CallOptions): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    return this._runPipeline(textOrMessages, options, randomUUID(), Date.now());
  }

  async *streamProcess(textOrMessages: string | Message[], options?: CallOptions & { externalTools?: any[] }): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    if (this.config.smartAgentEnabled === false) { yield { ok: false, error: new OrchestratorError('SmartAgent is disabled', 'DISABLED') }; return; }
    const traceId = options?.trace?.traceId ?? randomUUID();
    const pipelineT0 = Date.now();
    let timeoutCleanup: (() => void) | undefined;
    let opts: CallOptions | undefined = options;
    if (this.config.timeoutMs) { const { signal, clear } = createTimeoutSignal(this.config.timeoutMs); timeoutCleanup = clear; const merged = mergeSignals(options?.signal, signal); opts = { ...options, signal: merged.signal }; }

    try {
      const preLoop = await this._preparePipeline(textOrMessages, opts, traceId, pipelineT0);
      if (!preLoop.ok) { yield preLoop; return; }
      const { action, retrieved, messages, toolClientMap, isChat } = preLoop.value;

      if (isChat) {
        opts?.sessionLogger?.logStep('llm_chat_request', { messages });
        const stream = this.deps.mainLlm.streamChat(messages, [], opts);
        let finalContent = '';
        for await (const chunk of stream) {
          if (chunk.ok && chunk.value.content) finalContent += chunk.value.content;
          yield chunk;
        }
        opts?.sessionLogger?.logStep('llm_chat_response', { content: finalContent });
        return;
      }

      const externalTools = (options?.externalTools || []).map(t => {
        if (t.name) return t;
        if (t.function?.name) return { name: t.function.name, description: t.function.description || '', inputSchema: t.function.parameters || { type: 'object', properties: {} } };
        return null;
      }).filter((t): t is LlmTool => t !== null);

      const stream = this._runStreamingToolLoop(action, retrieved, messages, toolClientMap, opts, traceId, externalTools);
      for await (const chunk of stream) yield chunk;
    } finally { timeoutCleanup?.(); }
  }

  private async _preparePipeline(textOrMessages: string | Message[], opts: CallOptions | undefined, traceId: string, pipelineT0: number): Promise<Result<{ action: Subprompt; retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }; messages: Message[]; toolClientMap: Map<string, IMcpClient>; isChat?: boolean }, OrchestratorError>> {
    opts?.sessionLogger?.logStep('client_request', { textOrMessages });
    const text = typeof textOrMessages === 'string' ? textOrMessages : textOrMessages.filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';
    const history = typeof textOrMessages === 'string' ? [] : textOrMessages;
    let processedHistory = history;
    const summarizeLimit = this.config.historyAutoSummarizeLimit ?? 10;
    if (this.deps.helperLlm && history.length > summarizeLimit) { 
      opts?.sessionLogger?.logStep('summarization_start', { historyLength: history.length });
      const res = await this._summarizeHistory(history, opts); 
      if (res.ok) {
        processedHistory = res.value;
        opts?.sessionLogger?.logStep('summarization_done', { processedHistory });
      }
    }

    const classifyResult = await this.deps.classifier.classify(text, opts);
    if (!classifyResult.ok) return { ok: false, error: new OrchestratorError(classifyResult.error.message, 'CLASSIFIER_ERROR') };
    opts?.sessionLogger?.logStep('classifier_response', { subprompts: classifyResult.value });

    const subprompts = classifyResult.value;
    const others = subprompts.filter(sp => sp.type === 'fact' || sp.type === 'state' || sp.type === 'feedback');
    const ragStoreMap = new Map<string, IRag>([['fact', this.deps.ragStores.facts], ['feedback', this.deps.ragStores.feedback], ['state', this.deps.ragStores.state]]);
    await Promise.allSettled(others.map(async sp => { 
      const s = ragStoreMap.get(sp.type); 
      if (s) {
        opts?.sessionLogger?.logStep(`rag_upsert_${sp.type}`, { text: sp.text });
        await s.upsert(sp.text, this._buildRagMetadata(), opts); 
      }
    }));

    const actions = subprompts.filter(sp => sp.type === 'action');
    const chats = subprompts.filter(sp => sp.type === 'chat');

    if (chats.length > 0 && actions.length === 0) {
      return { ok: true, value: { action: chats[0], retrieved: { facts: [], feedback: [], state: [], tools: [] }, messages: processedHistory, toolClientMap: new Map(), isChat: true } };
    }

    if (actions.length === 0) return { ok: false, error: new OrchestratorError('No intent', 'NO_ACTIONS') };

    const action = actions[0];
    const ragText = await this._toEnglishForRag(action.text, opts);
    const k = this.config.ragQueryK ?? 10;
    const [fR, fbR, sR] = await Promise.all([this.deps.ragStores.facts.query(ragText, k, opts), this.deps.ragStores.feedback.query(ragText, k, opts), this.deps.ragStores.state.query(ragText, k, opts)]);
    
    const { tools: mcpTools, toolClientMap } = await this._listAllTools(opts);
    const facts = fR.ok ? fR.value : [];
    const ragToolNames = new Set(facts.map(r => r.metadata.id as string).filter(id => id?.startsWith('tool:')).map(id => id.slice(5)));
    const selectedTools = ragToolNames.size > 0 ? mcpTools.filter(t => ragToolNames.has(t.name)) : [];

    const retrieved = { facts, feedback: fbR.ok ? fbR.value : [], state: sR.ok ? sR.value : [], tools: selectedTools };
    opts?.sessionLogger?.logStep('rag_retrieval_done', { ragText, retrieved });

    const assembleResult = await this.deps.assembler.assemble(action, retrieved, processedHistory, opts);
    if (!assembleResult.ok) return { ok: false, error: new OrchestratorError(assembleResult.error.message, 'ASSEMBLER_ERROR') };
    opts?.sessionLogger?.logStep('context_assembled', { messages: assembleResult.value });

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

  private async *_runStreamingToolLoop(_action: Subprompt, retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }, initialMessages: Message[], toolClientMap: Map<string, IMcpClient>, opts: CallOptions | undefined, traceId: string, externalTools: LlmTool[]): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
    let toolCallCount = 0; let messages = initialMessages; const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const externalToolNames = new Set(externalTools.map(t => t.name));

    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) { yield { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') }; return; }
      if (iteration >= this.config.maxIterations) { yield { ok: true, value: { content: '', finishReason: 'length', usage } }; return; }

      const activeTools = [...(retrieved.tools as LlmTool[]), ...externalTools];
      opts?.sessionLogger?.logStep(`llm_request_iter_${iteration + 1}`, { messages, tools: activeTools.map(t => t.name) });
      
      const stream = this.deps.mainLlm.streamChat(messages, activeTools, opts);
      let content = ''; let finishReason: LlmFinishReason | undefined;
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

      for await (const chunkResult of stream) {
        if (!chunkResult.ok) { yield { ok: false, error: new OrchestratorError(chunkResult.error.message, 'LLM_ERROR') }; return; }
        const chunk = chunkResult.value;
        if (chunk.content) { content += chunk.content; yield { ok: true, value: { content: chunk.content } }; }
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls as any[]) {
            if (!toolCallsMap.has(tc.index)) { toolCallsMap.set(tc.index, { id: tc.id || '', name: tc.name || '', arguments: tc.arguments || '' }); }
            else { const ex = toolCallsMap.get(tc.index)!; if (tc.id) ex.id = tc.id; if (tc.name) ex.name = tc.name; if (tc.arguments) ex.arguments += tc.arguments; }
          }
        }
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.usage) { usage.promptTokens += chunk.usage.promptTokens; usage.completionTokens += chunk.usage.completionTokens; usage.totalTokens += chunk.usage.totalTokens; }
      }

      const toolCalls = Array.from(toolCallsMap.values()).map(tc => { let args = {}; try { args = JSON.parse(tc.arguments); } catch { args = {}; } return { id: tc.id, name: tc.name, arguments: args }; });
      opts?.sessionLogger?.logStep(`llm_response_iter_${iteration + 1}`, { content, toolCalls, finishReason });

      if (finishReason !== 'tool_calls' || toolCalls.length === 0) { 
        opts?.sessionLogger?.logStep('final_response', { content, usage });
        yield { ok: true, value: { content: '', finishReason: finishReason || 'stop', usage } }; 
        return; 
      }

      const internalCalls = toolCalls.filter(tc => toolClientMap.has(tc.name));
      const validExternalCalls = toolCalls.filter(tc => externalToolNames.has(tc.name));
      const hallucinations = toolCalls.filter(tc => !toolClientMap.has(tc.name) && !externalToolNames.has(tc.name));

      if (hallucinations.length > 0) {
        messages = [...messages, { role: 'assistant', content: content || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }];
        for (const h of hallucinations) {
          const errorMsg = `Error: Tool "${h.name}" not found.`;
          opts?.sessionLogger?.logStep(`hallucination_detected`, { toolName: h.name });
          messages = [...messages, { role: 'tool', content: errorMsg, tool_call_id: h.id }];
        }
        continue;
      }

      if (validExternalCalls.length > 0) {
        opts?.sessionLogger?.logStep('external_tool_delegation', { toolCalls: validExternalCalls });
        yield { ok: true, value: { content: '', toolCalls: validExternalCalls, finishReason: 'tool_calls', usage } };
        return;
      }

      if (content || internalCalls.length > 0) messages = [...messages, { role: 'assistant', content: content || null, tool_calls: internalCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }];
      for (const tc of internalCalls) {
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) { yield { ok: true, value: { content: '', finishReason: 'length', usage } }; return; }
        yield { ok: true, value: { content: `\n\n[SmartAgent: Executing ${tc.name}...]\n` } };
        
        opts?.sessionLogger?.logStep(`mcp_call_${tc.name}`, { arguments: tc.arguments });
        const res = await toolClientMap.get(tc.name)!.callTool(tc.name, tc.arguments, opts);
        const text = !res.ok ? res.error.message : typeof res.value.content === 'string' ? res.value.content : JSON.stringify(res.value.content);
        opts?.sessionLogger?.logStep(`mcp_result_${tc.name}`, { result: text });
        
        toolCallCount++; messages = [...messages, { role: 'tool', content: text, tool_call_id: tc.id }];
      }
    }
  }

  private async _listAllTools(opts: CallOptions | undefined): Promise<{ tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }> {
    const tools: McpTool[] = []; const toolClientMap = new Map<string, IMcpClient>();
    const settled = await Promise.allSettled(this.deps.mcpClients.map(async client => ({ client, result: await client.listTools(opts) })));
    for (const e of settled) { if (e.status === 'fulfilled' && e.value.result.ok) { for (const t of e.value.result.value) { if (!toolClientMap.has(t.name)) { tools.push(t); toolClientMap.set(t.name, e.value.client); } } } }
    return { tools, toolClientMap };
  }

  private async _runToolLoop(_action: Subprompt, retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] }, initialMessages: Message[], toolClientMap: Map<string, IMcpClient>, opts: CallOptions | undefined, traceId: string): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    let toolCallCount = 0; let messages = initialMessages; let content = ''; const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    for (let iteration = 0; ; iteration++) {
      if (opts?.signal?.aborted) return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
      if (iteration >= this.config.maxIterations) return { ok: true, value: { content, iterations: iteration, toolCallCount, stopReason: 'iteration_limit', usage } };
      const resp = await this.deps.mainLlm.chat(messages, retrieved.tools as LlmTool[], opts);
      if (resp.ok && resp.value.usage) { usage.promptTokens += resp.value.usage.promptTokens; usage.completionTokens += resp.value.usage.completionTokens; usage.totalTokens += resp.value.usage.totalTokens; }
      if (!resp.ok) return { ok: false, error: new OrchestratorError(resp.error.message, 'LLM_ERROR') };
      content = resp.value.content; const toolCalls = resp.value.toolCalls;
      if (resp.value.finishReason !== 'tool_calls' || !toolCalls?.length) return { ok: true, value: { content, iterations: iteration + 1, toolCallCount, stopReason: 'stop', usage } };
      messages = [...messages, { role: 'assistant', content: content || null, tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }];
      for (const tc of toolCalls) {
        if (this.config.maxToolCalls !== undefined && toolCallCount >= this.config.maxToolCalls) return { ok: true, value: { content, iterations: iteration + 1, toolCallCount, stopReason: 'tool_call_limit', usage } };
        const res = await toolClientMap.get(tc.name)!.callTool(tc.name, tc.arguments, opts);
        const text = !res.ok ? res.error.message : typeof res.value.content === 'string' ? res.value.content : JSON.stringify(res.value.content);
        toolCallCount++; messages = [...messages, { role: 'tool', content: text, tool_call_id: tc.id }];
      }
    }
  }

  private async _toEnglishForRag(text: string, opts: CallOptions | undefined): Promise<string> {
    if (/^[\x00-\x7F]+$/.test(text) || text.length < 15) return text;
    const dp = 'Translate the following user request to English. If it contains technical terms, preserve and expand them with technical synonyms. If it is general chat, just translate it. Reply with only the expanded English terms, no explanation.';
    const llm = this.deps.helperLlm || this.deps.mainLlm;
    const res = await llm.chat([{ role: 'system', content: this.config.ragTranslatePrompt || dp }, { role: 'user', content: text }], [], opts);
    return res.ok && res.value.content.trim() ? res.value.content.trim() : text;
  }

  private async _summarizeHistory(h: Message[], opts?: CallOptions): Promise<Result<Message[], OrchestratorError>> {
    if (!this.deps.helperLlm) return { ok: true, value: h };
    const toS = h.slice(0, -5); const rec = h.slice(-5); if (toS.length === 0) return { ok: true, value: h };
    const dp = 'Summarize the conversation so far in 2-3 sentences. Focus on the user goals and the current status of the task. Keep technical SAP terms as is.';
    const res = await this.deps.helperLlm.chat([...toS, { role: 'system', content: this.config.historySummaryPrompt || dp }], [], opts);
    if (!res.ok) return { ok: true, value: h };
    return { ok: true, value: [{ role: 'system', content: `Summary of previous conversation: ${res.value.content}` }, ...rec] };
  }

  private _buildRagMetadata(): RagMetadata {
    const p = this.config.sessionPolicy; if (!p) return {};
    const m: RagMetadata = {}; if (p.namespace !== undefined) m.namespace = p.namespace;
    if (p.maxSessionAgeMs !== undefined) m.ttl = Math.floor((Date.now() + p.maxSessionAgeMs) / 1000);
    return m;
  }
}
