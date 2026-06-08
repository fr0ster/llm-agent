import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  LlmError,
  LlmStreamChunk,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SessionRequestLogger } from '../logger/session-request-logger.js';
import { makeDefaultDeps } from '../testing/index.js';

function streamingLlm(chunks: Array<Result<LlmStreamChunk, LlmError>>): ILlm {
  return {
    model: 'pass-model',
    async chat() {
      return { ok: true, value: { content: '', finishReason: 'stop' } };
    },
    async *streamChat() {
      for (const c of chunks) yield c;
    },
  };
}

async function collect(agent: SmartAgent): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of agent.streamProcess('hi')) {
    if (c.ok) out.push(c.value);
  }
  return out;
}

test('pass success yields exactly one usage-bearing chunk; forwarded chunks carry none', async () => {
  const { deps } = makeDefaultDeps();
  deps.requestLogger = new SessionRequestLogger();
  deps.mainLlm = streamingLlm([
    { ok: true, value: { content: 'a' } },
    {
      ok: true,
      value: {
        content: 'b',
        finishReason: 'stop',
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      },
    },
  ]);
  const agent = new SmartAgent(deps, { mode: 'pass' });
  const chunks = await collect(agent);
  const withUsage = chunks.filter((c) => c.usage);
  assert.equal(withUsage.length, 1, 'exactly one usage-bearing chunk');
  assert.equal(withUsage[0].totalTokens ?? withUsage[0].usage?.totalTokens, 8);
  // The forwarded content chunk 'b' must NOT carry usage.
  const bChunk = chunks.find((c) => c.content === 'b');
  assert.ok(bChunk);
  assert.equal(bChunk.usage, undefined);
});

test('pass error yields no trailing success usage chunk', async () => {
  const { deps } = makeDefaultDeps();
  deps.requestLogger = new SessionRequestLogger();
  deps.mainLlm = streamingLlm([
    {
      ok: true,
      value: {
        content: 'a',
        usage: { promptTokens: 4, completionTokens: 0, totalTokens: 4 },
      },
    },
    { ok: false, error: { message: 'boom' } as LlmError },
  ]);
  const agent = new SmartAgent(deps, { mode: 'pass' });
  const okChunks: LlmStreamChunk[] = [];
  let sawError = false;
  for await (const c of agent.streamProcess('hi')) {
    if (c.ok) okChunks.push(c.value);
    else sawError = true;
  }
  assert.equal(sawError, true);
  // No terminal success (finishReason:'stop') usage chunk after the error.
  assert.equal(
    okChunks.some((c) => c.finishReason === 'stop' && c.usage),
    false,
  );
});
