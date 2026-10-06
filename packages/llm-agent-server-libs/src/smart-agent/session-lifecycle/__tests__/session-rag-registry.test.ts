import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ILogger,
  type IRagEditor,
  type IRagProvider,
  type LogEvent,
  type RagCollectionRecord,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import {
  InMemoryRag,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent-rag';
import { buildSessionRagRegistry } from '../session-rag-registry.js';

/** A catalogued provider over in-memory stores. */
function catalogued(
  name: string,
  records: RagCollectionRecord[],
  rejected: { storeName?: string; reason: string }[] = [],
) {
  const opened: string[] = [];
  const deleted: string[] = [];
  const stores = new Map(records.map((r) => [r.storeName, new InMemoryRag()]));
  const provider = {
    name,
    kind: 'vector',
    editable: true,
    supportedScopes: ['session', 'user', 'global'],
    createCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
    describeCollections: async () => ({
      ok: true,
      value: { records, rejected },
    }),
    openCollection: async (record: RagCollectionRecord) => {
      opened.push(record.storeName);
      const rag = stores.get(record.storeName);
      return rag
        ? { ok: true, value: { rag, editor: {} as IRagEditor } }
        : { ok: false, error: new RagError(`gone: ${record.storeName}`) };
    },
    deleteCollection: async (storeName: string) => {
      deleted.push(storeName);
      return { ok: true, value: undefined };
    },
  } as unknown as IRagProvider;
  return { provider, opened, deleted, stores };
}

function logger() {
  const events: LogEvent[] = [];
  const log: ILogger = {
    log: (e) => {
      events.push(e);
    },
  };
  const messages = () =>
    events.map((e) => (e as { message?: string }).message ?? '');
  return { log, messages };
}

const records: RagCollectionRecord[] = [
  { storeName: 'kb_000000000001', name: 'kb', scope: 'global' },
  {
    storeName: 'mine_00000000002',
    name: 'mine',
    scope: 'user',
    userId: 'alice',
  },
  {
    storeName: 'theirs_000000003',
    name: 'theirs',
    scope: 'user',
    userId: 'bob',
  },
  {
    storeName: 'scratch_00000004',
    name: 'scratch',
    scope: 'session',
    sessionId: 'S',
  },
  {
    storeName: 'other_0000000005',
    name: 'other',
    scope: 'session',
    sessionId: 'T',
  },
];

test('seeds the deployment’s globals by reference, and only its globals', async () => {
  const globals = new SimpleRagRegistry();
  const tools = new InMemoryRag();
  globals.register('tools', tools, undefined, {
    displayName: 'tools',
    scope: 'global',
  });
  globals.register('private', new InMemoryRag(), undefined, {
    displayName: 'private',
    scope: 'user',
    userId: 'alice',
  });
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S', userId: 'alice' },
    globals,
  });
  assert.equal(
    reg.get('tools', 'global'),
    tools,
    'the same instance, not a copy',
  );
  assert.equal(
    reg.get('private', 'user'),
    undefined,
    'a user entry in the deployment registry belongs to one caller and is not seeded',
  );
  assert.equal(
    reg.list().find((m) => m.name === 'tools')?.providerName,
    undefined,
    'a reference: deleting it here reaches no provider',
  );
  assert.notEqual(reg, globals);
});

test('hydrates what the catalog holds for this identity, and nothing of anyone else’s', async () => {
  const pg = catalogued('pg', records);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S', userId: 'alice' },
    globals: new SimpleRagRegistry(),
    providers,
  });
  const seen = reg
    .list()
    .map((m) => `${m.scope}:${m.name}`)
    .sort();
  assert.deepEqual(seen, ['global:kb', 'session:scratch', 'user:mine']);
  assert.deepEqual(
    pg.opened.sort(),
    ['kb_000000000001', 'mine_00000000002', 'scratch_00000004'],
    'another caller’s store is not even opened',
  );
  assert.equal(reg.get('mine', 'user'), pg.stores.get('mine_00000000002'));

  // adopted with the provider's name, so closing the session reaches the store
  assert.ok((await reg.closeSession('S')).ok);
  assert.deepEqual(pg.deleted, ['scratch_00000004']);
});

