import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSkillPluginsConfig } from './skill-plugins-config.js';

// 1. mode: explicit is rejected this phase.
test('mode: explicit throws "not yet implemented"', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        mode: 'explicit',
        sources: [{ id: 'a', records: [] }],
      }),
    /explicit.*not yet implemented/i,
  );
});

// 2. store.type validation + qdrant requires embeddingSpaceId.
test('unknown store.type throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'redis' },
        sources: [{ id: 'a', records: [] }],
      }),
    /store\.type/i,
  );
});

test('qdrant store without embeddingSpaceId throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'qdrant', url: 'http://q' },
        catalog: { type: 'postgres', connectionString: 'pg://x' },
        sources: [{ id: 'a', records: [] }],
      }),
    /embeddingSpaceId/i,
  );
});

// 3. qdrant requires a persistent (postgres) catalog.
test('qdrant store with absent catalog throws (needs persistent catalog)', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'qdrant', url: 'http://q' },
        embeddingSpaceId: 'sp-1',
        sources: [{ id: 'a', records: [] }],
      }),
    /persistent store requires a persistent catalog \(postgres\)/i,
  );
});

test('qdrant store with in-process catalog throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'qdrant', url: 'http://q' },
        embeddingSpaceId: 'sp-1',
        catalog: { type: 'in-process' },
        sources: [{ id: 'a', records: [] }],
      }),
    /persistent store requires a persistent catalog \(postgres\)/i,
  );
});

test('qdrant store with postgres catalog parses', () => {
  const cfg = parseSkillPluginsConfig({
    store: { type: 'qdrant', url: 'http://q' },
    embeddingSpaceId: 'sp-1',
    catalog: { type: 'postgres', connectionString: 'pg://x' },
    sources: [{ id: 'a', records: [] }],
  });
  assert.equal(cfg.store.type, 'qdrant');
  assert.equal(cfg.catalog.type, 'postgres');
});

// 4. retiredGraceMs / recallTimeoutMs invariants.
test('retiredGraceMs < 1000 throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        retiredGraceMs: 999,
        sources: [{ id: 'a', records: [] }],
      }),
    /retiredGraceMs/i,
  );
});

test('recallTimeoutMs >= retiredGraceMs throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        retiredGraceMs: 2000,
        recallTimeoutMs: 2000,
        sources: [{ id: 'a', records: [] }],
      }),
    /recallTimeoutMs/i,
  );
});

test('default recallTimeoutMs is floor(retiredGraceMs*0.8) and < retiredGraceMs (qdrant)', () => {
  const cfg = parseSkillPluginsConfig({
    store: { type: 'qdrant', url: 'http://q' },
    embeddingSpaceId: 'sp-1',
    catalog: { type: 'postgres', connectionString: 'pg://x' },
    retiredGraceMs: 1000,
    sources: [{ id: 'a', records: [] }],
  });
  assert.equal(cfg.recallTimeoutMs, 800);
  assert.ok((cfg.recallTimeoutMs as number) < cfg.retiredGraceMs);
});

// 5. fetched source enabled list.
test('fetched source with missing enabled throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        sources: [{ id: 'vendor', registry: 'http://r' }],
      }),
    /enabled/i,
  );
});

test('fetched source with empty enabled throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        sources: [{ id: 'vendor', registry: 'http://r', enabled: [] }],
      }),
    /enabled/i,
  );
});

test('fetched source with enabled: ["*"] parses', () => {
  const cfg = parseSkillPluginsConfig({
    sources: [{ id: 'vendor', registry: 'http://r', enabled: ['*'] }],
  });
  assert.equal(cfg.sources?.length, 1);
});

// 6. duplicate sourceId across sources.
test('duplicate sourceId across sources throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        sources: [
          { id: 'dup', records: [] },
          { id: 'dup', registry: 'http://r', enabled: ['*'] },
        ],
      }),
    /duplicate.*sourceId|sourceId.*dup/i,
  );
});

// 7. strategy name validated via resolveSkillSourceStrategy.
test('fetched source with unknown strategy throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        sources: [
          {
            id: 'vendor',
            registry: 'http://r',
            enabled: ['*'],
            strategy: 'no-such-strategy',
          },
        ],
      }),
    /strategy/i,
  );
});

test('fetched source with known strategy parses and passes strategyConfig through', () => {
  const cfg = parseSkillPluginsConfig({
    sources: [
      {
        id: 'vendor',
        registry: 'http://r',
        enabled: ['*'],
        strategy: 'one-group-per-plugin',
        strategyConfig: { foo: 'bar' },
      },
    ],
  });
  const src = cfg.sources?.[0];
  assert.ok(src && 'registry' in src);
  assert.equal(src.strategy, 'one-group-per-plugin');
  assert.deepEqual(src.strategyConfig, { foo: 'bar' });
});

// 8. recall-only / sources mutual constraints.
test('sources together with loadOnStartup:false throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        loadOnStartup: false,
        store: { type: 'qdrant', url: 'http://q' },
        embeddingSpaceId: 'sp-1',
        catalog: { type: 'postgres', connectionString: 'pg://x' },
        sources: [{ id: 'a', records: [] }],
      }),
    /loadOnStartup/i,
  );
});

