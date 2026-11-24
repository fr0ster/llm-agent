import {
  type CallOptions,
  errorUsage,
  type ILlm,
  type LlmTool,
  type Message,
  overflowError,
  toAbortError,
} from '@mcp-abap-adt/llm-agent';
import type { SubagentResult } from './types.js';

export interface ISubagentClient {
  send(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<SubagentResult>;
}

/**
 * Narrow a full `CallOptions` down to the diagnostic-only subset safe to hand to
 * controller subagent roles (reviewer, finalizer, planner, target-state
 * evaluator). These roles rely on STRUCTURED output (JSON plans, verdicts) —
 * generation params (`model`/`temperature`/`maxTokens`/`topP`/`stop`) built from
 * the client request body must NOT reach them, only the diagnostic-only fields
 * needed for tracing, cancellation, and usage accounting. `undefined` in → `undefined` out.
 */
export function diagnosticCallOptions(
  opts?: CallOptions,
  role?: string,
): CallOptions | undefined {
  if (!opts) return undefined;
  const out: CallOptions = {};
  if (opts.caller !== undefined) out.caller = opts.caller;
  if (opts.userId !== undefined) out.userId = opts.userId;
  if (opts.sessionLogger !== undefined) out.sessionLogger = opts.sessionLogger;
  if (opts.trace !== undefined) out.trace = opts.trace;
  if (opts.sessionId !== undefined) out.sessionId = opts.sessionId;
  if (opts.signal !== undefined) out.signal = opts.signal;
  if (opts.usage !== undefined)
    out.usage = role ? opts.usage.with({ role }) : opts.usage;
  if (opts.usageOp !== undefined) out.usageOp = opts.usageOp;
  return out;
}

export function makeSubagentClient(llm: ILlm): ISubagentClient {
  let seq = 0;
  return {
    async send(messages, tools, options) {
      const n = ++seq;
      options?.sessionLogger?.logStep(
        `llm_request_${n}`,
        { messages, tools: tools ?? [] },
        'llm',
      );
      const failure = <T>(
        error: T,
        ordinaryMessage?: string,
      ): SubagentResult => {
        const abort = toAbortError(error, options?.signal);
        const contextOverflow = abort ? undefined : overflowError(error);
        const terminal = abort ?? contextOverflow;
        if (!terminal && ordinaryMessage === undefined) throw error;
        const message =
          ordinaryMessage ?? terminal?.message ?? 'subagent llm error';
        const { usage } = errorUsage(terminal ?? error);
        options?.sessionLogger?.logStep(
          `llm_response_${n}`,
          { error: message },
          'llm',
        );
        return {
          kind: 'error',
          error: message,
          ...(abort && { abort }),
          ...(contextOverflow && { contextOverflow }),
          ...(usage && { usage }),
        };
      };
      let r: Awaited<ReturnType<ILlm['chat']>>;
      try {
        r = await llm.chat(messages, tools, options);
      } catch (error) {
        return failure(error);
      }
      if (!r.ok) {
        return failure(r.error, r.error?.message ?? 'subagent llm error');
      }
      const v = r.value;
      options?.sessionLogger?.logStep(
        `llm_response_${n}`,
        {
          content: v.content ?? '',
          toolCalls: v.toolCalls ?? [],
          finishReason: v.finishReason,
          usage: v.usage,
        },
        'llm',
      );
      const usage = v.usage ? { usage: v.usage } : {};
      if (
        v.finishReason === 'tool_calls' &&
        v.toolCalls &&
        v.toolCalls.length > 0
      )
        return {
          kind: 'tool_call',
          ...(v.content ? { content: v.content } : {}),
          toolCalls: v.toolCalls,
          ...usage,
        };
      return { kind: 'content', content: v.content ?? '', ...usage };
    },
  };
}
