import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import { CircuitBreaker, CircuitBreakerLlm } from '@mcp-abap-adt/llm-agent';
import { NonStreamingLlm } from '../../adapters/non-streaming-llm.js';
import { makeLlm } from '../../testing/index.js';
import { RateLimiterLlm } from '../rate-limiter-llm.js';
import { RetryLlm } from '../retry-llm.js';

/** Minimal ILlm stub WITHOUT healthCheck. */
function makeLlmWithoutHealthCheck(): ILlm {
  return {
    async chat() {
      return {
        ok: true,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
    async *streamChat() {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

/** Minimal rate limiter stub. */
const noopLimiter = { acquire: async () => {} };

describe('ILlm decorator healthCheck proxying', () => {
  const decorators = [
    {
      name: 'NonStreamingLlm',
      wrap: (inner: ILlm) => new NonStreamingLlm(inner),
    },
    {
      name: 'RetryLlm',
      wrap: (inner: ILlm) => new RetryLlm(inner),
    },
    {
      name: 'CircuitBreakerLlm',
      wrap: (inner: ILlm) => new CircuitBreakerLlm(inner, new CircuitBreaker()),
    },
    {
      name: 'RateLimiterLlm',
      wrap: (inner: ILlm) => new RateLimiterLlm(inner, noopLimiter),
    },
  ];

  for (const { name, wrap } of decorators) {
    it(`${name} forwards healthCheck when inner implements it`, async () => {
      const inner = makeLlm([{ content: 'ok' }]);
      const decorated = wrap(inner);
      assert.ok(decorated.healthCheck, `${name} should expose healthCheck`);
      const result = await decorated.healthCheck?.();
      assert.ok(result.ok);
      assert.equal(result.value, true);
    });

    it(`${name} omits healthCheck when inner does not implement it`, () => {
      const inner = makeLlmWithoutHealthCheck();
      const decorated = wrap(inner);
      assert.equal(
        decorated.healthCheck,
        undefined,
        `${name} should not expose healthCheck`,
      );
    });
  }
});