test('a caller without a userId gets no user collection', async () => {
  const pg = catalogued('pg', records);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S' },
    globals: new SimpleRagRegistry(),
    providers,
  });
  assert.equal(
    reg.list().some((m) => m.scope === 'user'),
    false,
  );
});

test('reports rejected catalog rows and hydrates the rest', async () => {
  const pg = catalogued('pg', records.slice(0, 1), [
    { storeName: 'junk_0000000009', reason: 'no scope' },
    { reason: 'no store name' },
  ]);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const { log, messages } = logger();
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log,
  });
  assert.ok(reg.get('kb', 'global'), 'the catalogued global hydrated');
  const all = messages().join('\n');
  assert.match(all, /junk_0000000009.*no scope/);
  assert.match(all, /no store name/);
});

test('a failed catalog read fails the session’s creation with its RagError (spec §10.5.9 V1)', async () => {
  const bad = catalogued('bad', []);
  const unreachable = new RagError('catalog unreachable');
  (bad.provider as { describeCollections: unknown }).describeCollections =
    async () => ({ ok: false, error: unreachable });
  const pg = catalogued('pg', records.slice(0, 1));
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(bad.provider);
  providers.registerProvider(pg.provider);
  await assert.rejects(
    buildSessionRagRegistry({
      identity: { sessionId: 'S' },
      globals: new SimpleRagRegistry(),
      providers,
    }),
    (e: unknown) => e === unreachable,
  );
});

test('a catalogued global that the deployment already configures is skipped, with a warning', async () => {
  const globals = new SimpleRagRegistry();
  const configured = new InMemoryRag();
  globals.register('kb', configured, undefined, {
    displayName: 'kb',
    scope: 'global',
  });
  const pg = catalogued('pg', records.slice(0, 1));
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const { log, messages } = logger();
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S' },
    globals,
    providers,
    logger: log,
  });
  assert.equal(reg.get('kb', 'global'), configured);
  assert.deepEqual(pg.opened, []);
  assert.match(messages().join('\n'), /kb/);
});

test('a provider whose describeCollections throws fails the session’s creation, naming the provider (spec §10.5.9 V1)', async () => {
  const throwing = {
    name: 'throwing',
    kind: 'vector',
    editable: true,
    supportedScopes: ['global'],
    createCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
    describeCollections: async () => {
      throw new Error('describe boom');
    },
    openCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
  } as unknown as IRagProvider;
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(throwing);
  await assert.rejects(
    buildSessionRagRegistry({
      identity: { sessionId: 'S' },
      globals: new SimpleRagRegistry(),
      providers,
    }),
    (e: unknown) =>
      e instanceof RagError &&
      /throwing/.test(e.message) &&
      /describe boom/.test(e.message),
  );
});

test('a record whose openCollection throws fails the session’s creation, naming the store (spec §10.5.9 V1)', async () => {
  // kb (global) and mine (user alice) — both belong to this identity.
  const pg = catalogued('pg', records.slice(0, 2));
  (pg.provider as { openCollection: unknown }).openCollection = async (
    record: RagCollectionRecord,
  ) => {
    if (record.storeName === 'mine_00000000002') {
      throw new Error('open boom');
    }
    pg.opened.push(record.storeName);
    const rag = pg.stores.get(record.storeName);
    return rag
      ? { ok: true, value: { rag, editor: {} as IRagEditor } }
      : { ok: false, error: new RagError(`gone: ${record.storeName}`) };
  };
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  await assert.rejects(
    buildSessionRagRegistry({
      identity: { sessionId: 'S', userId: 'alice' },
      globals: new SimpleRagRegistry(),
      providers,
    }),
    (e: unknown) =>
      e instanceof RagError &&
      /mine_00000000002/.test(e.message) &&
      /open boom/.test(e.message),
  );
});

