import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  LlmStreamChunk,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  addCacheTokenUsage,
  OrchestratorError,
  scopedUsage,
  type ToolTrust,
  toModelToolMessages,
  toToolCallDelta,
} from '@mcp-abap-adt/llm-agent';
import { summaryToUsage } from '../../logger/session-request-logger.js';
import type { CallerResolution } from '../../policy/caller-identity.js';
import {
  createPendingToolCallsEntry,
  PendingToolResultsRegistry,
} from '../../policy/pending-tool-results-registry.js';
import { ToolResponseRound } from './tool-response-round.js';

export async function* runPassThrough(
  llm: ILlm,
  requestLogger: IRequestLogger,
  messages: Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
  toolTrust?: ToolTrust,
  pendingToolResults: PendingToolResultsRegistry = new PendingToolResultsRegistry(),
  identity: CallerResolution = { kind: 'anonymous' },
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
  for (;;) {
    const passStart = Date.now();
    const traceId2 = opts?.trace?.traceId;
    opts?.sessionLogger?.logStep(
      'llm_request_pass',
      { messages, tools: externalTools ?? [] },
      'llm',
    );
    const stream = llm.streamChat(
      toModelToolMessages(messages, toolTrust),
      externalTools,
      {
        ...opts,
        usage: scopedUsage(opts?.usage, { component: 'tool-loop' }),
      },
    );
    let passContent = '';
    const calls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let finishReason: LlmStreamChunk['finishReason'];
    let cache: ReturnType<typeof addCacheTokenUsage> = {};
    let accPrompt = 0;
    let accCompletion = 0;
    let accTotal = 0;
    let hasUsage = false;
    const logPassUsage = (): void => {
      // Log only if a usage chunk was actually seen (mirrors
      // LoggingLlm.streamChat) — avoids creating a zero tool-loop bucket.
      if (!hasUsage) return;
      requestLogger.logLlmCall({
        component: 'tool-loop',
        model: llm.model ?? 'unknown',
        ...cache,
        promptTokens: accPrompt,
        completionTokens: accCompletion,
        totalTokens: accTotal,
        durationMs: Date.now() - passStart,
        requestId: traceId2,
      });
    };
    let chunksSeen = 0;
    for await (const chunk of stream) {
      if (!chunk.ok) {
        // process() returns on the first error chunk → post-loop code never
        // runs. Log accumulated (partial) spend BEFORE yielding the error, and
        // write the response trace here for the same reason (#290): the trace
        // that matters most is the one for the call that failed, and leaving on
        // this path recorded the question and nothing else.
        opts?.sessionLogger?.logStep(
          'llm_response_pass',
          {
            error: {
              message: chunk.error.message,
              code: chunk.error.code,
              cause: describeCause(chunk.error),
            },
            partialContent: passContent,
            chunksSeen,
          },
          'llm',
        );
        logPassUsage();
        yield chunk;
        return;
      }
      chunksSeen += 1;
      if (chunk.value.reset) {
        passContent = '';
        calls.clear();
        finishReason = undefined;
        continue;
      }
      if (chunk.value.content) passContent += chunk.value.content;
      if (chunk.value.finishReason) finishReason = chunk.value.finishReason;
      if (chunk.value.toolCalls) {
        for (const [index, raw] of chunk.value.toolCalls.entries()) {
          const call = toToolCallDelta(raw, index);
          const previous = calls.get(call.index);
          calls.set(call.index, {
            id: call.id || previous?.id || '',
            name: call.name || previous?.name || '',
            arguments: (previous?.arguments ?? '') + (call.arguments ?? ''),
          });
        }
      }
      if (chunk.value.usage) {
        cache = addCacheTokenUsage(cache, chunk.value.usage);
        accPrompt += chunk.value.usage.promptTokens;
        accCompletion += chunk.value.usage.completionTokens;
        accTotal += chunk.value.usage.totalTokens;
        hasUsage = true;
      }
      // Strip usage from the forwarded chunk: the single usage-bearing chunk
      // is the terminal getSummary chunk below (one usage chunk per request).
      // Buffer tool-call fragments until the suspension has its own returned IDs.
      const {
        usage: _omitUsage,
        toolCalls: _omitCalls,
        finishReason: _omitFinish,
        ...rest
      } = chunk.value;
      yield { ok: true, value: rest };
    }
    logPassUsage();
    const hasToolCalls = finishReason === 'tool_calls' && calls.size > 0;
    const round = new ToolResponseRound(
      passContent,
      calls.values(),
      () => true,
    );
    const executable = hasToolCalls ? round.executableCalls() : [];
    opts?.sessionLogger?.logStep(
      'llm_response_pass',
      { content: passContent, ...round.diagnostics(executable), finishReason },
      'llm',
    );
    if (finishReason === 'length') {
      yield {
        ok: false,
        error: new OrchestratorError(
          'LLM response was truncated at a token limit.',
          'LLM_OUTPUT_TRUNCATED',
        ),
      };
      return;
    }
    if (hasToolCalls) {
      if (executable.length === 0) {
        const complete = round.finish();
        yield { ok: true, value: { content: '', iterationEnd: 'retry' } };
        messages = [...messages, complete.assistant, ...complete.results];
        continue;
      }
      const entry: Parameters<PendingToolResultsRegistry['set']>[1] = {
        assistantMessage: round.assistant,
        precedingMessages: structuredClone(messages),
        sourceMessages: { input: structuredClone(messages), continuation: [] },
        externalCalls: executable.map((call) => ({
          toolCallId: call.id,
        })),
        promise: Promise.resolve(
          round.calls.flatMap((call) => {
            const message = round
              .resolved()
              .find((item) => item.tool_call_id === call.id);
            return message
              ? [
                  {
                    toolCallId: call.id,
                    toolName: call.name,
                    text: String(message.content ?? ''),
                  },
                ]
              : [];
          }),
        ),
        createdAt: Date.now(),
      };
      const pending =
        identity.kind === 'caller'
          ? pendingToolResults.set(identity.caller, entry)
          : createPendingToolCallsEntry(entry);
      yield {
        ok: true,
        value: {
          content: '',
          toolCalls: executable.map((call, index) => ({
            ...call,
            arguments: JSON.stringify(call.arguments),
            index,
            id: pending.externalCalls[index].returnedId,
          })),
        },
      };
    }
    const passSummary = traceId2
      ? requestLogger.getSummary(traceId2)
      : undefined;
    yield {
      ok: true,
      value: {
        content: '',
        finishReason: hasToolCalls ? 'tool_calls' : (finishReason ?? 'stop'),
        ...(passSummary
          ? {
              usage: {
                ...summaryToUsage(passSummary),
                models: passSummary.byModel,
              },
            }
          : {}),
      },
    };
    return;
  }
}

/**
 * The cause chain as plain text, bounded. See the twin in `tool-loop.ts`: a
 * provider failure carries what actually went wrong a level or two down, and a
 * trace showing only the outermost message sends the reader back to the logs it
 * was meant to replace.
 */
function describeCause(error: unknown): string[] {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = (error as { cause?: unknown })?.cause;
  while (cur && chain.length < 5 && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur instanceof Error ? cur.message : String(cur));
    cur = (cur as { cause?: unknown })?.cause;
  }
  return chain;
}
