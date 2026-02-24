import type { Message } from '../../types.js';
import type { ILlm } from '../interfaces/llm.js';
import type {
  CallOptions,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '../interfaces/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

// ---------------------------------------------------------------------------
// TokenCountingLlm
// ---------------------------------------------------------------------------

/**
 * Decorator that wraps any ILlm and accumulates token usage from raw provider
 * responses. Compatible with OpenAI / DeepSeek (`usage.prompt_tokens`) and
 * Anthropic (`usage.input_tokens`) response shapes.
 */
export class TokenCountingLlm implements ILlm {
  private usage: TokenUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    requests: 0,
  };

  constructor(private readonly inner: ILlm) {}

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    const result = await this.inner.chat(messages, tools, options);

    if (result.ok) {
      this.usage.requests++;
      // biome-ignore lint/suspicious/noExplicitAny: raw provider payload has no stable type
      const u = (result.value.raw as any)?.usage;
      if (u) {
        this.usage.prompt_tokens +=
          (u.prompt_tokens as number | undefined) ??
          (u.input_tokens as number | undefined) ??
          0;
        this.usage.completion_tokens +=
          (u.completion_tokens as number | undefined) ??
          (u.output_tokens as number | undefined) ??
          0;
        this.usage.total_tokens +=
          (u.total_tokens as number | undefined) ??
          this.usage.prompt_tokens + this.usage.completion_tokens;
      }
    }

    return result;
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncGenerator<LlmStreamChunk, void, unknown> {
    if (!this.inner.streamChat) {
      throw new Error('Inner ILlm does not support streaming');
    }

    this.usage.requests++;

    for await (const chunk of this.inner.streamChat(messages, tools, options)) {
      if (chunk.type === 'usage') {
        this.usage.prompt_tokens += chunk.promptTokens;
        this.usage.completion_tokens += chunk.completionTokens;
        this.usage.total_tokens += chunk.promptTokens + chunk.completionTokens;
      }
      yield chunk;
    }
  }

  /** Returns a snapshot of accumulated usage. */
  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  /** Resets all counters to zero. */
  resetUsage(): void {
    this.usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      requests: 0,
    };
  }
}
