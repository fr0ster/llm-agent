import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IBearerCredential } from '@mcp-abap-adt/interfaces-auth';
import {
  isOrchestrationChatModel,
  type SapCoreAICatalogModel,
  type SapCoreAIDestination,
  SapCoreAIProvider,
} from '../index.js';

function testCredential(prefix: string): IBearerCredential {
  let calls = 0;
  return { kind: 'bearer', token: async () => `${prefix}${++calls}` };
}

const apiBaseUrl = 'https://api.ai.example.com';

class CatalogProvider extends SapCoreAIProvider {
  readonly destinations: SapCoreAIDestination[] = [];
  failure?: Error;
  constructor(private readonly catalog: SapCoreAICatalogModel[]) {
    super({ model: 'gpt-4o', apiBaseUrl, credential: testCredential('cat') });
  }
  protected override async queryModelCatalog(
    destination: SapCoreAIDestination,
  ): Promise<SapCoreAICatalogModel[]> {
    this.destinations.push(destination);
    if (this.failure) throw this.failure;
    return this.catalog;
  }
}

describe('SapCoreAIProvider — model catalog', () => {
  const catalog: SapCoreAICatalogModel[] = [
    {
      model: 'gpt-4o',
      allowedScenarios: [
        { scenarioId: 'orchestration', executableId: 'orchestration' },
        { scenarioId: 'another-scenario' },
      ],
      versions: [{ isLatest: true, capabilities: ['text-generation'] }],
    },
    {
      model: 'text-embedding-3-small',
      versions: [{ isLatest: true, capabilities: ['embedding'] }],
    },
  ];

  it('queries the catalog with the configured credential', async () => {
    const p = new CatalogProvider(catalog);
    const models = await p.getModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['gpt-4o', 'text-embedding-3-small'],
    );
    assert.equal(p.destinations.length, 1);
    assert.equal(p.destinations[0].url, apiBaseUrl);
    assert.equal(p.destinations[0].headers.Authorization, 'Bearer cat1');
  });

  it('getEmbeddingModels returns the models the catalog marks "embedding"', async () => {
    const p = new CatalogProvider(catalog);
    const models = await p.getEmbeddingModels();
    assert.deepEqual(
      models.map((m) => m.id),
      ['text-embedding-3-small'],
    );
  });

  it('exposes allowed scenario IDs through both catalog APIs', async () => {
    const p = new CatalogProvider(catalog);
    for (const models of [await p.getModelCatalog(), await p.getModels()]) {
      assert.deepEqual(models[0].scenarios, [
        'orchestration',
        'another-scenario',
      ]);
      assert.equal(models[1].scenarios, undefined);
    }
  });

  it('propagates the original error and cause, then allows a fresh retry', async () => {
    const p = new CatalogProvider(catalog);
    const cause = new Error('tenant catalog unavailable');
    const failure = new Error('catalog query failed', { cause });
    p.failure = failure;
    await assert.rejects(p.getModelCatalog(), (error: Error) => {
      assert.equal(error, failure);
      assert.equal(error.cause, cause);
      return true;
    });
    assert.deepEqual(await p.getModels(), [{ id: 'gpt-4o' }]);
    p.failure = undefined;
    assert.equal((await p.getModels()).length, 2);
    assert.equal(p.destinations.length, 3);
  });

  it('bypasses a warm cache and leaves it intact on catalog failure', async () => {
    const p = new CatalogProvider(catalog);
    const cached = await p.getModels();
    await p.getModelCatalog();
    assert.equal(p.destinations[1].headers.Authorization, 'Bearer cat2');
    p.failure = new Error('catalog failed');
    await assert.rejects(p.getModelCatalog(), p.failure);
    assert.equal(await p.getModels(), cached);
    assert.equal(p.destinations.length, 3);
  });

  it('preserves a successful empty catalog', async () => {
    assert.deepEqual(await new CatalogProvider([]).getModelCatalog(), []);
  });
});

describe('isOrchestrationChatModel', () => {
  const chat = {
    id: 'chat',
    capabilities: ['text-generation'],
    scenarios: ['orchestration'],
  };

  it('accepts nondeprecated orchestration text-generation models', () => {
    assert.equal(isOrchestrationChatModel(chat), true);
    assert.equal(
      isOrchestrationChatModel({ ...chat, deprecated: false }),
      true,
    );
  });

  it('excludes deprecated, non-chat and unavailable or missing scenarios', () => {
    for (const info of [
      { ...chat, deprecated: true },
      { ...chat, capabilities: ['embedding'] },
      { ...chat, capabilities: undefined },
      { ...chat, scenarios: ['foundation-models'] },
      { ...chat, scenarios: [] },
      { ...chat, scenarios: undefined },
      { id: 'fallback' },
    ]) {
      assert.equal(isOrchestrationChatModel(info), false);
    }
  });
});
