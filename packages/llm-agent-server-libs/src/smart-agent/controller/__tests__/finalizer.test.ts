import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LlmFinalizer,
  MIN_BODY_BUDGET,
  orderAndTruncate,
  reduceToBudget,
} from '../finalizer.js';
import type { ISubagentClient } from '../subagent-client.js';

describe('complete finalizer results', () => {
  it('orders complete results and leaves the caller array unchanged', () => {
    const results = [
      { seq: 1, content: 'B'.repeat(200_000) },
      { seq: 0, content: 'A'.repeat(200_000) },
    ];
    assert.deepEqual(orderAndTruncate(results, 3), [results[1], results[0]]);
    assert.equal(results[0].seq, 1);
  });
  it('renders every complete result regardless of legacy budgets', () => {
    const results = Array.from({ length: 200 }, (_, seq) => ({
      seq,
      content: `${seq}:${'x'.repeat(2000)}`,
    }));
    const logs: string[] = [];
    const body = reduceToBudget(results, 3, MIN_BODY_BUDGET, (line) =>
      logs.push(line),
    );
    assert.equal(
      body,
      results
        .map((result) => `[#${result.seq}] ${result.content}`)
        .join('\n\n'),
    );
    assert.deepEqual(logs, []);
  });
});

describe('LlmFinalizer', () => {
  it('composes the answer from approved results', async () => {
    const client: ISubagentClient = {
      async send() {
        return { kind: 'content', content: 'FINAL ANSWER' };
      },
    };
    const f = new LlmFinalizer(client, { budget: 1000, perResultCap: 100 });
    const answer = await f.finalize(
      'goal',
      'request',
      [
        { seq: 0, content: 'A' },
        { seq: 1, content: 'B' },
      ],
      {},
    );
    assert.equal(answer, 'FINAL ANSWER');
  });
  it('passes 200k-character results to the model even with tiny legacy budgets', async () => {
    const content = 'x'.repeat(200_000);
    const client: ISubagentClient = {
      async send(messages) {
        assert.ok(
          messages.some((message) => message.content?.includes(content)),
        );
        return { kind: 'content', content: 'answer' };
      },
    };
    const finalizer = new LlmFinalizer(client, { budget: 5, perResultCap: 3 });
    assert.equal(
      await finalizer.finalize('goal', 'request', [{ seq: 0, content }], {}),
      'answer',
    );
  });
});

describe('LlmFinalizer — skillsBlock directive', () => {
  it('skillsBlock present: user message contains skills block under Skills header; system message contains honor-clause', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const client: ISubagentClient = {
      async send(messages) {
        capturedMessages = messages as Array<{ role: string; content: string }>;
        return { kind: 'content', content: 'ok' };
      },
    };
    const f = new LlmFinalizer(client, { budget: 1000, perResultCap: 100 });
    await f.finalize('g', 'r', [], {
      skillsBlock: 'Relevant skills:\n- always end with LINE-X',
    });
    const systemMsg = capturedMessages.find((m) => m.role === 'system');
    const userMsg = capturedMessages.find((m) => m.role === 'user');
    assert.ok(systemMsg, 'system message present');
    assert.ok(userMsg, 'user message present');
    assert.ok(
      systemMsg.content.toLowerCase().includes('honor') &&
        systemMsg.content.includes('directives'),
      `system message must contain honor-clause; got: ${systemMsg.content}`,
    );
    assert.ok(
      userMsg.content.includes('Skills (delivery directives):'),
      `user message must contain Skills header; got: ${userMsg.content}`,
    );
    assert.ok(
      userMsg.content.includes('always end with LINE-X'),
      `user message must contain skills block text; got: ${userMsg.content}`,
    );
  });

  it('skillsBlock absent: user message byte-equal to Goal/Request/Results format; system message has no honor-clause', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const client: ISubagentClient = {
      async send(messages) {
        capturedMessages = messages as Array<{ role: string; content: string }>;
        return { kind: 'content', content: 'ok' };
      },
    };
    const f = new LlmFinalizer(client, { budget: 1000, perResultCap: 100 });
    await f.finalize('g', 'r', [], {});
    const systemMsg = capturedMessages.find((m) => m.role === 'system');
    const userMsg = capturedMessages.find((m) => m.role === 'user');
    assert.ok(systemMsg, 'system message present');
    assert.ok(userMsg, 'user message present');
    assert.ok(
      !systemMsg.content.toLowerCase().includes('honor') ||
        !systemMsg.content.includes('directives'),
      `system message must NOT contain honor-clause when no skills; got: ${systemMsg.content}`,
    );
    assert.ok(
      !userMsg.content.includes('Skills'),
      `user message must NOT contain Skills section when no skills; got: ${userMsg.content}`,
    );
    assert.equal(
      userMsg.content,
      'Goal: g\nRequest: r\nResults:\n',
      "user message must be byte-equal to today's format",
    );
  });

  it('empty skillsBlock (whitespace only): treated as absent — no skills section, no honor-clause', async () => {
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const client: ISubagentClient = {
      async send(messages) {
        capturedMessages = messages as Array<{ role: string; content: string }>;
        return { kind: 'content', content: 'ok' };
      },
    };
    const f = new LlmFinalizer(client, { budget: 1000, perResultCap: 100 });
    await f.finalize('g', 'r', [], { skillsBlock: '   ' });
    const systemMsg = capturedMessages.find((m) => m.role === 'system');
    const userMsg = capturedMessages.find((m) => m.role === 'user');
    assert.ok(systemMsg, 'system message present');
    assert.ok(userMsg, 'user message present');
    assert.ok(
      !systemMsg.content.toLowerCase().includes('honor') ||
        !systemMsg.content.includes('directives'),
      `system message must NOT contain honor-clause for blank skillsBlock; got: ${systemMsg.content}`,
    );
    assert.ok(
      !userMsg.content.includes('Skills'),
      `user message must NOT contain Skills section for blank skillsBlock; got: ${userMsg.content}`,
    );
    assert.equal(
      userMsg.content,
      'Goal: g\nRequest: r\nResults:\n',
      "user message must be byte-equal to today's format for blank skillsBlock",
    );
  });
});
