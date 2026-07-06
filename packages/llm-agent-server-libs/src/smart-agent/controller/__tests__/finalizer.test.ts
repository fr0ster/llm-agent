import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LlmFinalizer,
  MIN_BODY_BUDGET,
  orderAndTruncate,
  reduceToBudget,
} from '../finalizer.js';
import type { ISubagentClient } from '../subagent-client.js';

describe('orderAndTruncate', () => {
  it('orders by seq and caps each result to C chars with a marker', () => {
    const out = orderAndTruncate(
      [
        { seq: 1, content: 'BBBBB' },
        { seq: 0, content: 'AAAAA' },
      ],
      3,
    );
    assert.equal(out[0].seq, 0);
    assert.equal(out[0].content, 'AAA…[truncated]');
    assert.equal(out[1].seq, 1);
  });
});

describe('reduceToBudget', () => {
  it('within budget AND explicitly counts what it cannot inline (no silent drop)', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      seq: i,
      content: 'x'.repeat(100),
    }));
    const budget = 500;
    const body = reduceToBudget(many, 1000, budget);
    assert.ok(body.length <= budget, `body ${body.length} <= budget ${budget}`);
    assert.ok(
      /more of 200/.test(body),
      'manifest explicitly counts omitted ids',
    );
  });
  it('keeps a compact extract of EVERY result for a feasible budget (none dropped)', () => {
    const logs: string[] = [];
    const body = reduceToBudget(
      [
        { seq: 0, content: 'A'.repeat(5000) },
        { seq: 1, content: 'B'.repeat(5000) },
        { seq: 2, content: 'C'.repeat(5000) },
      ],
      1000,
      900,
      (m) => logs.push(m),
    );
    assert.ok(body.length <= 900);
    assert.ok(
      body.includes('[#0]') && body.includes('[#1]') && body.includes('[#2]'),
      'all three results kept a compact extract',
    );
    assert.ok(
      logs.length > 0 && /overflow/.test(logs.join(' ')),
      'reductions logged',
    );
  });
  it('never exceeds the configured budget (no clamp-up) and still counts omissions', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      seq: i,
      content: 'X'.repeat(1000),
    }));
    const body = reduceToBudget(many, 1000, MIN_BODY_BUDGET);
    assert.ok(
      body.length <= MIN_BODY_BUDGET,
      `body ${body.length} <= configured ${MIN_BODY_BUDGET}`,
    );
    assert.ok(/more of 50/.test(body), 'explicit omitted count present');
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
  it('throws when constructed with a budget below MIN_BODY_BUDGET', () => {
    const client: ISubagentClient = {
      async send() {
        return { kind: 'content', content: 'x' };
      },
    };
    assert.throws(
      () => new LlmFinalizer(client, { budget: 5, perResultCap: 100 }),
      /MIN_BODY_BUDGET/,
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
