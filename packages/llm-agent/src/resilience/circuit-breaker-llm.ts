/**
 * CircuitBreakerLlm — ILlm decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls return `Result { ok: false, error: LlmError('CIRCUIT_OPEN') }`
 * without hitting the underlying LLM.
 */

import type { ILlm, Message } from '@mcp-abap-adt/llm-agent';
import {
  type CallOptions,
  LlmError,
  type LlmResponse,
  type LlmStreamChunk,
  type LlmTool,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import type { CircuitBreaker } from './circuit-breaker.js';

export class CircuitBreakerLlm implements ILlm {
  healthCheck?: ILlm['healthCheck'];

  constructor(
    private readonly inner: ILlm,
    readonly breaker: CircuitBreaker,
  ) {
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }

  get model(): string | undefined {
    return this.inner.model;
  }

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    if (!this.breaker.isCallPermitted) {
      return {
        ok: false,
        error: new LlmError('Circuit breaker is open', 'CIRCUIT_OPEN'),
      };
    }
    const result = await this.inner.chat(messages, tools, options);
    if (result.ok) {
      this.breaker.recordSuccess();
    } else {
      this.breaker.recordFailure();
    }
    return result;
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    if (!this.breaker.isCallPermitted) {
      yield {
        ok: false,
        error: new LlmError('Circuit breaker is open', 'CIRCUIT_OPEN'),
      };
      return;
    }
    let hadError = false;
    try {
      for await (const chunk of this.inner.streamChat(
        messages,
        tools,
        options,
      )) {
        if (!chunk.ok) {
          hadError = true;
          this.breaker.recordFailure();
          yield chunk;
          return;
        }
        yield chunk;
      }
    } catch (err) {
      hadError = true;
      this.breaker.recordFailure();
      yield {
        ok: false,
        error: new LlmError(String(err), 'LLM_ERROR'),
      };
      return;
    }
    if (!hadError) {
      this.breaker.recordSuccess();
    }
  }
}
