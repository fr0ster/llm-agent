import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { LegacyTranscriptContextStrategy } from '../legacy-transcript-context-strategy.js';

const prefix: Message[] = [{ role: 'system', content: 'S' }];
const raw: Message[] = [
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'T', arguments: '{}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'c1', content: 'r1' },
  { role: 'user', content: 'retry feedback' },
];
const newRound: ToolRound = {
  assistant: {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c2', type: 'function', function: { name: 'T', arguments: '{}' } },
    ],
  },
  results: [{ role: 'tool', tool_call_id: 'c2', content: 'r2' }],
};

test('form = prefix + rawMessages verbatim + new rounds', async () => {
  const s = new LegacyTranscriptContextStrategy({ rawMessages: raw });
  let msgs = await s.form({ prefix });
  assert.deepEqual(msgs, [...prefix, ...raw]);
  await s.record(newRound);
  msgs = await s.form({ prefix });
  assert.equal(msgs.length, prefix.length + raw.length + 2);
  assert.equal(msgs.at(-1)?.content, 'r2');
});

test('snapshot/restore preserves rawMessages + newRounds', async () => {
  const s = new LegacyTranscriptContextStrategy({ rawMessages: raw });
  await s.record(newRound);
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  const s2 = new LegacyTranscriptContextStrategy({ rawMessages: [] });
  s2.restore(snap);
  assert.equal(
    (await s2.form({ prefix })).length,
    prefix.length + raw.length + 2,
  );
});
