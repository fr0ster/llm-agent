import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedForTests,
  prefetchEmbedderFactories,
  resolveEmbedder,
} from '../embedder-factories.js';

afterEach(() => {
  _resetPrefetchedForTests();
});

describe('factory registry — MissingProviderError', () => {
  it('resolveEmbedder throws MissingProviderError for unknown factory name', () => {
    assert.throws(
      () => resolveEmbedder('does-not-exist', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('resolveEmbedder throws before prefetch', () => {
    assert.throws(
      () => resolveEmbedder('openai', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('prefetchEmbedderFactories resolves installed peer', async () => {
    await prefetchEmbedderFactories(['openai']);
    const e = resolveEmbedder('openai', { apiKey: 'test' });
    assert.ok(e);
  });
});
