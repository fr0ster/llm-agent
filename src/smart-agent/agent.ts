import type { Message } from '../types.js';
import type { IContextAssembler } from './interfaces/assembler.js';
import type { ISubpromptClassifier } from './interfaces/classifier.js';
import type { ILlm } from './interfaces/llm.js';
import type { IMcpClient } from './interfaces/mcp-client.js';
import type { IRag } from './interfaces/rag.js';
import {
  SmartAgentError,
  type CallOptions,
  type LlmTool,
  type McpTool,
  type RagResult,
  type Result,
  type Subprompt,
  type ToolCallRecord,
} from './interfaces/types.js';

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
    // Step 1: pre-abort check
    if (options?.signal?.aborted) {
      return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
    }

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
      return await this._runPipeline(text, opts);
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
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    // Step 4: classify
    const classifyResult = await this.deps.classifier.classify(text, opts);
    if (!classifyResult.ok) {
      const code =
        classifyResult.error.code === 'ABORTED' ? 'ABORTED' : 'CLASSIFIER_ERROR';
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
      others.map((sp) => {
        const store = ragStoreMap.get(sp.type);
        return store ? store.upsert(sp.text, {}, opts) : Promise.resolve();
      }),
    );

    // Step 7: no actions → empty response
    if (actions.length === 0) {
      return {
        ok: true,
        value: { content: '', iterations: 0, toolCallCount: 0, stopReason: 'stop' },
      };
    }

    // Step 8: take first action
    const action = actions[0];

    // Step 9: RAG retrieval (non-fatal — failures fall back to [])
    const k = this.config.ragQueryK ?? 5;
    const [factsR, feedbackR, stateR] = await Promise.all([
      this.deps.ragStores.facts.query(action.text, k, opts),
      this.deps.ragStores.feedback.query(action.text, k, opts),
      this.deps.ragStores.state.query(action.text, k, opts),
    ]);
    const facts: RagResult[] = factsR.ok ? factsR.value : [];
    const feedback: RagResult[] = feedbackR.ok ? feedbackR.value : [];
    const state: RagResult[] = stateR.ok ? stateR.value : [];

    // Step 10: list all MCP tools
    const { tools: mcpTools, toolClientMap } = await this._listAllTools(opts);

    // Step 11: initial context assembly
    const retrieved = { facts, feedback, state, tools: mcpTools };
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
    return this._runToolLoop(
      action,
      retrieved,
      assembleResult.value,
      toolClientMap,
      opts,
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
    action: Subprompt,
    retrieved: {
      facts: RagResult[];
      feedback: RagResult[];
      state: RagResult[];
      tools: McpTool[];
    },
    initialMessages: Message[],
    toolClientMap: Map<string, IMcpClient>,
    opts: CallOptions | undefined,
  ): Promise<Result<SmartAgentResponse, OrchestratorError>> {
    let toolCallCount = 0;
    const toolResults: ToolCallRecord[] = [];
    let messages = initialMessages;
    let content = '';

    for (let iteration = 0; ; iteration++) {
      // Abort check at top of each iteration
      if (opts?.signal?.aborted) {
        return { ok: false, error: new OrchestratorError('Aborted', 'ABORTED') };
      }

      // Iteration limit guard
      if (iteration >= this.config.maxIterations) {
        return {
          ok: true,
          value: { content, iterations: iteration, toolCallCount, stopReason: 'iteration_limit' },
        };
      }

      // LLM call — McpTool and LlmTool are structurally identical; cast directly
      const resp = await this.deps.mainLlm.chat(
        messages,
        retrieved.tools as LlmTool[],
        opts,
      );
      if (!resp.ok) {
        const code =
          resp.error.code === 'ABORTED' ? 'ABORTED' : 'LLM_ERROR';
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

      // Execute each tool call
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

        const client = toolClientMap.get(toolCall.name);
        if (!client) {
          toolResults.push({
            call: toolCall,
            result: {
              content: `Tool "${toolCall.name}" not found`,
              isError: true,
            },
          });
        } else {
          const callResult = await client.callTool(
            toolCall.name,
            toolCall.arguments,
            opts,
          );
          if (!callResult.ok) {
            toolResults.push({
              call: toolCall,
              result: { content: callResult.error.message, isError: true },
            });
          } else {
            toolResults.push({ call: toolCall, result: callResult.value });
          }
        }
        toolCallCount++;
      }

      // Re-assemble with accumulated tool results
      const reassembled = await this.deps.assembler.assemble(
        action,
        retrieved,
        toolResults,
        opts,
      );
      if (!reassembled.ok) {
        const code =
          reassembled.error.code === 'ABORTED' ? 'ABORTED' : 'ASSEMBLER_ERROR';
        return {
          ok: false,
          error: new OrchestratorError(reassembled.error.message, code),
        };
      }
      messages = reassembled.value;
    }
  }
}
