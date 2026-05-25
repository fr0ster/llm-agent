import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ILlm,
  PlanStep,
} from '@mcp-abap-adt/llm-agent';
import { SelfDispatch } from '../self.js';

describe('SelfDispatch task composition', () => {
  it('passes the composed task (with material + objective) into the user message', async () => {
    const captured: { messages?: Array<{ role: string; content: unknown }> } =
      {};
    const llm = {
      chat: async (messages: Array<{ role: string; content: unknown }>) => {
        captured.messages = messages;
        return { ok: true, value: { content: 'done' } };
      },
    } as unknown as ILlm;

    const ctx = {
      inputText: 'RELEASE-TASKS-BLOB',
      registry: new Map(),
      stepResults: {},
      sessionId: 't',
      plan: {
        steps: [],
        objective: 'Ship the release',
        createdAt: 0,
        source: 'planner-llm',
      },
    } as unknown as ICoordinatorContext;

    const step: PlanStep = {
      id: 's1',
      goal: 'Summarize',
      needsInput: true,
      status: 'pending',
    };

    const res = await new SelfDispatch(llm).dispatch(step, ctx);
    assert.equal(res.ok, true);
    const userMsg = captured.messages?.find((m) => m.role === 'user');
    assert.match(String(userMsg?.content ?? ''), /RELEASE-TASKS-BLOB/);
    assert.match(
      String(userMsg?.content ?? ''),
      /Overall objective: Ship the release/,
    );
  });
});
