import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkRagAccess,
  type ILogger,
  InMemoryRag,
  type IRagEditor,
  type IRagProvider,
  type LogEvent,
  type RagCollectionRecord,
  RagError,
  SimpleRagProviderRegistry,
  SimpleRagRegistry,
} from '@mcp-abap-adt/llm-agent';
import { testRagAccess } from '@mcp-abap-adt/llm-agent/testing/rag-access-testing';
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import { makeLlm } from '@mcp-abap-adt/llm-agent-libs/testing';
import { unwrapBuilderResult } from '../../../../../llm-agent-libs/src/builder-types.js';
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
  globals.register('documents', tools, undefined, {
    displayName: 'documents',
    scope: 'global',
  });
  globals.register('private', new InMemoryRag(), undefined, {
    displayName: 'private',
    scope: 'user',
    userId: 'alice',
  });
  const reg = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'alice', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: false },
    identity: { sessionId: 'S', userId: 'alice' },
    globals,
  });
  assert.equal(
    reg.get('documents', 'global'),
    tools,
    'the same instance, not a copy',
  );
  assert.equal(
    reg.get('private', 'user'),
    undefined,
    'a user entry in the deployment registry belongs to one caller and is not seeded',
  );
  assert.equal(
    reg.list().find((m) => m.name === 'documents')?.providerName,
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
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'alice', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: false },
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

test('a caller with another userId gets no user collection', async () => {
  const pg = catalogued('pg', records);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const reg = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S', userId: 'test-user' },
    globals: new SimpleRagRegistry(),
    providers,
  });
  assert.equal(
    reg.list().some((m) => m.scope === 'user'),
    false,
  );
});

test('reports rejected catalog rows and a failed catalog read, and carries on', async () => {
  const bad = catalogued('bad', []);
  (bad.provider as { describeCollections: unknown }).describeCollections =
    async () => ({
      ok: false,
      error: new RagError('catalog unreachable'),
    });
  const pg = catalogued('pg', records.slice(0, 1), [
    { storeName: 'junk_0000000009', reason: 'no scope' },
    { reason: 'no store name' },
  ]);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(bad.provider);
  providers.registerProvider(pg.provider);
  const { log, messages } = logger();
  const reg = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S', userId: 'test-user' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log,
  });
  assert.ok(reg.get('kb', 'global'), 'the healthy provider still hydrated');
  const all = messages().join('\n');
  assert.match(all, /catalog unreachable/);
  assert.match(all, /junk_0000000009.*no scope/);
  assert.match(all, /no store name/);
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
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S', userId: 'test-user' },
    globals,
    providers,
    logger: log,
  });
  assert.equal(reg.get('kb', 'global'), configured);
  assert.deepEqual(pg.opened, []);
  assert.match(messages().join('\n'), /kb/);
});

test('a provider whose describeCollections throws, and a record whose openCollection throws, are logged and hydration continues', async () => {
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
  providers.registerProvider(throwing);
  providers.registerProvider(pg.provider);
  const { log, messages } = logger();
  const reg = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'alice', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: false },
    identity: { sessionId: 'S', userId: 'alice' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log,
  });
  assert.ok(
    reg.get('kb', 'global'),
    'a healthy provider and a healthy record still hydrate',
  );
  assert.equal(
    reg.get('mine', 'user'),
    undefined,
    'a record whose openCollection threw is not adopted',
  );
  const all = messages().join('\n');
  assert.match(all, /throwing/);
  assert.match(all, /describe boom/);
  assert.match(all, /mine_00000000002/);
  assert.match(all, /open boom/);
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
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S', userId: 'test-user' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log,
  });
  assert.equal(reg.list().length, 0);
  assert.deepEqual(messages(), []);
});

