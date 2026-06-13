import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IEmbedder, ISkillsStoreProvider } from '@mcp-abap-adt/llm-agent';
import type { IPgPool } from '@mcp-abap-adt/llm-agent-libs';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';
import { buildSkillHostFromConfig } from './skill-plugins-host-factory.js';

/**
 * Deterministic stub embedder: maps a text to a fixed-length vector derived from
 * its char codes so similar texts cluster (enough for a ≥1-hit recall assertion).
 */
function makeStubEmbedder(dim = 8): IEmbedder {
  return {
    async embed(text: string) {
      const v = new Array<number>(dim).fill(0);
      for (let i = 0; i < text.length; i++) {
        v[i % dim] += text.charCodeAt(i) % 13;
      }
      return { vector: v };
    },
  };
}

test('records source + in-memory store + in-process catalog → host serves the records', async () => {
  const cfg = parseSkillPluginsConfig({
    mode: 'implicit',
    store: { type: 'in-memory' },
    catalog: { type: 'in-process' },
    sources: [
      {
        id: 'vendor',
        records: [
          {
            id: 'vendor:p@1/alpha#0',
            group: 'abap',
            name: 'p/alpha',
            content: 'How to create an ABAP class with a constructor',
            retrievalText: 'How to create an ABAP class with a constructor',
            provenance: 'p@1/alpha',
          },
          {
            id: 'vendor:p@1/beta#0',
            group: 'abap',
            name: 'p/beta',
            content: 'How to write a SELECT statement in ABAP SQL',
            retrievalText: 'How to write a SELECT statement in ABAP SQL',
            provenance: 'p@1/beta',
          },
        ],
      },
    ],
  });

  const host = await buildSkillHostFromConfig(cfg, {
    resolveEmbedder: () => makeStubEmbedder(),
  });
  await host.load();

  const groups = host.groups().map((g) => g.group);
  assert.ok(groups.includes('abap'), `expected group 'abap', got ${groups}`);

  const hits = await host.rag('abap').query('create an ABAP class', { k: 3 });
  assert.ok(hits.length >= 1, 'expected at least one recalled record');
  assert.ok(
    hits.every((h) => h.record.sourceId === 'vendor'),
    'records must be stamped with the configured sourceId',
  );
});

test('store.type qdrant + catalog.type postgres selects the Qdrant provider path', async () => {
  const cfg = parseSkillPluginsConfig({
    mode: 'implicit',
    store: { type: 'qdrant', url: 'http://qdrant:6333', collection: 'skills' },
    catalog: {
      type: 'postgres',
      connectionString: 'postgres://localhost/skills',
    },
    embeddingSpaceId: 'sp-1',
    dimension: 8,
    recallTimeoutMs: 1000,
    sources: [
      {
        id: 'vendor',
        records: [
          {
            id: 'vendor:p@1/x#0',
            group: 'abap',
            content: 'body',
          },
        ],
      },
    ],
  });

  // Fake pg pool (never queried — load() is not invoked here).
  const fakePool: IPgPool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };

  let qdrantProviderSelected = false;
  // Test seam: assert the qdrant store.type drives provider selection.
  const makeStoreProvider = (c: typeof cfg): ISkillsStoreProvider => {
    qdrantProviderSelected = c.store.type === 'qdrant';
    // Return a minimal stub provider (build-only assertion; no load()).
    return {
      forGroup: () => {
        throw new Error('not used');
      },
      readCatalog: async () => ({ catalogRevision: 'c0', entries: [] }),
      publishCatalog: async () => ({ catalogRevision: 'c1', entries: [] }),
      dropCollection: async () => {},
      asBackendProvider: () => ({
        readCatalog: async () => ({ catalogRevision: 'c0', entries: [] }),
        forGroup: () => {
          throw new Error('not used');
        },
      }),
    };
  };

  const host = await buildSkillHostFromConfig(cfg, {
    resolveEmbedder: () => makeStubEmbedder(),
    makePgPool: () => fakePool,
    makeStoreProvider,
  });

  assert.ok(
    qdrantProviderSelected,
    'qdrant store.type must select the qdrant path',
  );
  assert.ok(typeof host.load === 'function', 'host is constructed');
});
