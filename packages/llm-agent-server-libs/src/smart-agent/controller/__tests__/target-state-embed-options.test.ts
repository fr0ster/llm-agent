import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type CallOptions,
  type IUsageRecorder,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { establishTargetState } from '../target-state.js';

test('establishTargetState forwards options to embedder.embed', async () => {
  const seen: (CallOptions | undefined)[] = [];
  const embedder = symmetricEmbedder({
    embed: async (_t: string, o?: CallOptions) => {
      seen.push(o);
      return { vector: [1, 0, 0] };
    },
  });
  const evaluator = {
    send: async () => ({ kind: 'content' as const, content: 'Goal: X' }),
  };
  const roles: string[] = [];
  const usage: IUsageRecorder = {
    record() {},
    with(context) {
      assert.ok(context.role);
      roles.push(context.role);
      return this;
    },
  };
  const opts = { trace: { traceId: 'r1' }, usage };
  await establishTargetState(
    { evaluator, embedder } as never,
    'do X',
    { strategy: 'auto', distanceThreshold: 0.7 },
    opts as never,
  );
  assert.equal(seen.length, 2);
  for (const options of seen) {
    assert.equal(options?.trace, opts.trace);
    assert.equal(options?.usage, usage);
  }
  assert.ok(roles.includes('evaluator'));
  assert.ok(roles.includes('embedding'));
});
