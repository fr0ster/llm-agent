import type {
  CallOptions,
  IMcpClient,
  IToolCache,
  Message,
} from '@mcp-abap-adt/llm-agent';
import {
  overflowError,
  recordToolInvocation,
  scopedUsage,
  toAbortError,
} from '@mcp-abap-adt/llm-agent';
import type { IMetrics } from '../metrics/types.js';
import {
  guardToolRound,
  type ParsedToolCall,
} from '../pipeline/handlers/tool-loop-core.js';
import type { CallerResolution } from './caller-identity.js';
import type {
  PendingSourceMessages,
  PendingToolCallsEntry,
  PendingToolResult,
  PendingToolResultsRegistry,
} from './pending-tool-results-registry.js';
import { createPendingToolCallsEntry } from './pending-tool-results-registry.js';

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
  assistantMessage?: Message;
  resolvedResults?: Message[];
  precedingMessages?: Message[];
  sourceMessages?: PendingSourceMessages;
  externalCalls?: ParsedToolCall[];
}

export function fireInternalToolsAsync(
  content: string,
  internalCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>,
  registry: PendingToolResultsRegistry,
  identity: CallerResolution,
  ctx: MixedToolCallContext,
): PendingToolCallsEntry {
  const assistantMessage: Message = ctx.assistantMessage ?? {
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
          return {
            toolCallId: tc.id,
            toolName: tc.name,
            text: `Error: Tool "${tc.name}" is unavailable.`,
          };
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
        if (!res.ok) {
          const terminal =
            toAbortError(res.error, ctx.options?.signal) ??
            overflowError(res.error);
          if (terminal) throw terminal;
        }
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
        const terminal =
          toAbortError(err, ctx.options?.signal) ?? overflowError(err);
        if (terminal) throw terminal;
        return {
          toolCallId: tc.id,
          toolName: tc.name,
          text: `Error: ${String(err)}`,
        };
      }
    }),
  );

  const entry: Parameters<PendingToolResultsRegistry['set']>[1] = {
    assistantMessage: structuredClone(assistantMessage),
    precedingMessages: structuredClone(ctx.precedingMessages),
    sourceMessages: structuredClone(ctx.sourceMessages),
    externalCalls: (ctx.externalCalls ?? []).map((call) => ({
      toolCallId: call.id,
    })),
    promise: internalPromise.then((results) =>
      [
        ...results,
        ...(ctx.resolvedResults ?? []).map((message) => ({
          toolCallId: message.tool_call_id ?? '',
          toolName:
            assistantMessage.tool_calls?.find(
              (call) => call.id === message.tool_call_id,
            )?.function.name ?? '',
          text: String(message.content ?? ''),
        })),
        ...(ctx.skippedCalls ?? []).map((tc) => ({
          toolCallId: tc.id,
          toolName: tc.name,
          text: `Error: not executed: tool-call budget of ${ctx.maxToolCalls} for this request is exhausted; return what you have and report what is missing`,
        })),
      ].sort((a, b) => {
        const calls = assistantMessage.tool_calls ?? [];
        return (
          calls.findIndex((call) => call.id === a.toolCallId) -
          calls.findIndex((call) => call.id === b.toolCallId)
        );
      }),
    ),
    createdAt: Date.now(),
  };
  // A suspended turn may never resume to observe the background rejection.
  void entry.promise.catch(() => {});
  return identity.kind === 'caller'
    ? registry.set(identity.caller, entry)
    : createPendingToolCallsEntry(entry);
}
