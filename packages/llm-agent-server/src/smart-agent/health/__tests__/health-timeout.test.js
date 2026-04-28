import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../../agent.js';
import { makeDefaultDeps } from '../../testing/index.js';
function makeSlowLlm(delayMs) {
    return {
        async chat() {
            await new Promise((r) => setTimeout(r, delayMs));
            return { ok: true, value: { content: 'pong', finishReason: 'stop' } };
        },
        async *streamChat() {
            yield { ok: true, value: { content: 'pong', finishReason: 'stop' } };
        },
        async healthCheck(options) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, delayMs);
                options?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
            return { ok: true, value: true };
        },
    };
}
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
        const abortAwareLlm = {
            async chat(_msgs, _tools, opts) {
                if (opts?.signal?.aborted) {
                    return { ok: false, error: new LlmError('Aborted', 'ABORTED') };
                }
                return {
                    ok: true,
                    value: { content: 'ok', finishReason: 'stop' },
                };
            },
            async *streamChat() {
                yield {
                    ok: true,
                    value: { content: 'ok', finishReason: 'stop' },
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
describe('SmartAgent.healthCheck — slow provider simulation', () => {
    it('times out with default 5000ms when provider takes 6s', async () => {
        const { deps } = makeDefaultDeps();
        deps.mainLlm = makeSlowLlm(6_000);
        const agent = new SmartAgent(deps, { maxIterations: 5 });
        const result = await agent.healthCheck();
        assert.ok(result.ok);
        assert.equal(result.value.llm, false); // timed out
    });
    it('succeeds with healthTimeoutMs: 15000 when provider takes 6s', async () => {
        const { deps } = makeDefaultDeps();
        deps.mainLlm = makeSlowLlm(6_000);
        const agent = new SmartAgent(deps, {
            maxIterations: 5,
            healthTimeoutMs: 15_000,
        });
        const result = await agent.healthCheck();
        assert.ok(result.ok);
        assert.equal(result.value.llm, true); // completed within timeout
    });
});
//# sourceMappingURL=health-timeout.test.js.map