import type {
  CallOptions,
  ILlm,
  LlmTool,
  Message,
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
 * needed for tracing/cancellation. `undefined` in → `undefined` out.
 */
export function diagnosticCallOptions(
  opts?: CallOptions,
): CallOptions | undefined {
  if (!opts) return undefined;
  const out: CallOptions = {};
  if (opts.sessionLogger !== undefined) out.sessionLogger = opts.sessionLogger;
  if (opts.trace !== undefined) out.trace = opts.trace;
  if (opts.sessionId !== undefined) out.sessionId = opts.sessionId;
  if (opts.signal !== undefined) out.signal = opts.signal;
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
      const r = await llm.chat(messages, tools, options);
      if (!r.ok) {
        options?.sessionLogger?.logStep(
          `llm_response_${n}`,
          { error: r.error?.message ?? 'subagent llm error' },
          'llm',
        );
        return {
          kind: 'error',
          error: r.error?.message ?? 'subagent llm error',
        };
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
      if (v.toolCalls && v.toolCalls.length > 0)
        return { kind: 'tool_call', toolCalls: v.toolCalls, ...usage };
      return { kind: 'content', content: v.content ?? '', ...usage };
    },
  };
}
