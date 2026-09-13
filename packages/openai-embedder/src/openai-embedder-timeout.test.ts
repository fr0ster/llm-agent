import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { OpenAiEmbedder } from './openai-embedder.js';

/**
 * A ceiling on every request fires instead of the decision above it: a caller
 * waiting out a server's `Retry-After` is cut before the interval is up, and a
 * governed delay becomes an ungoverned failure. Thirty seconds used to be
 * imposed here. The library sets none now; the bound is what the caller passes.
 */
function captureSignal() {
  const seen: (AbortSignal | null | undefined)[] = [];
  const fetchMock = mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init?: unknown) => {
      seen.push((init as { signal?: AbortSignal | null })?.signal);
      return new Response(
        JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  );
  return { seen, restore: () => fetchMock.mock.restore() };
}

const embedder = (timeoutMs?: number) =>
  new OpenAiEmbedder({
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe('OpenAiEmbedder — no ceiling unless asked', () => {
  it('sends the caller signal unchanged when no timeout is configured', async () => {
    const { seen, restore } = captureSignal();
    try {
      const controller = new AbortController();
      await embedder().embed('hello', { signal: controller.signal });
      assert.equal(seen[0], controller.signal);
    } finally {
      restore();
    }
  });

  it('sends no signal at all when the caller passed none', async () => {
    // An embedding call that takes longer than half a minute is a slow call,
    // not a broken one.
    const { seen, restore } = captureSignal();
    try {
      await embedder().embed('hello');
      assert.equal(seen[0], undefined);
    } finally {
      restore();
    }
  });

  it('still honours a ceiling the consumer set', async () => {
    const { seen, restore } = captureSignal();
    try {
      await embedder(5_000).embed('hello');
      assert.ok(seen[0] instanceof AbortSignal);
    } finally {
      restore();
    }
  });
});
