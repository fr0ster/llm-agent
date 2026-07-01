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
  LlmTool,
  Message,
} from '@mcp-abap-adt/llm-agent';
import type { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';
import type { ToolAvailabilityRegistry } from '../../policy/tool-availability-registry.js';

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
