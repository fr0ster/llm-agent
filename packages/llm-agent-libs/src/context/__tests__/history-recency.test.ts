import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import { ContextAssembler } from '../context-assembler.js';

async function request(
  ragResults: Record<string, RagResult[]>,
  maxTokens?: number,
): Promise<string> {
  const result = await new ContextAssembler({ maxTokens }).assemble(
    { type: 'action', text: 'Hi' },
    { ragResults, tools: [] },
    [],
  );
  assert.ok(result.ok);
  const message = result.value.find((entry) => entry.role === 'user');
  assert.ok(message);
  assert.equal(typeof message.content, 'string');
  assert.ok(typeof message.content === 'string');
  return message.content;
}

const history: RagResult[] = [
  {
    text: 'old-1',
    score: 1,
    metadata: {
      createdAt: '2026-01-01T00:00:00Z',
      turnId: 'old',
      chunkIndex: 1,
    },
  },
  {
    text: 'new-1',
    score: 0.2,
    metadata: { createdAt: 1767312000000, turnId: 'new', chunkIndex: 1 },
  },
  {
    text: 'old-0',
    score: 0.9,
    metadata: {
      createdAt: '2026-01-01T00:00:00Z',
      turnId: 'old',
      chunkIndex: 0,
    },
  },
  {
    text: 'new-0',
    score: 0.1,
    metadata: {
      createdAt: '2026-01-02T00:00:00Z',
      turnId: 'new',
      chunkIndex: 0,
    },
  },
];

it('renders history by recency with contiguous chunks in chunk order without mutating retrieval', async () => {
  const original = structuredClone(history);
  assert.equal(
    await request({ history }),
    '## Relevant History\n- new-0\n- new-1\n- old-0\n- old-1\n\nHi',
  );
  assert.deepEqual(history, original);
});

it('preserves store order for equal timestamps without turnId and for undated records', async () => {
  assert.equal(
    await request({
      history: [
        { text: 'undated-first', score: 0, metadata: {} },
        {
          text: 'chunk-1',
          score: 1,
          metadata: { createdAt: '2026-01-02T00:00:00Z', chunkIndex: 1 },
        },
        { text: 'older', score: 0.9, metadata: { createdAt: 1767225600000 } },
        { text: 'invalid-date', score: 1, metadata: { createdAt: 'invalid' } },
        {
          text: 'chunk-0',
          score: 0,
          metadata: { createdAt: 1767312000000, chunkIndex: 0 },
        },
        { text: 'undated-last', score: 1, metadata: {} },
      ],
    }),
    '## Relevant History\n- chunk-1\n- chunk-0\n- older\n- undated-first\n- invalid-date\n- undated-last\n\nHi',
  );
});

it('evicts complete oldest turns before touching the newest chunks', async () => {
  // One entry over the full budget must remove both chunks of the oldest turn.
  const fullContent = '## Relevant History\n- new-0\n- new-1\n- old-0\n- old-1';
  const budget =
    Math.ceil('Hi'.length / 4) + Math.ceil(fullContent.length / 4) - 1;
  assert.equal(
    await request({ history }, budget),
    '## Relevant History\n- new-0\n- new-1\n\nHi',
  );
  assert.equal(await request({ history }, 1), 'Hi');
});

it('evicts independent records and undated entries from the tail', async () => {
  const entries = history.map(({ metadata, ...entry }) => ({
    ...entry,
    metadata: {
      createdAt: metadata.createdAt,
      chunkIndex: metadata.chunkIndex,
    },
  }));
  entries.push({
    text: 'undated',
    score: 1,
    metadata: { createdAt: undefined, chunkIndex: undefined },
  });
  const kept = '## Relevant History\n- new-1\n- new-0';
  const budget = 1 + Math.ceil(kept.length / 4);
  assert.equal(await request({ history: entries }, budget), `${kept}\n\nHi`);
});

it('evicts unchunked turns with identical timestamps independently', async () => {
  const entries: RagResult[] = [
    { text: 'first', score: 0, metadata: { createdAt: 1767312000000 } },
    { text: 'second', score: 1, metadata: { createdAt: 1767312000000 } },
  ];
  const kept = '## Relevant History\n- first';
  assert.equal(
    await request({ history: entries }, 1 + Math.ceil(kept.length / 4)),
    `${kept}\n\nHi`,
  );
});

it('orders mixed turns stably and evicts whole groups oldest first', async () => {
  const entries: RagResult[] = [
    { text: 'older', score: 1, metadata: { createdAt: 1767225600000 } },
    {
      text: 'chunk-1',
      score: 0,
      metadata: { createdAt: 1767312000000, turnId: 'chunked', chunkIndex: 1 },
    },
    { text: 'single', score: 1, metadata: { createdAt: 1767312000000 } },
    {
      text: 'chunk-0',
      score: 1,
      metadata: { createdAt: 1767312000000, turnId: 'chunked', chunkIndex: 0 },
    },
    { text: 'newest', score: 0, metadata: { createdAt: 1767398400000 } },
  ];
  const kept = '## Relevant History\n- newest\n- chunk-0\n- chunk-1';
  assert.equal(
    await request({ history: entries }),
    `${kept}\n- single\n- older\n\nHi`,
  );
  assert.equal(
    await request({ history: entries }, 1 + Math.ceil(kept.length / 4)),
    `${kept}\n\nHi`,
  );
  const newest = '## Relevant History\n- newest';
  assert.equal(
    await request({ history: entries }, 1 + Math.ceil(kept.length / 4) - 1),
    `${newest}\n\nHi`,
  );
});

it('keeps other sections score-ordered and evicts their lowest scores first', async () => {
  const facts: RagResult[] = [
    { text: 'low', score: 0.1, metadata: { createdAt: '2026-01-03' } },
    { text: 'high', score: 0.9, metadata: { createdAt: '2026-01-01' } },
  ];
  assert.equal(await request({ facts }), '## Known Facts\n- high\n- low\n\nHi');
  const kept = '## Known Facts\n- high';
  assert.equal(
    await request({ facts }, 1 + Math.ceil(kept.length / 4)),
    `${kept}\n\nHi`,
  );
  assert.equal(
    await request({ history, facts }),
    '## Relevant History\n- new-0\n- new-1\n- old-0\n- old-1\n\n## Known Facts\n- high\n- low\n\nHi',
  );
});
