import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { MissingProviderError } from '@mcp-abap-adt/llm-agent';
import {
  _resetPrefetchedForTests,
  prefetchEmbedderFactories,
  resolvePrefetchedEmbedder,
} from '../embedder-factories.js';

afterEach(() => {
  _resetPrefetchedForTests();
});

describe('factory registry — MissingProviderError', () => {
  it('resolvePrefetchedEmbedder throws MissingProviderError for unknown factory name', () => {
    assert.throws(
      () => resolvePrefetchedEmbedder('does-not-exist', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('resolvePrefetchedEmbedder throws before prefetch', () => {
    assert.throws(
      () => resolvePrefetchedEmbedder('openai', {}),
      (err: unknown) => err instanceof MissingProviderError,
    );
  });
  it('prefetchEmbedderFactories resolves installed peer', async () => {
    await prefetchEmbedderFactories(['openai']);
    const e = resolvePrefetchedEmbedder('openai', { apiKey: 'test' });
    assert.ok(e);
  });
});
