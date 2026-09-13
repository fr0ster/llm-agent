import type {
  CallOptions,
  ILlm,
  IRequestLogger,
  LlmStreamChunk,
  LlmTool,
  Message,
  OrchestratorError,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { summaryToUsage } from '../../logger/session-request-logger.js';

export async function* runPassThrough(
  llm: ILlm,
  requestLogger: IRequestLogger,
  messages: Message[],
  externalTools: LlmTool[],
  opts: CallOptions | undefined,
): AsyncIterable<Result<LlmStreamChunk, OrchestratorError>> {
  const passStart = Date.now();
  const traceId2 = opts?.trace?.traceId;
  opts?.sessionLogger?.logStep(
    'llm_request_pass',
    { messages, tools: externalTools ?? [] },
    'llm',
  );
  const stream = llm.streamChat(messages, externalTools, opts);
  let passContent = '';
  const passToolCalls: unknown[] = [];
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
            code: (chunk.error as { code?: unknown }).code,
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
      passToolCalls.length = 0;
      continue;
    }
    if (chunk.value.content) passContent += chunk.value.content;
    if (chunk.value.toolCalls) passToolCalls.push(...chunk.value.toolCalls);
    if (chunk.value.usage) {
      accPrompt += chunk.value.usage.promptTokens;
      accCompletion += chunk.value.usage.completionTokens;
      accTotal += chunk.value.usage.totalTokens;
      hasUsage = true;
    }
    // Strip usage from the forwarded chunk: the single usage-bearing chunk
    // is the terminal getSummary chunk below (one usage chunk per request).
    const { usage: _omitUsage, ...rest } = chunk.value;
    yield { ok: true, value: rest };
  }
  opts?.sessionLogger?.logStep(
    'llm_response_pass',
    {
      content: passContent,
      toolCalls: passToolCalls.length > 0 ? passToolCalls : undefined,
    },
    'llm',
  );
  logPassUsage();
  const passSummary = traceId2 ? requestLogger.getSummary(traceId2) : undefined;
  yield {
    ok: true,
    value: {
      content: '',
      finishReason: 'stop',
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
