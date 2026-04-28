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
export declare class CircuitBreakerLlm implements ILlm {
  private readonly inner;
  readonly breaker: CircuitBreaker;
  healthCheck?: ILlm['healthCheck'];
  constructor(inner: ILlm, breaker: CircuitBreaker);
  get model(): string | undefined;
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;
  streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
//# sourceMappingURL=circuit-breaker-llm.d.ts.map
