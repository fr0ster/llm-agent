import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IEmbedder,
  ISkillPluginHost,
  ISkillsStoreProvider,
  SkillGroupInfo,
} from '@mcp-abap-adt/llm-agent';
import type { IPgPool } from '@mcp-abap-adt/llm-agent-libs';
import type { SkillPluginsConfig } from './skill-plugins-config.js';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';
import {
  buildSkillHostFromConfig,
  type IClosablePool,
  initSkillHost,
  validateServedGroups,
} from './skill-plugins-host-factory.js';

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

test('qdrant + postgres catalog uses the injected makePgPool for the catalog', async () => {
  const cfg = parseSkillPluginsConfig({
    mode: 'implicit',
    store: { type: 'qdrant', url: 'http://qdrant:6333', collection: 'skills' },
    catalog: {
      type: 'postgres',
      connectionString: 'postgres://localhost/skills',
      table: 'skills_catalog',
    },
    embeddingSpaceId: 'sp-1',
    dimension: 8,
    recallTimeoutMs: 1000,
    sources: [{ id: 'vendor', records: [{ id: 'v:x#0', group: 'abap' }] }],
  });

  // Fake pg pool whose construction we observe. The ingest store-provider build
  // calls buildCatalogStore → deps.makePgPool(connectionString) for a postgres
  // catalog; load() is NOT invoked so the pool itself is never queried.
  let pgPoolCalledWith: string | undefined;
  const fakePool: IPgPool = { query: async () => ({ rows: [], rowCount: 0 }) };

  const host = await buildSkillHostFromConfig(cfg, {
    resolveEmbedder: () => makeStubEmbedder(),
    makePgPool: (connectionString) => {
      pgPoolCalledWith = connectionString;
      return fakePool;
    },
  });

  assert.equal(
    pgPoolCalledWith,
    'postgres://localhost/skills',
    'the postgres catalog must be built via the injected makePgPool',
  );
  assert.ok(typeof host.load === 'function', 'host is constructed');
});

test('postgres catalog WITHOUT makePgPool throws fail-loud', async () => {
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
    sources: [{ id: 'vendor', records: [{ id: 'v:x#0', group: 'abap' }] }],
  });

  await assert.rejects(
    () =>
      buildSkillHostFromConfig(cfg, {
        resolveEmbedder: () => makeStubEmbedder(),
      }),
    /postgres catalog requires a pg pool provider/i,
  );
});

// P1-A — RECALL-ONLY uses the READ pool (no DDL), ingest uses the WRITE pool.

