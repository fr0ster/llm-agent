import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ICoordinatorContext,
  ILlm,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';
import { SelfDispatch } from '../self.js';

function step(id: string, goal: string): PlanStep {
  return { id, goal, status: 'pending' };
}

function result(
  stepId: string,
  output: string,
  ok: boolean,
  error?: string,
): StepResult {
  return { stepId, output, durationMs: 1, ok, error };
}

class CapturingLlm {
  capturedUser?: string;
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock for test
  async chat(messages: Array<{ role: string; content: string }>): Promise<any> {
    this.capturedUser = messages.find((m) => m.role === 'user')?.content;
    return { ok: true, value: { content: 'fake' } };
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal mock for test
  async *stream(): AsyncGenerator<any> {}
}

describe('SelfDispatch briefing', () => {
  it('includes a Tried section in the user message when prior steps failed', async () => {
    const llm = new CapturingLlm();
    const s1 = step('s1', 'Grep src/');
    const s2 = step('s2', 'Try another way');
    const ctx: ICoordinatorContext = {
      inputText: 'find symbol',
      registry: new Map(),
      stepResults: { s1: result('s1', '', false, 'no matches') },
      sessionId: 'sess-1',
      plan: { steps: [s1, s2], createdAt: 0, source: 'manual' },
    } as unknown as ICoordinatorContext;

    await new SelfDispatch(llm as unknown as ILlm).dispatch(s2, ctx);

    const u = llm.capturedUser ?? '';
    assert.ok(
      u.includes('Already tried'),
      'user message must surface dead-ends',
    );
    assert.ok(u.includes('s1 (Grep src/) — failed: no matches'));
    assert.ok(u.includes('Task: Try another way'));
  });

  it('includes Known section for successful prior steps', async () => {
    const llm = new CapturingLlm();
    const s1 = step('s1', 'Locate file');
    const s2 = step('s2', 'Read it');
    const ctx: ICoordinatorContext = {
      inputText: 'top',
      registry: new Map(),
      stepResults: { s1: result('s1', 'Found src/x.ts', true) },
      sessionId: 'sess-1',
      plan: { steps: [s1, s2], createdAt: 0, source: 'manual' },
    } as unknown as ICoordinatorContext;

    await new SelfDispatch(llm as unknown as ILlm).dispatch(s2, ctx);

    const u = llm.capturedUser ?? '';
    assert.ok(u.includes('Known so far'));
    assert.ok(u.includes('s1 (Locate file): Found src/x.ts'));
  });
});
