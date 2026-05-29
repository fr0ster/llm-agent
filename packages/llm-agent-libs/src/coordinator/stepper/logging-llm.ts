import type {
  CallOptions,
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  LlmUsage,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';

/**
 * An ILlm decorator that reports token usage after every `chat` or `streamChat`
 * call via an injected `logUsage` callback. This is the authoritative path for
 * per-role usage logging in the Stepper runtime — it ensures every role's LLM
 * call is captured in the request-scoped byComponent breakdown regardless of
 * whether the role is the executor, planner, reviewer, or finalizer.
 *
 * Usage:
 *   const logged = new LoggingLlm(innerLlm, (u, d) =>
 *     requestLogger.logLlmCall({ component: 'planner', model, ...u, durationMs: d })
 *   );
 *
 * For `streamChat`, usage is accumulated from stream chunks and logged once the
 * stream ends.
 */
export class LoggingLlm implements ILlm {
  constructor(
    private readonly inner: ILlm,
    /** Called once per LLM invocation with the accumulated usage and duration. */
    private readonly logUsage: (usage: LlmUsage, durationMs: number) => void,
  ) {}

  get model(): string | undefined {
    return this.inner.model;
  }

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    const start = Date.now();
    const result = await this.inner.chat(messages, tools, options);
    const durationMs = Date.now() - start;
    if (result.ok && result.value.usage) {
      this.logUsage(result.value.usage, durationMs);
    }
    return result;
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    const start = Date.now();
    let accPrompt = 0;
    let accCompletion = 0;
    let accTotal = 0;
    let hasUsage = false;

    for await (const chunk of this.inner.streamChat(messages, tools, options)) {
      if (chunk.ok && chunk.value.usage) {
        accPrompt += chunk.value.usage.promptTokens;
        accCompletion += chunk.value.usage.completionTokens;
        accTotal += chunk.value.usage.totalTokens;
        hasUsage = true;
      }
      yield chunk;
    }

    if (hasUsage) {
      this.logUsage(
        {
          promptTokens: accPrompt,
          completionTokens: accCompletion,
          totalTokens: accTotal,
        },
        Date.now() - start,
      );
    }
  }

  healthCheck?(options?: CallOptions): Promise<Result<boolean, LlmError>> {
    return this.inner.healthCheck!(options);
  }

  getModels?(
    options?: CallOptions,
  ): Promise<Result<import('@mcp-abap-adt/llm-agent').IModelInfo[], LlmError>> {
    return this.inner.getModels!(options);
  }
}
