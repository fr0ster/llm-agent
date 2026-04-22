import type { CallOptions, IMcpClient, Message } from '@mcp-abap-adt/llm-agent';
import type { IToolCache } from '../cache/types.js';
import type { IMetrics } from '../metrics/types.js';
import type {
  PendingToolResult,
  PendingToolResultsRegistry,
} from './pending-tool-results-registry.js';

export interface MixedToolCallContext {
  toolClientMap: Map<string, IMcpClient>;
  toolCache: IToolCache;
  metrics: IMetrics;
  options?: CallOptions;
}

export function fireInternalToolsAsync(
  content: string,
  internalCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
  registry: PendingToolResultsRegistry,
  sessionId: string,
  ctx: MixedToolCallContext,
): void {
  const assistantMessage: Message = {
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
  };

  const internalPromise = Promise.all(
    internalCalls.map(async (tc): Promise<PendingToolResult> => {
      try {
        const client = ctx.toolClientMap.get(tc.name);
        if (!client) {
          return { toolCallId: tc.id, toolName: tc.name, text: '' };
        }
        const res = await client.callTool(tc.name, tc.arguments, ctx.options);
        const text = !res.ok
          ? res.error.message
          : typeof res.value.content === 'string'
            ? res.value.content
            : JSON.stringify(res.value.content);
        if (res.ok) ctx.toolCache.set(tc.name, tc.arguments, res.value);
        ctx.metrics.toolCallCount.add();
        ctx.options?.sessionLogger?.logStep(`mcp_call_${tc.name}`, {
          arguments: tc.arguments,
          result: text,
        });
        return { toolCallId: tc.id, toolName: tc.name, text };
      } catch (err) {
        return {
          toolCallId: tc.id,
          toolName: tc.name,
          text: `Error: ${String(err)}`,
        };
      }
    }),
  );

  registry.set(sessionId, {
    assistantMessage,
    promise: internalPromise,
    createdAt: Date.now(),
  });
}