/** A read pool that THROWS if a `CREATE TABLE` (DDL) SQL ever reaches it. */
function makeNoDdlPool(): IPgPool {
  return {
    query: async (sql: string) => {
      if (/create\s+table/i.test(sql)) {
        throw new Error('read pool must NEVER run DDL');
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function recallOnlyCfg(): SkillPluginsConfig {
  return parseSkillPluginsConfig({
    mode: 'implicit',
    store: { type: 'qdrant', url: 'http://qdrant:6333', collection: 'skills' },
    catalog: {
      type: 'postgres',
      connectionString: 'postgres://localhost/skills',
    },
    embeddingSpaceId: 'sp-1',
    dimension: 8,
    recallTimeoutMs: 1000,
    loadOnStartup: false,
  });
}

test('recall-only path uses makePgReadPool (NOT makePgPool) for the catalog reader', async () => {
  let readPoolCalledWith: string | undefined;
  let writePoolCalled = false;

  const host = await buildSkillHostFromConfig(recallOnlyCfg(), {
    resolveEmbedder: () => makeStubEmbedder(),
    makePgPool: () => {
      writePoolCalled = true;
      return makeNoDdlPool();
    },
    makePgReadPool: (cs) => {
      readPoolCalledWith = cs;
      return makeNoDdlPool();
    },
  });

  assert.equal(
    readPoolCalledWith,
    'postgres://localhost/skills',
    'recall-only must build the catalog reader via makePgReadPool',
  );
  assert.equal(
    writePoolCalled,
    false,
    'recall-only must NOT use the write (DDL) pool',
  );
  assert.ok(typeof host.load === 'function', 'host is constructed');
});

test('recall-only WITHOUT makePgReadPool throws fail-loud (even when makePgPool is present)', async () => {
  await assert.rejects(
    () =>
      buildSkillHostFromConfig(recallOnlyCfg(), {
        resolveEmbedder: () => makeStubEmbedder(),
        makePgPool: () => makeNoDdlPool(),
      }),
    /recall-only postgres catalog requires a read pool/i,
  );
});

// P1-B — validateServedGroups fails loud on unknown serveCollections / controllerSkillGroup.

function hostWithGroups(groups: string[]): ISkillPluginHost {
  const infos: SkillGroupInfo[] = groups.map((g) => ({
    group: g,
    description: g,
    collection: g,
  }));
  return {
    load: async () => ({
      committed: [...groups],
      omitted: [],
      tombstoned: [],
      ok: true,
    }),
    groups: () => infos,
    rag: () => {
      throw new Error('not used');
    },
  } as unknown as ISkillPluginHost;
}

function cfgWith(partial: Partial<SkillPluginsConfig>): SkillPluginsConfig {
  return { ...recallOnlyCfg(), ...partial };
}

test('validateServedGroups: unknown serveCollections entry throws', () => {
  const host = hostWithGroups(['abap', 'sql']);
  assert.throws(
    () => validateServedGroups(host, cfgWith({ serveCollections: ['typo'] })),
    /serveCollections names unknown group\(s\) \[typo\]/i,
  );
});

test('validateServedGroups: unknown controllerSkillGroup throws', () => {
  const host = hostWithGroups(['abap', 'sql']);
  assert.throws(
    () =>
      validateServedGroups(host, cfgWith({ controllerSkillGroup: 'missing' })),
    /controllerSkillGroup 'missing' is not an available group/i,
  );
});

test('validateServedGroups: controllerSkillGroup outside serveCollections is allowed (independent channels)', () => {
  // controllerSkillGroup drives the CONTROLLER PLANNER recall (its own path) and
  // is INDEPENDENT of serveCollections (assembler pipelines). A valid group that
  // is NOT in serveCollections must pass — existence is all that is required.
  const host = hostWithGroups(['abap', 'sql']);
  assert.doesNotThrow(() =>
    validateServedGroups(
      host,
      cfgWith({ serveCollections: ['abap'], controllerSkillGroup: 'sql' }),
    ),
  );
});

test('validateServedGroups: valid serveCollections + controllerSkillGroup passes', () => {
  const host = hostWithGroups(['abap', 'sql']);
  assert.doesNotThrow(() =>
    validateServedGroups(
      host,
      cfgWith({
        serveCollections: ['abap', 'sql'],
        controllerSkillGroup: 'abap',
      }),
    ),
  );
});

test('validateServedGroups: no served subset configured passes (all groups)', () => {
  const host = hostWithGroups(['abap']);
  assert.doesNotThrow(() => validateServedGroups(host, recallOnlyCfg()));
});

// P1-B — initSkillHost ends captured pg pools on a startup failure.

/** A fake pool that records whether end() ran (and may fail end()). */
function makeFakePool(opts?: { failEnd?: boolean }): IClosablePool & {
  ended: boolean;
} {
  const pool = {
    ended: false,
    async end() {
      pool.ended = true;
      if (opts?.failEnd) throw new Error('end() failed');
    },
  };
  return pool;
}

test('initSkillHost: success path returns the loaded+validated host (pools NOT ended)', async () => {
  const pool = makeFakePool();
  const pools: IClosablePool[] = [pool];
  const host = hostWithGroups(['abap', 'sql']);

  const out = await initSkillHost(
    async () => {
      // The build captures a pool (as the server's makePgPool would).
      return host;
    },
    cfgWith({ serveCollections: ['abap'], controllerSkillGroup: 'sql' }),
    pools,
  );

  assert.equal(out, host, 'returns the built host');
  assert.equal(pool.ended, false, 'pools survive on the normal path');
  assert.equal(pools.length, 1, 'pools array left intact for later closeFns');
});

test('initSkillHost: host.load() throwing ends captured pools and rethrows', async () => {
  const pool = makeFakePool();
  const pools: IClosablePool[] = [pool];
  const throwingHost = {
    load: async () => {
      throw new Error('load boom');
    },
    groups: () => [],
    rag: () => {
      throw new Error('not used');
    },
  } as unknown as ISkillPluginHost;

  await assert.rejects(
    () => initSkillHost(async () => throwingHost, recallOnlyCfg(), pools),
    /load boom/,
  );
  assert.equal(pool.ended, true, 'captured pool must be ended on failure');
  assert.equal(pools.length, 0, 'pools array cleared after cleanup');
});

test('initSkillHost: validateServedGroups throwing ends captured pools and rethrows', async () => {
  const pool = makeFakePool();
  const pools: IClosablePool[] = [pool];
  const host = hostWithGroups(['abap']);

  await assert.rejects(
    () =>
      initSkillHost(
        async () => host,
        cfgWith({ controllerSkillGroup: 'missing' }),
        pools,
      ),
    /controllerSkillGroup 'missing' is not an available group/i,
  );
  assert.equal(
    pool.ended,
    true,
    'captured pool must be ended on a validation failure',
  );
  assert.equal(pools.length, 0, 'pools array cleared after cleanup');
});

test('initSkillHost: one pool end() error does not mask the original (allSettled) and other pools still end', async () => {
  const failing = makeFakePool({ failEnd: true });
  const ok = makeFakePool();
  const pools: IClosablePool[] = [failing, ok];
  const throwingHost = {
    load: async () => {
      throw new Error('original failure');
    },
    groups: () => [],
    rag: () => {
      throw new Error('not used');
    },
  } as unknown as ISkillPluginHost;

  await assert.rejects(
    () => initSkillHost(async () => throwingHost, recallOnlyCfg(), pools),
    /original failure/,
    'the ORIGINAL error is rethrown, not the pool end() error',
  );
  assert.equal(failing.ended, true, 'failing pool end() was attempted');
  assert.equal(ok.ended, true, 'the other pool still ends despite the failure');
});
