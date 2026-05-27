import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ISubAgent,
  PlanStep,
  RagResult,
  SubAgentContextRequest,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultSubAgentContextBuilder,
  type SubAgentRetrievalSource,
} from '../default-context-builder.js';

function makeSource(results: RagResult[]): SubAgentRetrievalSource {
  return async (_text, _k, _signal) => results;
}

function makeAgent(): ISubAgent {
  return {
    name: 'worker',
    capabilities: {
      contextPolicy: 'required',
    },
    async run() {
      return { output: 'ok' };
    },
  };
}

function makeReq(
  overrides: Partial<SubAgentContextRequest> = {},
): SubAgentContextRequest {
  const step: PlanStep = { id: 's1', goal: 'do the thing', status: 'pending' };
  return {
    task: 'do the thing',
    step,
    agent: makeAgent(),
    layer: 1,
    inputText: 'user request',
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('DefaultSubAgentContextBuilder', () => {
  it('returns empty context and empty sources when no sources are configured', async () => {
    const builder = new DefaultSubAgentContextBuilder({});
    const res = await builder.build(makeReq());
    assert.equal(res.context, '');
    assert.deepEqual(res.sources, []);
  });

  it('includes project source snippets when projectSource is provided', async () => {
    const builder = new DefaultSubAgentContextBuilder({
      projectSource: makeSource([
        {
          text: 'TokenManager handles JWT refresh',
          score: 0.9,
          metadata: { path: 'src/auth/token.ts' },
        } as RagResult,
      ]),
    });
    const res = await builder.build(makeReq());
    assert.match(res.context, /TokenManager handles JWT refresh/);
    assert.deepEqual(res.sources, [{ kind: 'rag', ref: 'src/auth/token.ts' }]);
  });

  it('includes tool source snippets after project source', async () => {
    const builder = new DefaultSubAgentContextBuilder({
      projectSource: makeSource([
        {
          text: 'project fact',
          score: 0.9,
          metadata: { path: 'a.ts' },
        } as RagResult,
      ]),
      toolSource: makeSource([
        {
          text: 'get_artifact(name) → string',
          score: 0.8,
          metadata: { tool: 'get_artifact' },
        } as RagResult,
      ]),
    });
    const res = await builder.build(makeReq());
    assert.match(res.context, /project fact[\s\S]+get_artifact/);
    assert.deepEqual(res.sources, [
      { kind: 'rag', ref: 'a.ts' },
      { kind: 'tool-rag', ref: 'get_artifact' },
    ]);
  });

  it('bounds context by maxContextChars', async () => {
    const longContent = 'x'.repeat(2000);
    const builder = new DefaultSubAgentContextBuilder({
      projectSource: makeSource([
        {
          text: longContent,
          score: 0.9,
          metadata: { path: 'big.ts' },
        } as RagResult,
      ]),
      maxContextChars: 500,
    });
    const res = await builder.build(makeReq());
    assert.ok(res.context.length <= 500 + 32);
  });

  it('skips retrieval calls when the agent has contextPolicy=forbidden', async () => {
    const agent: ISubAgent = {
      ...makeAgent(),
      capabilities: {
        contextPolicy: 'forbidden',
      },
    };
    const builder = new DefaultSubAgentContextBuilder({
      projectSource: makeSource([
        {
          text: 'should not appear',
          score: 0.9,
          metadata: { path: 'x.ts' },
        } as RagResult,
      ]),
    });
    const res = await builder.build(makeReq({ agent }));
    assert.equal(res.context, '');
    assert.deepEqual(res.sources, []);
  });
});
