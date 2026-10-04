import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  CircuitBreakerLlm,
  type ILlm,
} from '@mcp-abap-adt/llm-agent';

interface BreakerEntry {
  inner: ILlm;
  wrapper: ILlm;
  breaker: CircuitBreaker;
}

/**
 * One circuit breaker per `llm:` entry key (spec §14.2), shared by every
 * session and every role that resolves that key. Wrappers are cached BY KEY,
 * not by instance: one object under two keys gets two breakers, and a key
 * whose instance changes (a `PUT /v1/config` swap — also back to an instance
 * used before) gets a fresh breaker. An LLM that already is a
 * `CircuitBreakerLlm` (the consumer's own) is not wrapped again; its breaker
 * takes the key's place, so `list()` reports the breaker that guards the key.
 */
export class LlmCircuitBreakers {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly config: CircuitBreakerConfig,
    private readonly onStateChange?: (
      key: string,
      from: string,
      to: string,
    ) => void,
  ) {}

  /** The instance that guards `key` when `llm` is the key's LLM. */
  wrap(llm: ILlm, key: string): ILlm {
    const current = this.entries.get(key);
    if (current && (llm === current.inner || llm === current.wrapper)) {
      return current.wrapper;
    }
    if (llm instanceof CircuitBreakerLlm) {
      this.entries.set(key, { inner: llm, wrapper: llm, breaker: llm.breaker });
      return llm;
    }
    const report = this.onStateChange;
    const breaker = new CircuitBreaker({
      ...this.config,
      ...(report ? { onStateChange: (from, to) => report(key, from, to) } : {}),
    });
    const wrapper = new CircuitBreakerLlm(llm, breaker);
    this.entries.set(key, { inner: llm, wrapper, breaker });
    return wrapper;
  }

  /** The current breaker of every key, in the order the keys were first seen. */
  list(): readonly CircuitBreaker[] {
    return [...this.entries.values()].map((e) => e.breaker);
  }
}