test('both sources and a persistent store omitted throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig({ loadOnStartup: false }),
    /persistent store/i,
  );
});

// 9. clean implicit config → normalized object with defaults.
test('clean implicit config parses with defaults applied', () => {
  const cfg = parseSkillPluginsConfig({
    sources: [{ id: 'my-skills', records: [{ group: 'g', content: 'x' }] }],
  });
  assert.equal(cfg.mode, 'implicit');
  assert.deepEqual(cfg.store, { type: 'in-memory' });
  assert.deepEqual(cfg.catalog, { type: 'in-process' });
  assert.equal(cfg.k, 4);
  assert.equal(cfg.threshold, 0.3);
  assert.equal(cfg.maxInjectChars, 4000);
  assert.deepEqual(cfg.chunk, { maxChars: 1500 });
  assert.equal(cfg.strict, false);
  assert.equal(cfg.catalogCasMaxAttempts, 3);
  assert.equal(cfg.retiredGraceMs, 30000);
  assert.equal(cfg.orphanGraceMs, 3600000);
  assert.equal(cfg.loadOnStartup, true);
  // in-memory store → recallTimeoutMs unused (undefined).
  assert.equal(cfg.recallTimeoutMs, undefined);
  assert.equal(cfg.sources?.length, 1);
});

// 10. P2-C — catalog.table must be a valid SQL identifier.
test('catalog.table with SQL injection chars throws', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'qdrant', url: 'http://q' },
        embeddingSpaceId: 'sp-1',
        catalog: {
          type: 'postgres',
          connectionString: 'pg://x',
          table: 'foo; DROP TABLE x',
        },
        sources: [{ id: 'a', records: [{ group: 'g', content: 'x' }] }],
      }),
    /catalog\.table.*valid SQL identifier/i,
  );
});

test('catalog.table accepts a bare identifier and a schema.table', () => {
  const base = {
    store: { type: 'qdrant', url: 'http://q' } as const,
    embeddingSpaceId: 'sp-1',
    sources: [{ id: 'a', records: [{ group: 'g', content: 'x' }] }],
  };
  const bare = parseSkillPluginsConfig({
    ...base,
    catalog: {
      type: 'postgres',
      connectionString: 'pg://x',
      table: 'my_table',
    },
  });
  assert.deepEqual(bare.catalog, {
    type: 'postgres',
    connectionString: 'pg://x',
    table: 'my_table',
  });
  const dotted = parseSkillPluginsConfig({
    ...base,
    catalog: {
      type: 'postgres',
      connectionString: 'pg://x',
      table: 'schema.my_table',
    },
  });
  assert.deepEqual(dotted.catalog, {
    type: 'postgres',
    connectionString: 'pg://x',
    table: 'schema.my_table',
  });
});

// 11. P2-D — numeric knobs reject NaN / zero / non-integer / out-of-range.
const withSource = (extra: Record<string, unknown>) => ({
  sources: [{ id: 'a', records: [{ group: 'g', content: 'x' }] }],
  ...extra,
});

test('threshold non-numeric throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ threshold: 'x' })),
    /threshold/i,
  );
});

test('threshold out of [0,1] throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ threshold: 2 })),
    /threshold/i,
  );
});

test('threshold boundary values 0 and 1 parse', () => {
  assert.equal(
    parseSkillPluginsConfig(withSource({ threshold: 0 })).threshold,
    0,
  );
  assert.equal(
    parseSkillPluginsConfig(withSource({ threshold: 1 })).threshold,
    1,
  );
});

test('k zero throws', () => {
  assert.throws(() => parseSkillPluginsConfig(withSource({ k: 0 })), /k must/i);
});

test('k non-integer throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ k: 1.5 })),
    /k must/i,
  );
});

test('k non-numeric (NaN-ish) throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ k: 'abc' })),
    /k must/i,
  );
});

test('maxInjectChars / catalogCasMaxAttempts / chunk.maxChars zero throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ maxInjectChars: 0 })),
    /maxInjectChars/i,
  );
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ catalogCasMaxAttempts: 0 })),
    /catalogCasMaxAttempts/i,
  );
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ chunk: { maxChars: 0 } })),
    /chunk\.maxChars/i,
  );
});

test('orphanGraceMs non-integer throws', () => {
  assert.throws(
    () => parseSkillPluginsConfig(withSource({ orphanGraceMs: 1.5 })),
    /orphanGraceMs/i,
  );
});

test('valid numeric knobs parse', () => {
  const cfg = parseSkillPluginsConfig(
    withSource({
      k: 8,
      threshold: 0.5,
      maxInjectChars: 2000,
      catalogCasMaxAttempts: 5,
      retiredGraceMs: 60000,
      orphanGraceMs: 120000,
      chunk: { maxChars: 800 },
    }),
  );
  assert.equal(cfg.k, 8);
  assert.equal(cfg.threshold, 0.5);
  assert.equal(cfg.maxInjectChars, 2000);
  assert.equal(cfg.catalogCasMaxAttempts, 5);
  assert.equal(cfg.retiredGraceMs, 60000);
  assert.equal(cfg.orphanGraceMs, 120000);
  assert.deepEqual(cfg.chunk, { maxChars: 800 });
});
