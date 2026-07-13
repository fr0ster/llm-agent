import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { LegacyAccumulateContextStrategy } from '../legacy-accumulate-context-strategy.js';

const mkRound = (id: string, text: string): ToolRound => ({
  assistant: {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id, type: 'function', function: { name: 'T', arguments: '{}' } },
    ],
  },
  results: [{ role: 'tool', tool_call_id: id, content: text }],
});
const prefix: Message[] = [{ role: 'system', content: 'S' }];

test('form returns prefix + all recorded rounds raw, in order; current batch once', async () => {
  const s = new LegacyAccumulateContextStrategy();
  await s.record(mkRound('c1', 'r1'));
  await s.record(mkRound('c2', 'r2'));
  const msgs = await s.form({ prefix });
  assert.equal(msgs[0].content, 'S');
  // prefix(1) + 2 rounds × (assistant+tool)=4 → 5 messages
  assert.equal(msgs.length, 5);
  assert.equal(msgs[4].content, 'r2'); // most-recent tool result is the tail
});

test('empty history → prefix only', async () => {
  const s = new LegacyAccumulateContextStrategy();
  assert.deepEqual(await s.form({ prefix }), prefix);
});

test('snapshot/restore round-trips as JSON and is versioned', async () => {
  const s = new LegacyAccumulateContextStrategy();
  await s.record(mkRound('c1', 'r1'));
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.equal(snap.version, 1);
  const s2 = new LegacyAccumulateContextStrategy();
  s2.restore(snap);
  assert.equal((await s2.form({ prefix })).length, 3);
  // unknown version → clean
  const s3 = new LegacyAccumulateContextStrategy();
  s3.restore({ version: 999 } as never);
  assert.deepEqual(await s3.form({ prefix }), prefix);
});
