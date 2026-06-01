import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamChunk } from '@mcp-abap-adt/llm-agent';
import { InsufficientSignal } from '@mcp-abap-adt/llm-agent';
import { RootFinalizer } from '../root-finalizer.js';

function streamingLlm(deltas: string[]) {
  return {
    name: 'stub',
    async *streamChat() {
      for (let i = 0; i < deltas.length; i++) {
        const last = i === deltas.length - 1;
        yield {
          ok: true as const,
          value: {
            content: deltas[i],
            ...(last
              ? {
                  finishReason: 'stop',
                  usage: {
                    promptTokens: 1,
                    completionTokens: deltas.length,
                    totalTokens: 1 + deltas.length,
                  },
                }
              : {}),
          },
        };
      }
    },
  };
}

function ragWith(entries: { content: string; turnId: string }[]) {
  return {
    async query() {
      return [];
    },
    async list(f: { turnId?: string }) {
      return entries
        .filter((e) => !f.turnId || e.turnId === f.turnId)
        .map((e) => ({
          content: e.content,
          metadata: {
            traceId: 't',
            turnId: e.turnId,
            stepperId: 'n',
            task: 'x',
            artifactType: 'analysis-finding',
            createdAt: '2026-05-29T00:00:00Z',
          },
        }));
    },
    async write() {},
    fingerprint() {
      return '';
    },
  };
}

test('finalizer reads current turn exhaustively via list and streams content', async () => {
  const chunks: StreamChunk[] = [];
  const fin = new RootFinalizer(streamingLlm(['Sec', 'urity ', 'OK']) as never);
  const res = await fin.finalize({
    prompt: 'review',
    knowledgeRag: ragWith([
      { content: 'finding A', turnId: 'u1' },
      { content: 'finding B', turnId: 'u2' },
    ]) as never,
    turnId: 'u1',
    onProgress: (c) => chunks.push(c),
  });
  assert.equal(res.output, 'Security OK');
  assert.deepEqual(
    chunks
      .filter((c) => c.kind === 'content')
      .map((c) => (c as { delta: string }).delta),
    ['Sec', 'urity ', 'OK'],
  );
});

test('H.6 finalizer raises InsufficientSignal when llm emits the insufficient marker', async () => {
  const fin = new RootFinalizer(
    streamingLlm(['{"insufficient":["source code"]}']) as never,
  );
  await assert.rejects(
    () =>
      fin.finalize({
        prompt: 'review',
        knowledgeRag: ragWith([]) as never,
        turnId: 'u1',
      }),
    (e: unknown) =>
      e instanceof InsufficientSignal && e.missing.includes('source code'),
  );
});
