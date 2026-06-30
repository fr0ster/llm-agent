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
  for await (const chunk of stream) {
    if (!chunk.ok) {
      // process() returns on the first error chunk → post-loop code never
      // runs. Log accumulated (partial) spend BEFORE yielding the error.
      logPassUsage();
      yield chunk;
      return;
    }
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
  opts?.sessionLogger?.logStep('llm_response_pass', {
    content: passContent,
    toolCalls: passToolCalls.length > 0 ? passToolCalls : undefined,
  });
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
