import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, ToolRound } from '@mcp-abap-adt/llm-agent';
import { RagRecallContextStrategy } from '../rag-recall-context-strategy.js';

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

test('form: null last → prefix only, recall NOT called', async () => {
  let recallCalls = 0;
  const s = new RagRecallContextStrategy(
    {
      record: async () => {},
      recall: async () => {
        recallCalls++;
        return 'X';
      },
    },
    { runId: 'run1' },
  );
  assert.deepEqual(await s.form({ prefix, queryText: 'q' }), prefix);
  assert.equal(recallCalls, 0);
});

test('record assigns deterministic roundId and excludes it from recall; no double-appearance', async () => {
  const recorded: string[] = [];
  let excluded: string[] = [];
  const s = new RagRecallContextStrategy(
    {
      record: async (r) => {
        recorded.push(r.roundId!);
      },
      recall: async (_q, excl) => {
        excluded = excl;
        return 'RECALL';
      },
    },
    { runId: 'run1' },
  );
  await s.record(mkRound('c1', 'r1'));
  await s.record(mkRound('c2', 'r2'));
  assert.deepEqual(recorded, ['run1:0', 'run1:1']);
  const msgs = await s.form({ prefix, queryText: 'q' });
  // prefix + recall(user) + last round (assistant+tool) = 4
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].content, 'RECALL');
  assert.equal(msgs.at(-1)?.content, 'r2');
  assert.deepEqual(excluded, ['run1:1']); // exclude the raw-tail round
});

test('missing runId fails loud at construction', () => {
  assert.throws(
    () =>
      new RagRecallContextStrategy(
        { record: async () => {}, recall: async () => '' },
        { runId: '' },
      ),
  );
});

test('counter survives snapshot/restore (stable ids after resume)', async () => {
  const s = new RagRecallContextStrategy(
    { record: async () => {}, recall: async () => '' },
    { runId: 'run1' },
  );
  await s.record(mkRound('c1', 'r1'));
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  assert.equal(snap.counter, 1);
  const s2 = new RagRecallContextStrategy(
    { record: async () => {}, recall: async () => '' },
    { runId: 'run1' },
  );
  s2.restore(snap);
  const captured: string[] = [];
  const s3 = new RagRecallContextStrategy(
    { record: async (r) => captured.push(r.roundId!), recall: async () => '' },
    { runId: 'run1' },
  );
  s3.restore(snap);
  await s3.record(mkRound('c2', 'r2'));
  assert.equal(captured[0], 'run1:1'); // continues from restored counter, not 0
});
