import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IRag,
  LlmError,
} from '@mcp-abap-adt/llm-agent';
import { buildAgentHealthSnapshot } from '../agent-health.js';

function makeLogCapture() {
  const calls: { name: string; data: unknown }[] = [];
  const sessionLogger = {
    logStep(name: string, data: unknown) {
      calls.push({ name, data });
    },
  };
  return { calls, sessionLogger };
}

function makeLlmWithThrow(msg: string): ILlm {
  return {
    async chat() {
      throw new Error(msg);
    },
    async healthCheck() {
      throw new Error(msg);
    },
  } as unknown as ILlm;
}

function makeLlmWithNotOk(errorMsg: string): ILlm {
  return {
    async chat() {
      return { ok: false as const, error: { message: errorMsg } as LlmError };
    },
    async healthCheck() {
      return { ok: false as const, error: { message: errorMsg } as LlmError };
    },
  } as unknown as ILlm;
}

function makeLlmHealthy(): ILlm {
  return {
    async chat() {
      return { ok: true as const, value: {} };
    },
    async healthCheck() {
      return { ok: true as const, value: true };
    },
  } as unknown as ILlm;
}

const emptyRagStores: Record<string, IRag> = {};

describe('buildAgentHealthSnapshot — LLM probe logging', () => {
  it('logs health_llm_probe_error when healthCheck throws', async () => {
    const { calls, sessionLogger } = makeLogCapture();
    const options = { sessionLogger } as unknown as CallOptions;
    const snapshot = await buildAgentHealthSnapshot(
      makeLlmWithThrow('connection refused'),
      emptyRagStores,
      [],
      options,
    );

    assert.equal(snapshot.llm, false, 'results.llm should be false');
    assert.equal(calls.length, 1, 'logStep should be called once');
    assert.equal(calls[0].name, 'health_llm_probe_error');
    assert.deepEqual(calls[0].data, { reason: 'connection refused' });
  });

  it('logs health_llm_probe_error when healthCheck returns ok:false', async () => {
    const { calls, sessionLogger } = makeLogCapture();
    const options = { sessionLogger } as unknown as CallOptions;
    const snapshot = await buildAgentHealthSnapshot(
      makeLlmWithNotOk('service unavailable'),
      emptyRagStores,
      [],
      options,
    );

    assert.equal(snapshot.llm, false, 'results.llm should be false');
    assert.equal(calls.length, 1, 'logStep should be called once');
    assert.equal(calls[0].name, 'health_llm_probe_error');
    assert.deepEqual(calls[0].data, { reason: 'service unavailable' });
  });

  it('does NOT log when healthCheck returns ok:true', async () => {
    const { calls, sessionLogger } = makeLogCapture();
    const options = { sessionLogger } as unknown as CallOptions;
    const snapshot = await buildAgentHealthSnapshot(
      makeLlmHealthy(),
      emptyRagStores,
      [],
      options,
    );

    assert.equal(snapshot.llm, true, 'results.llm should be true');
    assert.equal(
      calls.length,
      0,
      'logStep should NOT be called for healthy LLM',
    );
  });
});
