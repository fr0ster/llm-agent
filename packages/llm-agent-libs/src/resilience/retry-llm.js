/**
 * RetryLlm — ILlm decorator that retries transient failures with exponential backoff.
 *
 * Composition order: RetryLlm → CircuitBreakerLlm → LlmAdapter
 * Retry sits outside the circuit breaker so that retry attempts are not
 * counted as separate failures.
 */
import { LlmError, } from '@mcp-abap-adt/llm-agent';
const DEFAULT_OPTIONS = {
    maxAttempts: 3,
    backoffMs: 2000,
    retryOn: [429, 500, 502, 503],
    retryOnMidStream: [],
};
export class RetryLlm {
    inner;
    opts;
    healthCheck;
    constructor(inner, options) {
        this.inner = inner;
        this.opts = { ...DEFAULT_OPTIONS, ...options };
        if (inner.healthCheck) {
            this.healthCheck = inner.healthCheck.bind(inner);
        }
    }
    get model() {
        return this.inner.model;
    }
    async chat(messages, tools, options) {
        for (let attempt = 0;; attempt++) {
            if (options?.signal?.aborted) {
                return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
            }
            const result = await this.inner.chat(messages, tools, options);
            if (result.ok ||
                attempt >= this.opts.maxAttempts ||
                !this.isRetryable(result.error)) {
                return result;
            }
            await this.backoff(attempt, options?.signal);
        }
    }
    async *streamChat(messages, tools, options) {
        for (let attempt = 0;; attempt++) {
            if (options?.signal?.aborted) {
                yield { ok: false, error: new LlmError('Aborted', 'ABORTED') };
                return;
            }
            let chunksYielded = 0;
            let shouldRetry = false;
            for await (const chunk of this.inner.streamChat(messages, tools, options)) {
                if (chunk.ok) {
                    chunksYielded++;
                    yield chunk;
                }
                else {
                    const canRetry = attempt < this.opts.maxAttempts;
                    // Pre-stream failure: retry on HTTP status codes (existing behavior)
                    if (chunksYielded === 0 &&
                        canRetry &&
                        this.isRetryable(chunk.error)) {
                        shouldRetry = true;
                        break;
                    }
                    // Mid-stream failure: retry on configured substrings
                    if (chunksYielded > 0 &&
                        canRetry &&
                        this.isMidStreamRetryable(chunk.error)) {
                        yield { ok: true, value: { content: '', reset: true } };
                        shouldRetry = true;
                        break;
                    }
                    yield chunk;
                    return;
                }
            }
            if (!shouldRetry)
                return;
            await this.backoff(attempt, options?.signal);
        }
    }
    isRetryable(error) {
        const msg = error.message;
        return this.opts.retryOn.some((code) => msg.includes(String(code)));
    }
    isMidStreamRetryable(error) {
        if (this.opts.retryOnMidStream.length === 0)
            return false;
        const msg = error.message;
        return this.opts.retryOnMidStream.some((sub) => msg.includes(sub));
    }
    backoff(attempt, signal) {
        const delay = this.opts.backoffMs * 2 ** attempt;
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, delay);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
}
//# sourceMappingURL=retry-llm.js.map