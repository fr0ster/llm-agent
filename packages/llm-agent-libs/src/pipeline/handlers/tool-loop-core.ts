/**
 * Shared setup-phase helpers for the two tool-loop implementations
 * (SmartAgent._runStreamingToolLoop and ToolLoopHandler.execute).
 *
 * These helpers are INTERNAL to llm-agent-libs and are NOT exported from
 * the package barrel (src/index.ts).
 */
import type { CallOptions, LlmTool, Message } from '@mcp-abap-adt/llm-agent';
import type { PendingToolResultsRegistry } from '../../policy/pending-tool-results-registry.js';

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
