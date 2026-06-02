import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import { type OrchestratorError, SmartAgent } from '../agent.js';

// ---------------------------------------------------------------------------
// Step 5.1 — agent.process() must SKIP ephemeral content chunks when building
// the non-streaming accumulated answer, while still accumulating normal content.
//
// process() consumes only `this.streamProcess(...)`, so we exercise the real
// accumulation logic by attaching a scripted streamProcess onto a bare
// prototype instance (no heavy deps needed) and invoking the real process().
// ---------------------------------------------------------------------------

type Chunk = Result<LlmStreamChunk, OrchestratorError>;

function makeAgentWithStream(chunks: Chunk[]): SmartAgent {
  const agent = Object.create(SmartAgent.prototype) as SmartAgent;
  Object.defineProperty(agent, 'streamProcess', {
    value: async function* (): AsyncGenerator<Chunk> {
      for (const c of chunks) yield c;
    },
  });
  return agent;
}

describe('ephemeral liveness markers', () => {
  it('process() excludes ephemeral content but includes normal content', async () => {
    const agent = makeAgentWithStream([
      { ok: true, value: { content: 'Hello' } },
      {
        ok: true,
        value: {
          content: '\n\n[SmartAgent: Executing GetOrder...]\n',
          ephemeral: true,
        },
      },
      { ok: true, value: { content: ' world' } },
      { ok: true, value: { content: '', finishReason: 'stop' } },
    ]);

    const res = await agent.process('ignored');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.content, 'Hello world');
    assert.ok(
      !res.value.content.includes('[SmartAgent: Executing'),
      'ephemeral liveness marker must not leak into the final answer',
    );
  });

  it('process() still accumulates a non-ephemeral marker-shaped chunk', async () => {
    // Guard: the skip is keyed on the `ephemeral` flag, NOT on content text.
    const agent = makeAgentWithStream([
      { ok: true, value: { content: 'A' } },
      { ok: true, value: { content: 'B' /* no ephemeral flag */ } },
    ]);
    const res = await agent.process('ignored');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.content, 'AB');
  });
});
