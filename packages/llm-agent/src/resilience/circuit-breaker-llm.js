/**
 * CircuitBreakerLlm — ILlm decorator that wraps calls with a CircuitBreaker.
 *
 * When the circuit is open, calls return `Result { ok: false, error: LlmError('CIRCUIT_OPEN') }`
 * without hitting the underlying LLM.
 */
import { LlmError } from '@mcp-abap-adt/llm-agent';
export class CircuitBreakerLlm {
  inner;
  breaker;
  healthCheck;
  constructor(inner, breaker) {
    this.inner = inner;
    this.breaker = breaker;
    if (inner.healthCheck) {
      this.healthCheck = inner.healthCheck.bind(inner);
    }
  }
  get model() {
    return this.inner.model;
  }
  async chat(messages, tools, options) {
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
  async *streamChat(messages, tools, options) {
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
//# sourceMappingURL=circuit-breaker-llm.js.map
