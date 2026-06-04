import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm, PlannerInput } from '@mcp-abap-adt/llm-agent';
import { LlmDagPlanner, parseDagPlan } from '../llm-dag-planner.js';

function llm(content: string): ILlm {
  return {
    chat: async () => ({ ok: true, value: { content } }),
  } as unknown as ILlm;
}

describe('LlmDagPlanner — bare external-tool requests (#171 obs 2c)', () => {
  // A request that is purely "call external tool X with args Y" cannot be
  // decomposed into an internal MCP action, so the planner LLM may return an
  // empty node list. Without a fallback node, the DAG runs no worker and the
  // request returns `(no response)`. The planner must instead emit at least
  // one node so a worker runs, the worker LLM emits the external tool_call,
  // and the #171 machinery surfaces it.
  const externalInput: PlannerInput = {
    prompt: 'call rag_add with collection=context and content=X',
    agents: [{ name: 'w', description: 'general worker' }],
    sessionId: 't',
  };

  it('emits at least one node when the LLM returns an empty plan', async () => {
    // LLM decided it has nothing to decompose → empty nodes.
    const p = await new LlmDagPlanner(llm('{"nodes":[]}')).plan(externalInput);
    assert.ok(
      p.plan.nodes.length >= 1,
      'expected a fallback node so a worker runs',
    );
    // The fallback node must carry the user objective so the worker can emit
    // the external call.
    assert.match(p.plan.nodes[0].goal, /rag_add/);
  });

  it('still emits a node when the LLM omits the nodes field entirely', async () => {
    const p = await new LlmDagPlanner(llm('{"objective":"O"}')).plan(
      externalInput,
    );
    assert.ok(p.plan.nodes.length >= 1);
  });

  it('parseDagPlan still throws on empty nodes when no fallbackGoal is given', () => {
    // Backwards-compat: the shared parser (used by the Stepper planner) must
    // keep its strict no-nodes error when no fallback objective is supplied.
    assert.throws(
      () => parseDagPlan('{"nodes":[]}'),
      /Planner returned no nodes/,
    );
  });
});
