import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, Message, Result } from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../direct-llm-subagent.js';

class CapturingLlm {
  capturedMessages?: Message[];
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  async chat(messages: Message[]): Promise<Result<any, Error>> {
    this.capturedMessages = messages;
    return {
      ok: true,
      value: { content: 'response', usage: undefined, toolCalls: [] },
    };
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock
  async *stream(): AsyncGenerator<any> {}
}

describe('DirectLlmSubAgent', () => {
  it('declares constrained capabilities', () => {
    const llm = new CapturingLlm() as unknown as ILlm;
    const sub = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: 'You are a code reviewer.',
    });
    assert.equal(sub.capabilities.kind, 'constrained');
    assert.equal(sub.capabilities.canDispatchChildren, false);
    assert.equal(sub.capabilities.contextPolicy, 'required');
  });

  it('uses systemPrompt + context + task as messages', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm as unknown as ILlm, {
      systemPrompt: 'You are a code reviewer.',
    });

    const res = await sub.run({
      task: 'Review this snippet',
      context: 'function foo() { return 42; }',
      sessionId: 'sess-1',
      layer: 2,
    });

    assert.equal(res.output, 'response');
    assert.ok(llm.capturedMessages);
    assert.equal(llm.capturedMessages?.length, 2);
    assert.equal(llm.capturedMessages?.[0].role, 'system');
    assert.match(
      String(llm.capturedMessages?.[0].content),
      /You are a code reviewer/,
    );
    assert.equal(llm.capturedMessages?.[1].role, 'user');
    assert.match(
      String(llm.capturedMessages?.[1].content),
      /function foo[\s\S]+Review this snippet/,
    );
  });

  it('errors when context is missing and contextPolicy is required', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm as unknown as ILlm, {
      systemPrompt: 'sys',
    });

    await assert.rejects(
      () =>
        sub.run({
          task: 'do',
          sessionId: 's',
          layer: 1,
        }),
      /context.*required/i,
    );
  });

  it('allows missing context when contextPolicy is optional', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('flex', llm as unknown as ILlm, {
      systemPrompt: 'sys',
      contextPolicy: 'optional',
    });

    const res = await sub.run({
      task: 'do the thing',
      sessionId: 's',
      layer: 1,
    });

    assert.equal(res.output, 'response');
    assert.equal(llm.capturedMessages?.[1].role, 'user');
    assert.equal(llm.capturedMessages?.[1].content, 'do the thing');
  });
});
