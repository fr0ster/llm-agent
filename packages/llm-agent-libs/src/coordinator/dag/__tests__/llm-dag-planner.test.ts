import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, PlannerInput } from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { LlmDagPlanner } from '../llm-dag-planner.js';

function llm(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}
const input: PlannerInput = {
  prompt: 'Do X then Y',
  agents: [{ name: 'w', description: 'worker' }],
  sessionId: 't',
};

describe('LlmDagPlanner', () => {
  it('parses a DAG with dependsOn', async () => {
    const p = await new LlmDagPlanner(
      llm(
        '{"objective":"O","nodes":[{"id":"a","goal":"X","agent":"w"},{"id":"b","goal":"Y","agent":"w","dependsOn":["a"]}]}',
      ),
    ).plan(input);
    assert.equal(p.plan.objective, 'O');
    assert.equal(p.plan.nodes.length, 2);
    assert.deepEqual(p.plan.nodes[1].dependsOn, ['a']);
  });

  it('accepts a single-node plan (progressive complexity)', async () => {
    const p = await new LlmDagPlanner(
      llm('{"nodes":[{"id":"n1","goal":"answer"}]}'),
    ).plan(input);
    assert.equal(p.plan.nodes.length, 1);
  });

  it('throws on malformed JSON', async () => {
    await assert.rejects(
      () => new LlmDagPlanner(llm('not json')).plan(input),
      /JSON/i,
    );
  });

  it('throws when a node is missing a goal', async () => {
    await assert.rejects(
      () => new LlmDagPlanner(llm('{"nodes":[{"id":"a"}]}')).plan(input),
      /missing a goal/,
    );
  });

  it('throws on a non-string node id', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(llm('{"nodes":[{"id":1,"goal":"X"}]}')).plan(input),
      /non-string id/,
    );
  });

  it('throws on a non-string node agent', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(
          llm('{"nodes":[{"id":"a","goal":"X","agent":5}]}'),
        ).plan(input),
      /non-string agent/,
    );
  });

  it('throws on a dependsOn that is not an array of strings', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(
          llm('{"nodes":[{"id":"a","goal":"X","dependsOn":[1]}]}'),
        ).plan(input),
      /dependsOn must be an array of strings/,
    );
  });

  it('throws on a non-boolean needsInput', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(
          llm('{"nodes":[{"id":"a","goal":"X","needsInput":"yes"}]}'),
        ).plan(input),
      /needsInput must be a boolean/,
    );
  });

  it('throws on a non-string objective', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(
          llm('{"objective":42,"nodes":[{"id":"a","goal":"X"}]}'),
        ).plan(input),
      /objective must be a string/,
    );
  });

  it('throws on a non-string rationale', async () => {
    await assert.rejects(
      () =>
        new LlmDagPlanner(
          llm('{"rationale":{},"nodes":[{"id":"a","goal":"X"}]}'),
        ).plan(input),
      /rationale must be a string/,
    );
  });

  it('throws the LLM error when the call is not ok', async () => {
    const failing = {
      chat: async () => ({ ok: false, error: new Error('quota') }),
    } as unknown as ILlm;
    await assert.rejects(() => new LlmDagPlanner(failing).plan(input), /quota/);
  });

  it('throws NeedInfoSignal when the planner asks for a reality fact', async () => {
    await assert.rejects(
      () => new LlmDagPlanner(llm('{"needInfo":"which table?"}')).plan(input),
      (e: unknown) => e instanceof NeedInfoSignal && e.query === 'which table?',
    );
  });

  it('throws ClarifySignal when the planner needs a human decision', async () => {
    await assert.rejects(
      () => new LlmDagPlanner(llm('{"clarify":"overwrite ok?"}')).plan(input),
      (e: unknown) =>
        e instanceof ClarifySignal && e.question === 'overwrite ok?',
    );
  });

  it('attaches LLM usage onto NeedInfoSignal so signal-path spend is not lost', async () => {
    const usage = { promptTokens: 7, completionTokens: 3, totalTokens: 10 };
    const stub = {
      chat: async () => ({
        ok: true,
        value: { content: '{"needInfo":"which table?"}', usage },
      }),
    } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
    await assert.rejects(
      () => new LlmDagPlanner(stub).plan(input),
      (e: unknown) =>
        e instanceof NeedInfoSignal &&
        e.usage?.promptTokens === 7 &&
        e.usage?.completionTokens === 3 &&
        e.usage?.totalTokens === 10,
    );
  });

  it('attaches LLM usage onto ClarifySignal so signal-path spend is not lost', async () => {
    const usage = { promptTokens: 5, completionTokens: 2, totalTokens: 7 };
    const stub = {
      chat: async () => ({
        ok: true,
        value: { content: '{"clarify":"overwrite ok?"}', usage },
      }),
    } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
    await assert.rejects(
      () => new LlmDagPlanner(stub).plan(input),
      (e: unknown) => e instanceof ClarifySignal && e.usage?.totalTokens === 7,
    );
  });

  it('renders ancestorContext clarifications + reviewerFeedback into the task', async () => {
    const cap: { task?: string } = {};
    const spy = {
      chat: async (msgs: Array<{ role: string; content: string }>) => {
        cap.task = msgs.map((m) => m.content).join('\n');
        return {
          ok: true,
          value: { content: '{"nodes":[{"id":"n1","goal":"g"}]}' },
        };
      },
    } as unknown as import('@mcp-abap-adt/llm-agent').ILlm;
    await new LlmDagPlanner(spy).plan({
      ...input,
      reviewerFeedback: 'avoid table X',
      ancestorContext: {
        objective: 'build BO',
        clarifications: [{ question: 'which table?', answer: 'ZCUST' }],
        oracleObservations: [],
      },
    });
    assert.match(cap.task ?? '', /which table\?/);
    assert.match(cap.task ?? '', /ZCUST/);
    assert.match(cap.task ?? '', /avoid table X/);
  });
});
