import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { WindowContextStrategy } from '../window-context-strategy.js';

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

test('form keeps only last keepLastRounds raw + one elide marker; context is bounded as N grows', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 2 });
  for (let i = 0; i < 10; i++) await s.record(mkRound(`c${i}`, `r${i}`));
  const msgs = await s.form({ prefix });
  // prefix(1) + marker(1) + 2 rounds × 2 = 6, regardless of the 10 recorded
  assert.equal(msgs.length, 6);
  assert.equal(msgs.at(-1)?.content, 'r9'); // most-recent tool result is the raw tail
  assert.ok(
    msgs.some((m) => m.role === 'user' && String(m.content).includes('elided')),
  );
});

test('flatness: 50 rounds does not grow the formed context', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 3 });
  for (let i = 0; i < 50; i++) await s.record(mkRound(`c${i}`, `r${i}`));
  assert.equal((await s.form({ prefix })).length, 1 + 1 + 3 * 2);
});

test('keepLastRounds < 1 is clamped to 1 (protocol tail guaranteed)', async () => {
  const s = new WindowContextStrategy({ keepLastRounds: 0 });
  await s.record(mkRound('c1', 'r1'));
  assert.equal((await s.form({ prefix })).at(-1)?.content, 'r1');
});
