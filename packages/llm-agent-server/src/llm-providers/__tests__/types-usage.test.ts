import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LLMResponse } from '@mcp-abap-adt/llm-agent';

describe('LLMResponse — usage field', () => {
  it('accepts response with usage', () => {
    const resp: LLMResponse = {
      content: 'Hello',
      finishReason: 'stop',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
      },
    };
    assert.equal(resp.usage?.prompt_tokens, 10);
    assert.equal(resp.usage?.completion_tokens, 20);
    assert.equal(resp.usage?.total_tokens, 30);
  });

  it('accepts response without usage', () => {
    const resp: LLMResponse = { content: 'Hello' };
    assert.equal(resp.usage, undefined);
  });
});
