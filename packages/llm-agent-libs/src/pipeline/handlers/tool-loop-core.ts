/**
 * Shared setup-phase helpers for the two tool-loop implementations
 * (SmartAgent._runStreamingToolLoop and ToolLoopHandler.execute).
 *
 * These helpers are INTERNAL to llm-agent-libs and are NOT exported from
 * the package barrel (src/index.ts).
 */
import type {
  CallOptions,
  IMcpClient,
  IMcpFailureClassifier,
  IToolCache,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
  TimingEntry,
} from '@mcp-abap-adt/llm-agent';
import { OrchestratorError } from '@mcp-abap-adt/llm-agent';
import type { IMetrics } from '../../metrics/types.js';
import type { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import {
  isToolContextUnavailableError,
  type ToolAvailabilityRegistry,
} from '../../policy/tool-availability-registry.js';
import type { ISpan, ITracer } from '../../tracer/types.js';
import type { IOutputValidator } from '../../validator/types.js';
import { classifyToolResult } from './escalate-if-unavailable.js';

export type ParsedToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export interface IClassifiedToolCalls {
  internalCalls: ParsedToolCall[];
  validExternalCalls: ParsedToolCall[];
  blockedCalls: ParsedToolCall[];
  hallucinations: ParsedToolCall[];
}

/** Partition tool calls into internal / valid-external / blocked / hallucinated. */
export function classifyToolCalls(
  toolCalls: ParsedToolCall[],
  toolClientMap: Map<string, IMcpClient>,
  externalToolNames: Set<string>,
  toolAvailabilityRegistry: ToolAvailabilityRegistry,
  sessionId: string,
): IClassifiedToolCalls {
  const internalCalls = toolCalls.filter((tc) => toolClientMap.has(tc.name));
  const validExternalCalls = toolCalls.filter((tc) =>
    externalToolNames.has(tc.name),
  );
  const blockedToolNames =
    toolAvailabilityRegistry.getBlockedToolNames(sessionId);
  const blockedCalls = toolCalls.filter((tc) => blockedToolNames.has(tc.name));
  const hallucinations = toolCalls.filter(
    (tc) =>
      !blockedToolNames.has(tc.name) &&
      !toolClientMap.has(tc.name) &&
      !externalToolNames.has(tc.name),
  );
  return { internalCalls, validExternalCalls, blockedCalls, hallucinations };
}

/** Append the client-tool priority instruction to the system message when
 *  external tools are present. Returns messages unchanged otherwise. */
export function injectToolPriority(
  messages: Message[],
  externalTools: LlmTool[],
): Message[] {
  if (externalTools.length > 0) {
    const systemIdx = messages.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      const sys = messages[systemIdx];
      const next = [...messages];
      next[systemIdx] = {
        ...sys,
        content: `${sys.content}\n\nIMPORTANT: You have internal tools and client-provided tools (marked [client-provided] in their description). Always prefer internal tools when they can accomplish the task. Use client-provided tools only when no internal tool can do the job.`,
      };
      return next;
    }
  }
  return messages;
}

/** Filter out session-blocked tools; log the blocked set when non-empty.
 *  Returns the allowed subset. */
export function filterAvailableTools(
  registry: ToolAvailabilityRegistry,
  sessionId: string,
  currentTools: LlmTool[],
  iteration: number,
  options: CallOptions | undefined,
): LlmTool[] {
  const filtered = registry.filterTools(sessionId, currentTools);
  if (filtered.blocked.length > 0) {
    options?.sessionLogger?.logStep('active_tools_filtered_in_iteration', {
      iteration: iteration + 1,
      blocked: filtered.blocked,
    });
  }
  return filtered.allowed;
}

/** Inject pending internal tool results from a prior mixed-call request. */
export async function injectPendingResults(
  messages: Message[],
  pendingToolResults: PendingToolResultsRegistry,
  sessionId: string,
  options: CallOptions | undefined,
): Promise<Message[]> {
  if (pendingToolResults.has(sessionId)) {
    const pending = await pendingToolResults.consume(sessionId);
    if (pending) {
      const next = [
        ...messages,
        pending.assistantMessage,
        ...pending.results.map((r) => ({
          role: 'tool' as const,
          content: r.text,
          tool_call_id: r.toolCallId,
        })),
      ];
      options?.sessionLogger?.logStep('pending_tool_results_injected', {
        toolNames: pending.results.map((r) => r.toolName),
      });
      return next;
    }
  }
  return messages;
}

