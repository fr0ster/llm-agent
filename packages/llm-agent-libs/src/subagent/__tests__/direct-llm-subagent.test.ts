import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmResponse,
  LlmStreamChunk,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import {
  formatRequestTime,
  REQUEST_TIME_GUIDANCE,
} from '../../context/request-time.js';
import { DirectLlmSubAgent } from '../direct-llm-subagent.js';

class CapturingLlm implements ILlm {
  capturedMessages?: Message[];
  async chat(messages: Message[]): Promise<Result<LlmResponse, LlmError>> {
    this.capturedMessages = messages;
    return {
      ok: true,
      value: {
        content: 'response',
        finishReason: 'stop',
        usage: undefined,
        toolCalls: [],
      },
    };
  }
  async *streamChat(): AsyncIterable<Result<LlmStreamChunk, LlmError>> {}
  async healthCheck(): Promise<Result<boolean, LlmError>> {
    return { ok: true, value: true };
  }
}

describe('DirectLlmSubAgent', () => {
  it('declares capabilities with contextPolicy=required by default', () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: 'You are a code reviewer.',
    });
    assert.equal(sub.capabilities.contextPolicy, 'required');
  });

  it('uses systemPrompt + context + task as messages', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: 'You are a code reviewer.',
    });

    const res = await sub.run({
      task: 'Review this snippet',
      context: 'function foo() { return 42; }',
      sessionId: 'sess-1',
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
    const sub = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: 'sys',
    });

    await assert.rejects(
      () =>
        sub.run({
          task: 'do',
          sessionId: 's',
        }),
      /context.*required/i,
    );
  });

  it('allows missing context when contextPolicy is optional', async () => {
    const llm = new CapturingLlm();
    const sub = new DirectLlmSubAgent('flex', llm, {
      systemPrompt: 'sys',
      contextPolicy: 'optional',
    });

    const res = await sub.run({
      requestStartedAt: 0,
      task: 'do the thing',
      sessionId: 's',
    });

    assert.equal(res.output, 'response');
    assert.equal(llm.capturedMessages?.[1].role, 'user');
    assert.equal(
      llm.capturedMessages?.[1].content,
      `${formatRequestTime(0)}\n\ndo the thing`,
    );
    assert.ok(
      llm.capturedMessages?.[0].content?.includes(REQUEST_TIME_GUIDANCE),
    );
  });
});
