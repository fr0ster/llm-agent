import type {
  CallOptions,
  IMcpClient,
  IToolCache,
  Message,
} from '@mcp-abap-adt/llm-agent';
import { recordToolInvocation, scopedUsage } from '@mcp-abap-adt/llm-agent';
import type { IMetrics } from '../metrics/types.js';
import {
  guardToolRound,
  type ParsedToolCall,
} from '../pipeline/handlers/tool-loop-core.js';
import type {
  PendingToolResult,
  PendingToolResultsRegistry,
} from './pending-tool-results-registry.js';

export interface MixedToolCallContext {
  toolClientMap: Map<string, IMcpClient>;
  toolCache: IToolCache;
  metrics: IMetrics;
  options?: CallOptions;
  roundCalls?: ParsedToolCall[];
  roundRejections?: ReadonlyMap<number, string>;
  skippedCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  maxToolCalls?: number;
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
    tool_calls: [...internalCalls, ...(ctx.skippedCalls ?? [])].map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    })),
  };

  const round = ctx.roundCalls ?? internalCalls;
  const rejections = ctx.roundRejections ?? guardToolRound(round, ctx.options);
  const internalPromise = Promise.all(
    internalCalls.map(async (tc): Promise<PendingToolResult> => {
      try {
        const rejection = rejections?.get(round.indexOf(tc));
        if (rejection !== undefined)
          return {
            toolCallId: tc.id,
            toolName: tc.name,
            text: `Error: ${rejection}`,
          };
        const client = ctx.toolClientMap.get(tc.name);
        if (!client) {
          return { toolCallId: tc.id, toolName: tc.name, text: '' };
        }
        const res = await recordToolInvocation(
          ctx.options?.onToolTrace,
          tc.name,
          tc.arguments,
          () =>
            client.callTool(tc.name, tc.arguments, {
              ...ctx.options,
              usage: scopedUsage(ctx.options?.usage, {
                component: 'tool-loop',
              }),
            }),
          (result) => ({
            failed: !result.ok || !!result.value.isError,
            value: result.ok ? result.value : result.error,
            error: result.ok
              ? 'MCP tool returned isError'
              : result.error.message,
          }),
        );
        const text = !res.ok
          ? res.error.message
          : typeof res.value.content === 'string'
            ? res.value.content
            : JSON.stringify(res.value.content);
        if (res.ok && client.cacheable !== false)
          ctx.toolCache.set(tc.name, tc.arguments, res.value);
        ctx.metrics.toolCallCount.add();
        ctx.options?.sessionLogger?.logStep(
          `mcp_call_${tc.name}`,
          {
            arguments: tc.arguments,
            result: text,
          },
          'mcp',
        );
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
    promise: internalPromise.then((results) => [
      ...results,
      ...(ctx.skippedCalls ?? []).map((tc) => ({
        toolCallId: tc.id,
        toolName: tc.name,
        text: `Error: not executed: tool-call budget of ${ctx.maxToolCalls} for this request is exhausted; return what you have and report what is missing`,
      })),
    ]),
    createdAt: Date.now(),
  });
}
