// src/smart-agent/__tests__/builder-api-adapters.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SmartAgentResponse } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';
import type {
  ILlmApiAdapter,
  NormalizedRequest,
} from '../interfaces/api-adapter.js';

function makeMockLlm(): ILlmApiAdapter['normalizeRequest'] extends never
  ? never
  : unknown {
  return {
    async chat() {
      return { ok: true as const, value: { content: '', toolCalls: [] } };
    },
    async *streamChat() {},
  };
}

function makeMockAdapter(name: string): ILlmApiAdapter {
  return {
    name,
    normalizeRequest(_req: unknown): NormalizedRequest {
      return {
        messages: [],
        stream: false,
        context: { adapterName: name, protocol: {} },
      };
    },
    async *transformStream() {},
    formatResult(_res: SmartAgentResponse) {
      return {};
    },
  };
}

describe('SmartAgentBuilder — apiAdapters', () => {
  it('registers adapters and exposes them via handle', async () => {
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(
        makeMockLlm() as Parameters<SmartAgentBuilder['withMainLlm']>[0],
      )
      .withApiAdapter(makeMockAdapter('openai'))
      .withApiAdapter(makeMockAdapter('anthropic'))
      .build();

    assert.equal(handle.getApiAdapter('openai')?.name, 'openai');
    assert.equal(handle.getApiAdapter('anthropic')?.name, 'anthropic');
    assert.equal(handle.getApiAdapter('unknown'), undefined);
    assert.deepEqual(handle.listApiAdapters().sort(), ['anthropic', 'openai']);
    await handle.close();
  });

  it('later adapter with same name wins', async () => {
    const first = makeMockAdapter('openai');
    const second = makeMockAdapter('openai');
    const handle = await new SmartAgentBuilder({})
      .withMainLlm(
        makeMockLlm() as Parameters<SmartAgentBuilder['withMainLlm']>[0],
      )
      .withApiAdapter(first)
      .withApiAdapter(second)
      .build();

    assert.equal(handle.getApiAdapter('openai'), second);
    await handle.close();
  });
});