test('a provider without a catalog is skipped silently', async () => {
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider({
    name: 'plain',
    kind: 'vector',
    editable: true,
    supportedScopes: ['session'],
    createCollection: async () => ({
      ok: false,
      error: new RagError('not expected'),
    }),
  } as unknown as IRagProvider);
  const { log, messages } = logger();
  const reg = await buildSessionRagRegistry({
    identity: { sessionId: 'S' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log,
  });
  assert.equal(reg.list().length, 0);
  assert.deepEqual(messages(), []);
});

test('a circuit-breaker build on one session’s registry leaves every registry as registered (D68: no store wrap)', async () => {
  // B26 concern, closed by D68: the builder wraps no registry store, so a
  // build mutates no registry entry. buildSessionRagRegistry gives every
  // session its OWN SimpleRagRegistry, seeding a global by `register()`-ing a
  // NEW entry that shares only the underlying IRag instance. A real build with
  // withCircuitBreaker() on session A's registry must leave the deployment
  // registry and session B's separately-built registry as registered.
  const globals = new SimpleRagRegistry();
  const originalKb = new InMemoryRag();
  globals.register('kb', originalKb, undefined, {
    displayName: 'kb',
    scope: 'global',
  });

  const regA = await buildSessionRagRegistry({
    identity: { sessionId: 'A' },
    globals,
  });
  const regB = await buildSessionRagRegistry({
    identity: { sessionId: 'B' },
    globals,
  });

  const handleA = await new SmartAgentBuilder({})
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(regA)
    .withCircuitBreaker()
    .build();
  try {
    // Positive control: session A's own entry is the store registered — no wrap.
    assert.equal(
      regA.get('kb', 'global'),
      originalKb,
      'session A’s own entry is the store registered — no wrap',
    );

    // Isolation: neither the deployment registry nor session B's separately
    // built registry saw that wrap.
    assert.equal(
      globals.get('kb', 'global'),
      originalKb,
      'the deployment registry’s own entry is untouched by session A’s wrap',
    );
    assert.equal(
      regB.get('kb', 'global'),
      originalKb,
      'session B’s own entry is untouched by session A’s wrap',
    );
  } finally {
    await handleA.close();
  }
});

test('with a shared `reported` set, a rejected row and a skipped global are logged by the first session only', async () => {
  const globals = new SimpleRagRegistry();
  globals.register('kb', new InMemoryRag(), undefined, {
    displayName: 'kb',
    scope: 'global',
  });
  const pg = catalogued('pg', records.slice(0, 1), [
    { storeName: 'junk_0000000009', reason: 'no scope' },
    { reason: 'no store name' },
  ]);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const reported = new Set<string>();
  const first = logger();
  await buildSessionRagRegistry({
    identity: { sessionId: 'S1' },
    globals,
    providers,
    logger: first.log,
    reported,
  });
  const firstAll = first.messages().join('\n');
  assert.match(firstAll, /rag_catalog_row_rejected.*junk_0000000009/);
  assert.match(firstAll, /rag_catalog_row_rejected.*no store name/);
  assert.match(firstAll, /rag_hydration_skipped.*kb/);

  const second = logger();
  await buildSessionRagRegistry({
    identity: { sessionId: 'S2' },
    globals,
    providers,
    logger: second.log,
    reported,
  });
  assert.deepEqual(second.messages(), [], 'the same rows again: nothing new');

  // A server of its own (its own set) reports them again: nothing is module-global.
  const other = logger();
  await buildSessionRagRegistry({
    identity: { sessionId: 'S3' },
    globals,
    providers,
    logger: other.log,
    reported: new Set<string>(),
  });
  assert.equal(other.messages().length, 3);
});