test('the circuit-breaker fallback-wrap on one session’s registry never mutates the globals registry or another session’s registry', async () => {
  // B26 concern: SmartAgentBuilder.build() wraps every RAG store with
  // FallbackRag and, for a SimpleRagRegistry, swaps the handle in place via
  // `replaceRag` (builder.ts) — it never re-registers, so it never touches
  // ANOTHER registry's entries. buildSessionRagRegistry gives every session
  // its OWN SimpleRagRegistry, seeding a global by `register()`-ing a NEW
  // entry that shares only the underlying IRag instance, not the deployment
  // registry's own entry object. So session A's circuit-breaker wrap (a real
  // build, not a mock) must be invisible to the deployment registry and to
  // session B's separately-built registry.
  const globals = new SimpleRagRegistry();
  const originalKb = new InMemoryRag();
  globals.register('kb', originalKb, undefined, {
    displayName: 'kb',
    scope: 'global',
  });

  const regA = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'A', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'A', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'A', userId: 'test-user' },
    globals,
  });
  const regB = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'B', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'B', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'B', userId: 'test-user' },
    globals,
  });

  const handleA = await new SmartAgentBuilder({})
    .withRagAccess(testRagAccess())
    .withMainLlm(makeLlm([{ content: 'ok' }]))
    .setRagRegistry(regA)
    .withCircuitBreaker()
    .build()
    .then(unwrapBuilderResult);
  try {
    // Positive control: session A's own registry IS wrapped — otherwise this
    // test would pass even if isolation were silently broken by the wrap
    // never running.
    assert.notEqual(
      regA.get('kb', 'global'),
      originalKb,
      'the circuit breaker wrapped session A’s own handle',
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
    ragAccess: testRagAccess([
      { sessionId: 'S1', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S1', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S1', userId: 'test-user' },
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
    ragAccess: testRagAccess([
      { sessionId: 'S2', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S2', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S2', userId: 'test-user' },
    globals,
    providers,
    logger: second.log,
    reported,
  });
  assert.deepEqual(second.messages(), [], 'the same rows again: nothing new');

  // A server of its own (its own set) reports them again: nothing is module-global.
  const other = logger();
  await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S3', userId: 'test-user', isAdmin: false },
    ]),
    caller: { sessionId: 'S3', userId: 'test-user', isAdmin: false },
    identity: { sessionId: 'S3', userId: 'test-user' },
    globals,
    providers,
    logger: other.log,
    reported: new Set<string>(),
  });
  assert.equal(other.messages().length, 3);
});

test('hydration skips reserved catalog records and reports their refusal', async () => {
  const pg = catalogued(
    'pg',
    ['history', 'tools'].map((name) => ({
      name,
      storeName: `stored_${name}`,
      scope: 'global',
    })),
  );
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const log = logger();
  const registry = await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'alice', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: false },
    identity: { sessionId: 'S', userId: 'alice' },
    globals: new SimpleRagRegistry(),
    providers,
    logger: log.log,
  });
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(pg.opened, []);
  for (const name of ['history', 'tools']) {
    assert.ok(
      log
        .messages()
        .some(
          (message) => message.includes(name) && message.includes('reserved'),
        ),
    );
  }
});

test('role revoke hides a collection in the same session and a missing role is reported once', async () => {
  const access = testRagAccess([
    { sessionId: 's1', userId: 'u1', isAdmin: false },
  ]);
  await access.roleAdmin.createRole({ roleId: 'r', name: 'Readers' });
  await access.roleAdmin.assign('u1', 'r');
  await access.roleAdmin.bindCollection('role-docs', 'r');
  const pg = catalogued('pg', [
    {
      name: 'role-docs',
      storeName: 'role-store',
      scope: 'user',
      userId: 'owner',
    },
    { name: 'orphan', storeName: 'gone-store', scope: 'user', userId: 'other' },
  ]);
  const providers = new SimpleRagProviderRegistry();
  providers.registerProvider(pg.provider);
  const logs = logger();
  const input = {
    identity: { sessionId: 's1', userId: 'u1' },
    caller: { sessionId: 's1', userId: 'u1', isAdmin: false },
    ragAccess: access,
    globals: new SimpleRagRegistry(),
    providers,
    logger: logs.log,
    reported: new Set<string>(),
  };
  const registry = await buildSessionRagRegistry(input);
  assert.equal(
    registry.list().some((row) => row.name === 'role-docs'),
    true,
  );
  assert.equal(
    registry.list().some((row) => row.name === 'orphan'),
    false,
  );
  await access.roleAdmin.revoke('u1', 'r');
  await buildSessionRagRegistry({
    ragAccess: testRagAccess([
      { sessionId: 'S', userId: 'alice', isAdmin: false },
    ]),
    caller: { sessionId: 'S', userId: 'alice', isAdmin: false },
    ...input,
    registry,
  });
  assert.equal(
    registry.list().some((row) => row.name === 'role-docs'),
    false,
  );
  const allowed = await checkRagAccess(
    input.caller,
    { name: 'role-docs', owner: { scope: 'user', userId: 'owner' } },
    'read',
    access,
  );
  assert.equal(allowed.ok, false);
  assert.equal(
    logs.messages().filter((message) => message.includes('gone')).length,
    0,
  );
});