/** Append an assistant(tool_calls=blocked) + per-blocked tool-error messages;
 *  log the interception. Returns the extended messages. */
export function buildBlockedToolMessages(
  messages: Message[],
  content: string,
  blockedCalls: ParsedToolCall[],
  options: CallOptions | undefined,
): Message[] {
  let next: Message[] = [
    ...messages,
    {
      role: 'assistant' as const,
      content: content || null,
      tool_calls: blockedCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    },
  ];
  for (const blocked of blockedCalls) {
    next = [
      ...next,
      {
        role: 'tool' as const,
        content: `Error: Tool "${blocked.name}" is temporarily unavailable in this session.`,
        tool_call_id: blocked.id,
      },
    ];
  }
  options?.sessionLogger?.logStep('blocked_tool_calls_intercepted', {
    toolNames: blockedCalls.map((tc) => tc.name),
  });
  return next;
}

/** Append an assistant(tool_calls=ALL calls) + per-hallucination "not found"
 *  tool messages. Returns the extended messages. */
export function buildHallucinatedToolMessages(
  messages: Message[],
  content: string,
  toolCalls: ParsedToolCall[],
  hallucinations: ParsedToolCall[],
): Message[] {
  let next: Message[] = [
    ...messages,
    {
      role: 'assistant' as const,
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    },
  ];
  for (const h of hallucinations) {
    next = [
      ...next,
      {
        role: 'tool' as const,
        content: `Error: Tool "${h.name}" not found.`,
        tool_call_id: h.id,
      },
    ];
  }
  return next;
}

export type ToolExecResult = {
  tc: ParsedToolCall;
  text: string;
  res: Result<
    { content: string | Record<string, unknown>; isError?: boolean },
    { message: string }
  > | null;
  duration: number;
  cached: boolean;
};

export type BatchOutcome =
  | { escalated: true }
  | {
      escalated: false;
      currentTools: LlmTool[];
      toolCallCount: number;
      toolMessages: Message[];
    };

export interface IExecuteToolBatchArgs {
  batch: ParsedToolCall[];
  toolClientMap: Map<string, IMcpClient>;
  toolCache: IToolCache;
  tracer: ITracer;
  metrics: IMetrics;
  parentSpan: ISpan; // toolLoopSpan (A) / parentSpan (B)
  toolAvailabilityRegistry: ToolAvailabilityRegistry;
  sessionId: string;
  externalToolNames: Set<string>;
  currentTools: LlmTool[];
  toolCallCount: number;
  timingLog: TimingEntry[]; // pushed into (per-tool timing)
  heartbeatMs: number;
  options: CallOptions | undefined;
  onToolExecuted?: (r: ToolExecResult) => void; // B: logToolCall; A: omitted
  mcpFailureClassifier?: IMcpFailureClassifier;
}

/** Execute a batch of internal tool calls concurrently, yielding heartbeat
 *  chunks while they run; on an MCP-availability escalation yield an error
 *  chunk and return `{ escalated: true }`; otherwise return the updated
 *  currentTools / toolCallCount / tool messages. */
