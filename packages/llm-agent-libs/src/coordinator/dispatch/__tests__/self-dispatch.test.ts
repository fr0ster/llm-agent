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

describe('SelfDispatch #157 tool-loop', () => {
  const step: PlanStep = {
    id: 's1',
    goal: 'Read table T000',
    status: 'pending',
  };

  it('runs a tool-loop: calls the tool, feeds the result back, returns the final answer', async () => {
    const toolArgsSeen: unknown[] = [];
    let turn = 0;
    const llm = {
      chat: async (_messages: unknown, tools: Array<{ name: string }>) => {
        turn++;
        if (turn === 1) {
          // first turn: the model requests the tool (tools were offered)
          assert.ok(
            tools.some((t) => t.name === 'GetTableContents'),
            'selected tools must be offered to the model',
          );
          return {
            ok: true as const,
            value: {
              content: '',
              toolCalls: [
                {
                  id: 'c1',
                  name: 'GetTableContents',
                  arguments: { table: 'T000' },
                },
              ],
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            },
          };
        }
        // second turn: answer from the observed tool result
        return {
          ok: true as const,
          value: {
            content: 'T000 has 3 clients.',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          },
        };
      },
    } as unknown as ILlm;

    let called = '';
    const ctx = {
      inputText: 'read T000',
      registry: new Map(),
      stepResults: {},
      sessionId: 't',
      selectedTools: [{ name: 'GetTableContents' }],
      callTool: async (name: string, args: unknown) => {
        called = name;
        toolArgsSeen.push(args);
        return 'MANDT=000;100;200';
      },
    } as unknown as ICoordinatorContext;

    const res = await new SelfDispatch(llm).dispatch(step, ctx);
    assert.equal(res.ok, true);
    assert.equal(called, 'GetTableContents', 'the MCP tool must be invoked');
    assert.deepEqual(toolArgsSeen[0], { table: 'T000' });
    assert.equal(res.output, 'T000 has 3 clients.');
    // usage accumulated across both turns (2 + 2)
    assert.equal(res.usage?.totalTokens, 4);
  });

  it('falls back to a single toolless chat when no tools/executor are present', async () => {
    let calls = 0;
    const llm = {
      chat: async (_m: unknown, tools: unknown[]) => {
        calls++;
        assert.deepEqual(tools, [], 'legacy path offers no tools');
        return { ok: true as const, value: { content: 'plain answer' } };
      },
    } as unknown as ILlm;
    const ctx = {
      inputText: 'x',
      registry: new Map(),
      stepResults: {},
      sessionId: 't',
    } as unknown as ICoordinatorContext;
    const res = await new SelfDispatch(llm).dispatch(step, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.output, 'plain answer');
    assert.equal(calls, 1, 'exactly one toolless chat');
  });
});
