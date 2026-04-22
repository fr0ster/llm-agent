import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IModelInfo } from '@mcp-abap-adt/llm-agent';
import { LlmError } from '@mcp-abap-adt/llm-agent';
import { LlmAdapter, type LlmAdapterProviderInfo } from '../llm-adapter.js';

// ---------------------------------------------------------------------------
// Minimal bridge mock — LlmAdapter only uses agent for chat/streamChat
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test double
const dummyBridge = {} as any;

// ---------------------------------------------------------------------------
// Helper to build LlmAdapterProviderInfo
// ---------------------------------------------------------------------------

function makeProvider(opts: {
  model?: string;
  models?: string[] | IModelInfo[];
  embeddingModels?: string[] | IModelInfo[];
  throwOnModels?: boolean;
  throwOnEmbeddingModels?: boolean;
}): LlmAdapterProviderInfo {
  return {
    model: opts.model ?? 'gpt-4',
    getModels:
      opts.models !== undefined || opts.throwOnModels
        ? async () => {
            if (opts.throwOnModels) throw new Error('models fetch failed');
            // biome-ignore lint/style/noNonNullAssertion: checked by condition above
            return opts.models!;
          }
        : undefined,
    getEmbeddingModels:
      opts.embeddingModels !== undefined || opts.throwOnEmbeddingModels
        ? async () => {
            if (opts.throwOnEmbeddingModels)
              throw new Error('embedding models fetch failed');
            // biome-ignore lint/style/noNonNullAssertion: checked by condition above
            return opts.embeddingModels!;
          }
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// getEmbeddingModels()
// ---------------------------------------------------------------------------

describe('LlmAdapter.getEmbeddingModels()', () => {
  it('returns empty array when provider has no getEmbeddingModels', async () => {
    const adapter = new LlmAdapter(dummyBridge, {
      model: 'gpt-4',
    });
    const result = await adapter.getEmbeddingModels();
    assert.ok(result.ok);
    assert.deepEqual(result.value, []);
  });

  it('returns normalized IModelInfo[] when provider returns strings', async () => {
    const provider = makeProvider({
      embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
    });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getEmbeddingModels();
    assert.ok(result.ok);
    assert.deepEqual(result.value, [
      { id: 'text-embedding-3-small' },
      { id: 'text-embedding-3-large' },
    ]);
  });

  it('returns IModelInfo[] as-is when provider returns objects', async () => {
    const models: IModelInfo[] = [
      { id: 'text-embedding-3-small', displayName: 'Small Embedding' },
    ];
    const provider = makeProvider({ embeddingModels: models });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getEmbeddingModels();
    assert.ok(result.ok);
    assert.deepEqual(result.value, models);
  });

  it('wraps errors as LlmError with MODEL_LIST_FAILED', async () => {
    const provider = makeProvider({ throwOnEmbeddingModels: true });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getEmbeddingModels();
    assert.ok(!result.ok);
    assert.ok(result.error instanceof LlmError);
    assert.equal(result.error.code, 'MODEL_LIST_FAILED');
  });

  it('passes LlmError through unchanged', async () => {
    const original = new LlmError('quota exceeded', 'QUOTA');
    const provider: LlmAdapterProviderInfo = {
      model: 'gpt-4',
      getEmbeddingModels: async () => {
        throw original;
      },
    };
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getEmbeddingModels();
    assert.ok(!result.ok);
    assert.equal(result.error, original);
  });
});

// ---------------------------------------------------------------------------
// getModels() with excludeEmbedding
// ---------------------------------------------------------------------------

describe('LlmAdapter.getModels()', () => {
  it('returns single model entry when provider has no getModels', async () => {
    const adapter = new LlmAdapter(dummyBridge, { model: 'gpt-4' });
    const result = await adapter.getModels();
    assert.ok(result.ok);
    assert.deepEqual(result.value, [{ id: 'gpt-4' }]);
  });

  it('returns all models without excludeEmbedding flag', async () => {
    const provider = makeProvider({
      models: ['gpt-4', 'text-embedding-3-small'],
      embeddingModels: ['text-embedding-3-small'],
    });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getModels();
    assert.ok(result.ok);
    assert.equal(result.value.length, 2);
  });

  it('with excludeEmbedding: true — filters out embedding models', async () => {
    const provider = makeProvider({
      models: ['gpt-4', 'text-embedding-3-small', 'text-embedding-3-large'],
      embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large'],
    });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getModels({ excludeEmbedding: true });
    assert.ok(result.ok);
    assert.equal(result.value.length, 1);
    assert.equal(result.value[0].id, 'gpt-4');
  });

  it('excludeEmbedding works with IModelInfo objects', async () => {
    const allModels: IModelInfo[] = [{ id: 'gpt-4' }, { id: 'ada-002' }];
    const embeddingModels: IModelInfo[] = [{ id: 'ada-002' }];
    const provider = makeProvider({
      models: allModels,
      embeddingModels,
    });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getModels({ excludeEmbedding: true });
    assert.ok(result.ok);
    assert.deepEqual(result.value, [{ id: 'gpt-4' }]);
  });

  it('wraps errors as LlmError with MODEL_LIST_FAILED', async () => {
    const provider = makeProvider({ throwOnModels: true });
    const adapter = new LlmAdapter(dummyBridge, provider);
    const result = await adapter.getModels();
    assert.ok(!result.ok);
    assert.ok(result.error instanceof LlmError);
    assert.equal(result.error.code, 'MODEL_LIST_FAILED');
  });
});
