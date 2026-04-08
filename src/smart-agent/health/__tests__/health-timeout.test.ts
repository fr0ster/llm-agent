import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../../agent.js';
import type { ILlm } from '../../interfaces/llm.js';
import { LlmError } from '../../interfaces/types.js';
import { makeDefaultDeps } from '../../testing/index.js';

describe('SmartAgent.healthCheck — configurable timeout', () => {
  it('uses default 5000ms when healthTimeoutMs is not set', async () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });
    const result = await agent.healthCheck();
    assert.ok(result.ok);
    assert.ok(result.value.llm);
  });

  it('uses custom healthTimeoutMs from config', async () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, {
      maxIterations: 5,
      healthTimeoutMs: 15_000,
    });
    const result = await agent.healthCheck();
    assert.ok(result.ok);
    assert.ok(result.value.llm);
  });

  it('respects an incoming caller AbortSignal', async () => {
    // Create an ILlm that honours the abort signal in healthCheck
    const abortAwareLlm: ILlm = {
      async chat(_msgs, _tools, opts) {
        if (opts?.signal?.aborted) {
          return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
        }
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
      async healthCheck(opts) {
        if (opts?.signal?.aborted) {
          return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
        }
        return { ok: true, value: true };
      },
    };

    const { deps } = makeDefaultDeps();
    deps.mainLlm = abortAwareLlm;
    const agent = new SmartAgent(deps, { maxIterations: 5 });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await agent.healthCheck({ signal: ctrl.signal });
    assert.ok(result.ok);
    // LLM probe should fail because the signal is already aborted
    assert.equal(result.value.llm, false);
  });
});
