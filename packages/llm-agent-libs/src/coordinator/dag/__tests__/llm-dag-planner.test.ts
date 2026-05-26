import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, PlannerInput } from '@mcp-abap-adt/llm-agent';
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
    assert.equal(p.objective, 'O');
    assert.equal(p.nodes.length, 2);
    assert.deepEqual(p.nodes[1].dependsOn, ['a']);
  });

  it('accepts a single-node plan (progressive complexity)', async () => {
    const p = await new LlmDagPlanner(
      llm('{"nodes":[{"id":"n1","goal":"answer"}]}'),
    ).plan(input);
    assert.equal(p.nodes.length, 1);
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

  it('throws the LLM error when the call is not ok', async () => {
    const failing = {
      chat: async () => ({ ok: false, error: new Error('quota') }),
    } as unknown as ILlm;
    await assert.rejects(() => new LlmDagPlanner(failing).plan(input), /quota/);
  });
});