export async function* executeToolBatchWithHeartbeat(
  args: IExecuteToolBatchArgs,
): AsyncGenerator<Result<LlmStreamChunk, OrchestratorError>, BatchOutcome> {
  const {
    batch,
    toolClientMap,
    toolCache,
    tracer,
    metrics,
    parentSpan,
    toolAvailabilityRegistry,
    sessionId,
    externalToolNames,
    timingLog,
    heartbeatMs,
    options,
    onToolExecuted,
  } = args;
  let currentTools = args.currentTools;
  let toolCallCount = args.toolCallCount;

  const toolExecPromises = batch.map(async (tc): Promise<ToolExecResult> => {
    const toolStart = Date.now();
    options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
      arguments: tc.arguments,
    });
    const client = toolClientMap.get(tc.name);
    if (!client) return { tc, text: '', res: null, duration: 0, cached: false };
    const toolSpan = tracer.startSpan('smart_agent.tool_call', {
      parent: parentSpan,
      attributes: { 'tool.name': tc.name },
    });
    const cachedValue = toolCache.get(tc.name, tc.arguments);
    const wasCached = !!cachedValue;
    const res = cachedValue
      ? (() => {
          metrics.toolCacheHitCount.add();
          toolSpan.setAttribute('cache', 'hit');
          return { ok: true as const, value: cachedValue };
        })()
      : await (async () => {
          const r = await client.callTool(tc.name, tc.arguments, options);
          if (r.ok) toolCache.set(tc.name, tc.arguments, r.value);
          return r;
        })();
    const text = !res.ok
      ? res.error.message
      : typeof res.value.content === 'string'
        ? res.value.content
        : JSON.stringify(res.value.content);
    toolSpan.setStatus(res.ok ? 'ok' : 'error', res.ok ? undefined : text);
    toolSpan.end();
    return {
      tc,
      text,
      res,
      duration: Date.now() - toolStart,
      cached: wasCached,
    };
  });

  const allDone = Promise.all(toolExecPromises);
  const pendingTools = new Set(batch.map((tc) => tc.name));
  const toolStartTime = Date.now();
  let results: ToolExecResult[] = [];
  let settled = false;

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
      for (const tool of pendingTools) {
        yield {
          ok: true,
          value: {
            content: '',
            heartbeat: { tool, elapsed: Date.now() - toolStartTime },
          },
        };
      }
    }
  }

  for (const r of results) {
    timingLog.push({ phase: `tool_${r.tc.name}`, duration: r.duration });
  }

  const toolMessages: Message[] = [];
  for (const r of results) {
    const { tc, text, res } = r;
    if (!res) continue;
    // FAIL LOUD on an MCP availability failure — yield an error chunk (→ the
    // caller returns ok:false) instead of feeding "MCP error" to the LLM.
    const tcClient = toolClientMap.get(tc.name);
    const probe = tcClient?.healthCheck
      ? () => tcClient.healthCheck!().then((hr) => (hr.ok ? hr.value : false))
      : undefined;
    const decision = await classifyToolResult(
      res,
      args.mcpFailureClassifier,
      probe,
    );
    if (decision.escalate) {
      // Emit timing BEFORE escalating so the timed-out/unavailable tool call
      // appears in the timing log. onToolExecuted fires exactly once here;
      // the end-of-loop call is skipped because we return early.
      onToolExecuted?.(r);
      yield {
        ok: false,
        error: new OrchestratorError(
          decision.escalate.message,
          'MCP_UNAVAILABLE',
        ),
      };
      return { escalated: true };
    }
    if (
      !res.ok &&
      isToolContextUnavailableError(text) &&
      !externalToolNames.has(tc.name)
    ) {
      const entry = toolAvailabilityRegistry.block(sessionId, tc.name, text);
      currentTools = currentTools.filter((t) => t.name !== tc.name);
      options?.sessionLogger?.logStep(`tool_blacklisted_${tc.name}`, {
        reason: text,
        blockedUntil: entry.blockedUntil,
      });
    }
    options?.sessionLogger?.logStep(`mcp_result_${tc.name}`, { result: text });
    toolCallCount++;
    metrics.toolCallCount.add();
    toolMessages.push({
      role: 'tool' as const,
      content: text,
      tool_call_id: tc.id,
    });
    onToolExecuted?.(r);
  }
  return { escalated: false, currentTools, toolCallCount, toolMessages };
}

export interface IReprompt {
  reprompt: boolean;
  messages: Message[];
}

/** Validate the no-tool-call output; on invalid, append the assistant reply +
 *  a correction user message and signal a reprompt. Otherwise pass through. */
export async function runOutputValidationReprompt(
  outputValidator: IOutputValidator,
  content: string,
  messages: Message[],
  currentTools: LlmTool[],
  options: CallOptions | undefined,
): Promise<IReprompt> {
  const valResult = await outputValidator.validate(
    content,
    { messages, tools: currentTools },
    options,
  );
  if (valResult.ok && !valResult.value.valid) {
    const correction =
      valResult.value.correctedContent ?? valResult.value.reason;
    return {
      reprompt: true,
      messages: [
        ...messages,
        { role: 'assistant' as const, content },
        {
          role: 'user' as const,
          content: `Your previous response was rejected by validation: ${correction}. Please try again.`,
        },
      ],
    };
  }
  return { reprompt: false, messages };
}
