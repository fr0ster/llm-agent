/**
 * RateLimiterLlm — ILlm decorator that throttles outbound requests.
 *
 * Composition order: RateLimiterLlm → RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Rate limiter sits outermost so that retry attempts also respect the limit.
 */
import type { CallOptions, ILlm, ILlmRateLimiter, LlmError, LlmResponse, LlmStreamChunk, LlmTool, Message, Result } from '@mcp-abap-adt/llm-agent';
export declare class RateLimiterLlm implements ILlm {
    private readonly inner;
    private readonly limiter;
    healthCheck?: ILlm['healthCheck'];
    constructor(inner: ILlm, limiter: ILlmRateLimiter);
    get model(): string | undefined;
    chat(messages: Message[], tools?: LlmTool[], options?: CallOptions): Promise<Result<LlmResponse, LlmError>>;
    streamChat(messages: Message[], tools?: LlmTool[], options?: CallOptions): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
//# sourceMappingURL=rate-limiter-llm.d.ts.map