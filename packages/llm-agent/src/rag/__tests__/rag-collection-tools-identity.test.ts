import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type {
  IRagEditor,
  IRagRegistry,
  RagCollectionMeta,
  RagCollectionOwner,
  RagJsonValue,
} from '../../interfaces/rag.js';
import { RagError } from '../../interfaces/types.js';
import { testRagAccess } from '../../testing/rag-access-testing.js';
import {
  AmbiguousCollectionError,
  CatalogRecordDeleteError,
} from '../corrections/errors.js';
import { InMemoryRag } from '../in-memory-rag.js';
import {
  buildRagCollectionToolEntries,
  type RagCollectionToolOptions,
} from '../mcp-tools/rag-collection-tools.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';
import { DirectEditStrategy } from '../strategies/edit/index.js';
import { GlobalUniqueIdStrategy } from '../strategies/id/index.js';

const ALICE = { sessionId: 'S', userId: 'alice', isAdmin: false };

function editable() {
  const rag = new InMemoryRag();
  return {
    rag,
    editor: new DirectEditStrategy(rag.writer(), new GlobalUniqueIdStrategy()),
  };
}

/** alice's session and user collections, bob's, another session's, and two globals. */
function world() {
  const reg = new SimpleRagRegistry();
  const providers = new SimpleRagProviderRegistry();
  // 'user' as well as the provider's session-only default: several fixtures
  // below create user-scoped collections through it.
  providers.registerProvider(
    new InMemoryRagProvider({
      name: 'mem',
      supportedScopes: ['session', 'user'],
    }),
  );
  reg.setProviderRegistry(providers);
  const add = (
    name: string,
    meta: Omit<RagCollectionMeta, 'name' | 'editable' | 'displayName'>,
  ) => {
    const { rag, editor } = editable();
    reg.register(name, rag, editor, { displayName: name, ...meta });
  };
  add('docs', { scope: 'global' });
  add('docs', { scope: 'user', userId: 'alice' });
  add('docs', { scope: 'session', sessionId: 'S' });
  add('open', { scope: 'global' });
  add('mine', { scope: 'user', userId: 'alice' });
  add('theirs', { scope: 'user', userId: 'bob' });
  add('elsewhere', { scope: 'session', sessionId: 'T' });
  return { reg, providers };
}

function tools(
  reg: IRagRegistry,
  extra: Partial<RagCollectionToolOptions> = {},
) {
  const entries = buildRagCollectionToolEntries({
    registry: reg,
    caller: ALICE,
    access: testRagAccess(),
    ...extra,
  });
  return (name: string) => {
    const e = entries.find((t) => t.toolDefinition.name === name);
    assert.ok(e, name);
    return e;
  };
}

type Answer = {
  ok: boolean;
  error?: string;
  code?: string;
  warning?: string;
  id?: string;
  meta?: {
    name: string;
    scope?: string;
    sessionId?: string;
    userId?: string;
  };
  collections?: Array<{ name: string; scope?: string }>;
};

describe('the address space is the bound caller’s', () => {
  it('lists its own collections and the globals — another caller’s are absent', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_list_collections').handler(
      {},
      {},
    )) as Answer;
    const seen = (out.collections ?? [])
      .map((c) => `${c.scope}:${c.name}`)
      .sort();
    assert.deepEqual(seen, [
      'global:docs',
      'global:open',
      'session:docs',
      'user:docs',
      'user:mine',
    ]);
  });

  it('describes another caller’s collection as not found, not as refused', async () => {
    const { reg } = world();
    for (const name of ['theirs', 'elsewhere']) {
      const out = (await tools(reg)('rag_describe_collection').handler(
        {},
        { name },
      )) as Answer;
      assert.equal(out.ok, false);
      assert.match(out.error ?? '', /not found/);
    }
  });

  it('ignores identity passed per call', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_describe_collection').handler(
      { sessionId: 'T', userId: 'bob' },
      { name: 'theirs' },
    )) as Answer;
    assert.equal(out.ok, false, 'a per-call identity is not a channel');
  });

  it('an explicit scope does not reach another caller’s collection either', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_describe_collection').handler(
      {},
      { name: 'theirs', scope: 'user' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /not found/);
  });

  it('a write tool cannot reach another caller’s collection: not found, not refused', async () => {
    const { reg } = world();
    for (const name of ['theirs', 'elsewhere']) {
      const out = (await tools(reg)('rag_add').handler(
        {},
        { collection: name, text: 't', canonicalKey: 'k' },
      )) as Answer;
      assert.equal(out.ok, false);
      assert.match(out.error ?? '', /not found/);
    }
  });

  it('hides all collections from a caller with an empty userId', async () => {
    const { reg } = world();
    const entries = buildRagCollectionToolEntries({
      registry: reg,
      caller: { sessionId: 'S', userId: '', isAdmin: false },
      access: testRagAccess(),
    });
    const list = entries.find(
      (e) => e.toolDefinition.name === 'rag_list_collections',
    );
    assert.ok(list);
    const out = (await list.handler({}, {})) as Answer;
    const seen = (out.collections ?? [])
      .map((c) => `${c.scope}:${c.name}`)
      .sort();
    assert.deepEqual(seen, []);
  });
});

describe('a name several scopes hold needs a scope', () => {
  it('refuses an ambiguous name with RAG_AMBIGUOUS_COLLECTION naming the scopes', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_describe_collection').handler(
      {},
      { name: 'docs' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'RAG_AMBIGUOUS_COLLECTION');
    assert.match(out.error ?? '', /global/);
    assert.match(out.error ?? '', /user/);
    assert.match(out.error ?? '', /session/);
  });

  it('resolves the one the scope names', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_describe_collection').handler(
      {},
      { name: 'docs', scope: 'user' },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.equal(out.meta?.scope, 'user');
    assert.equal(out.meta?.userId, 'alice');
  });

  it('rag_add writes the scope it names, and only that one', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_add').handler(
      {},
      { collection: 'docs', scope: 'session', text: 't', canonicalKey: 'k' },
    )) as Answer;
    assert.equal(out.ok, true);
    const id = out.id as string;
    assert.ok(id, 'the add tool returns the written id');
    const sessionHit = await reg.get('docs', 'session')?.getById(id);
    assert.ok(
      sessionHit?.ok && sessionHit.value,
      'written to the session collection it named',
    );
    const userHit = await reg.get('docs', 'user')?.getById(id);
    assert.ok(
      userHit?.ok && userHit.value === null,
      'not written to the user collection of the same name',
    );
    const globalHit = await reg.get('docs', 'global')?.getById(id);
    assert.ok(
      globalHit?.ok && globalHit.value === null,
      'not written to the global collection of the same name',
    );
  });

  it('rag_delete_collection deletes the scope it names and leaves the others', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_delete_collection').handler(
      {},
      { name: 'docs', scope: 'session' },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.equal(reg.get('docs', 'session'), undefined);
    assert.ok(reg.get('docs', 'user'));
    assert.ok(reg.get('docs', 'global'));
  });

  it('rag_delete_collection without a scope on an ambiguous name answers RAG_AMBIGUOUS_COLLECTION', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_delete_collection').handler(
      {},
      { name: 'docs' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'RAG_AMBIGUOUS_COLLECTION');
    assert.ok(
      reg.get('docs', 'session'),
      'ambiguity refuses, it does not pick one to delete',
    );
  });
});

describe('non-admin collection tools refuse global writes', () => {
  for (const [name, args] of [
    ['rag_add', { collection: 'open', text: 't', canonicalKey: 'k' }],
    [
      'rag_correct',
      {
        collection: 'open',
        predecessorId: '1',
        predecessorCanonicalKey: 'k',
        newText: 't',
        reason: 'r',
      },
    ],
    [
      'rag_deprecate',
      { collection: 'open', id: '1', canonicalKey: 'k', reason: 'r' },
    ],
  ] as const) {
    it(`${name} refuses a global and writes nothing to its store`, async () => {
      const { reg } = world();
      const out = (await tools(reg)(name).handler({}, args)) as Answer;
      assert.equal(out.ok, false);
      assert.match(out.error ?? '', /RagAccessDeniedError/);
      const store = reg.get('open', 'global');
      assert.ok(store);
      const hits = await store?.query(
        { text: 't', toVector: async () => [] },
        10,
      );
      assert.deepEqual(
        hits,
        { ok: true, value: [] },
        'the global store is still empty',
      );
    });
  }

  it('rag_delete_collection refuses a global, leaving it registered', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_delete_collection').handler(
      {},
      { name: 'open' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.match(out.error ?? '', /RagAccessDeniedError/);
    assert.ok(reg.get('open', 'global'), 'still registered — not removed');
  });

  it('describes a global — it is readable because the consumer put it there', async () => {
    const { reg } = world();
    const out = (await tools(reg)('rag_describe_collection').handler(
      {},
      { name: 'open' },
    )) as Answer;
    assert.equal(out.ok, true);
  });
});

describe('rag_create_collection', () => {
  function spied() {
    const { reg, providers } = world();
    const calls: Array<Record<string, RagJsonValue | undefined>> = [];
    const original = reg.createCollection.bind(reg);
    reg.createCollection = async (p) => {
      calls.push({ ...p });
      return original(p);
    };
    return { reg, providers, calls };
  }

  it('takes the owner from the BOUND identity, whatever the call context says', async () => {
    const { reg, providers, calls } = spied();
    const out = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler(
      { sessionId: 'T', userId: 'bob' },
      { provider: 'mem', name: 'fresh', scope: 'user' },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.equal(calls[0].scope, 'user');
    assert.equal(calls[0].userId, 'alice');
    assert.equal('sessionId' in calls[0], false);
  });

  it('creates a session collection for the bound session', async () => {
    const { reg, providers, calls } = spied();
    const out = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler(
      {},
      { provider: 'mem', name: 'scratch', scope: 'session' },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.equal(calls[0].sessionId, 'S');
  });

  it('refuses global — creating one would put it in every caller’s address space', async () => {
    const { reg, providers, calls } = spied();
    const entries = buildRagCollectionToolEntries({
      registry: reg,
      caller: ALICE,
      access: testRagAccess(),
      providerRegistry: providers,
    });
    const create = entries.find(
      (e) => e.toolDefinition.name === 'rag_create_collection',
    );
    assert.ok(create);
    assert.equal(
      z
        .object(create.toolDefinition.inputSchema)
        .safeParse({ provider: 'mem', name: 'g', scope: 'global' }).success,
      true,
    );
    const out = (await create.handler(
      {},
      { provider: 'mem', name: 'g', scope: 'global' },
    )) as Answer;
    assert.equal(out.ok, false, 'refused even when the schema was not applied');
    assert.deepEqual(calls, []);
  });

  it('refuses a user collection for a caller with no userId, before the registry', async () => {
    const { reg, providers, calls } = spied();
    const entries = buildRagCollectionToolEntries({
      registry: reg,
      caller: { sessionId: 'S', userId: '', isAdmin: false },
      access: testRagAccess(),
      providerRegistry: providers,
    });
    const create = entries.find(
      (e) => e.toolDefinition.name === 'rag_create_collection',
    );
    assert.ok(create);
    const out = (await create.handler(
      {},
      { provider: 'mem', name: 'u', scope: 'user' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.deepEqual(calls, []);
  });

  it('records what attributesFor returns, called with the name and the owner', async () => {
    const { reg, providers, calls } = spied();
    const seen: Array<{ name: string } & RagCollectionOwner> = [];
    const out = (await tools(reg, {
      providerRegistry: providers,
      attributesFor: (created) => {
        seen.push(created);
        return { authorization: 'owner' };
      },
    })('rag_create_collection').handler(
      {},
      {
        provider: 'mem',
        name: 'fresh',
        scope: 'user',
        attributes: { authorization: 'public' },
      },
    )) as Answer;
    // The test fails if the create itself failed: a spy on
    // reg.createCollection records its call arguments unconditionally, so
    // calls[0] alone cannot tell a successful create from a refused one.
    assert.equal(out.ok, true);
    assert.equal(out.meta?.name, 'fresh');
    assert.equal(out.meta?.scope, 'user');
    assert.equal(out.meta?.userId, 'alice');
    assert.deepEqual(seen, [{ name: 'fresh', scope: 'user', userId: 'alice' }]);
    // RagCollectionMeta (what `out.meta` and reg.list()/get() expose) carries
    // no `attributes` field by design (interfaces/rag.ts, createUnder in
    // simple-rag-registry.ts) — attributes are forwarded to the provider only,
    // and InMemoryRagProvider keeps no catalog to read them back from. The
    // registry's own tests verify this same forwarding the same way
    // (simple-rag-registry-lifecycle.test.ts): via the create call's
    // arguments, which is what will be stored.
    assert.deepEqual(
      calls[0].attributes,
      { authorization: 'owner' },
      'the consumer’s value, never the model’s',
    );
  });

  it('passes no attributes when there is no callback', async () => {
    const { reg, providers, calls } = spied();
    const out = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler(
      {},
      {
        provider: 'mem',
        name: 'fresh',
        scope: 'session',
        attributes: { x: 1 },
      },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.equal('attributes' in calls[0], false);
  });

  it('returns the registry’s code for a taken name', async () => {
    const { reg, providers } = spied();
    const out = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler({}, { provider: 'mem', name: 'mine', scope: 'user' })) as Answer;
    assert.equal(out.ok, false);
    assert.equal(out.code, 'RAG_DUPLICATE_COLLECTION');
  });
});

describe('rag_delete_collection reports the two phases apart', () => {
  function withDelete(error: CatalogRecordDeleteError) {
    const reg = new SimpleRagRegistry();
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider({
      name: 'stub',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session'],
      createCollection: async () => ({
        ok: true,
        value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
      }),
      deleteCollection: async () => ({ ok: false, error }),
    });
    reg.setProviderRegistry(providers);
    return reg;
  }

  it('answers ok:false for a record failure, and the collection is still there', async () => {
    const reg = withDelete(
      new CatalogRecordDeleteError('s', 'catalog write refused'),
    );
    assert.ok(
      (
        await reg.createCollection({
          providerName: 'stub',
          collectionName: 's',
          scope: 'session',
          sessionId: 'S',
        })
      ).ok,
    );
    const out = (await tools(reg)('rag_delete_collection').handler(
      {},
      { name: 's' },
    )) as Answer;
    assert.equal(out.ok, false);
    assert.equal(out.warning, undefined, 'not reported as data loss');
    assert.ok(
      reg.get('s', 'session'),
      'restored, so the same call can be retried',
    );
  });
});

describe('role and global collection access', () => {
  it('A user collection docs and a role collection docs with the caller assigned to the role return AmbiguousCollectionError', async () => {
    const reg = new SimpleRagRegistry();
    const user = editable();
    const role = editable();
    reg.register('docs', user.rag, user.editor, {
      displayName: 'User',
      scope: 'user',
      userId: 'alice',
    });
    reg.register('docs', role.rag, role.editor, {
      displayName: 'Role',
      scope: 'role',
      roleId: 'team',
    });
    const access = testRagAccess();
    assert.ok(
      (await access.roles.createRole({ roleId: 'team', name: 'Team' })).ok,
    );
    assert.ok((await access.roles.assign('alice', 'team')).ok);
    const describe = tools(reg, { access })('rag_describe_collection');
    const result = (await describe.handler({}, { name: 'docs' })) as Answer;
    assert.equal(result.code, 'RAG_AMBIGUOUS_COLLECTION');
    assert.match(result.error ?? '', /AmbiguousCollectionError/);
    assert.equal(
      (
        (await describe.handler(
          {},
          { name: 'docs', scope: 'role', roleId: 'other' },
        )) as Answer
      ).ok,
      true,
    );
    assert.ok((await access.roles.revoke('alice', 'team')).ok);
    const after = (await describe.handler({}, { name: 'docs' })) as Answer;
    assert.equal(after.ok, true);
    assert.equal(after.meta?.scope, 'user');
    assert.equal(
      (
        (await describe.handler(
          {},
          { name: 'docs', scope: 'role', roleId: 'team' },
        )) as Answer
      ).ok,
      false,
    );
  });

  it('A sessionId, userId or roleId passed in tool args never changes the owner used', async () => {
    const { reg, providers } = world();
    const out = (await tools(reg)('rag_add').handler(
      {},
      {
        collection: 'docs',
        scope: 'session',
        text: 'own',
        canonicalKey: 'key',
        sessionId: 'other',
        userId: 'bob',
        roleId: 'other',
      },
    )) as Answer;
    assert.equal(out.ok, true);
    assert.ok(out.id);
    const stored = await reg.get('docs', 'session')?.getById(out.id);
    assert.ok(stored?.ok && stored.value);
    const created = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler(
      {},
      {
        provider: 'mem',
        name: 'own',
        scope: 'session',
        sessionId: 'other',
        userId: 'bob',
        roleId: 'other',
      },
    )) as Answer;
    assert.equal(created.meta?.sessionId, 'S');
    const role = (await tools(reg, { providerRegistry: providers })(
      'rag_create_collection',
    ).handler(
      {},
      { provider: 'mem', name: 'stolen', scope: 'role', roleId: 'other' },
    )) as Answer;
    assert.equal(role.ok, false);
    assert.equal(reg.get('stolen', 'role'), undefined);
  });

  it('A global rag_add by a non-admin is refused; by an admin it succeeds', async () => {
    const { reg } = world();
    const args = { collection: 'open', text: 'global', canonicalKey: 'key' };
    const denied = (await tools(reg)('rag_add').handler({}, args)) as Answer;
    assert.equal(denied.code, 'RAG_ACCESS_DENIED');
    const allowed = (await tools(reg, { caller: { ...ALICE, isAdmin: true } })(
      'rag_add',
    ).handler({}, args)) as Answer;
    assert.equal(allowed.ok, true);
    assert.ok(allowed.id);
    const hit = await reg.get('open', 'global')?.getById(allowed.id);
    assert.ok(hit?.ok && hit.value);
    const access = testRagAccess();
    access.decision.canWrite = async () => false;
    const adminDenied = (await tools(reg, {
      caller: { ...ALICE, isAdmin: true },
      access,
    })('rag_add').handler({}, args)) as Answer;
    assert.equal(adminDenied.code, 'RAG_ACCESS_DENIED');
  });

  it('admin creation and deletion of globals still require the decision', async () => {
    const { reg, providers } = world();
    providers.registerProvider(
      new InMemoryRagProvider({
        name: 'global-mem',
        supportedScopes: ['global'],
      }),
    );
    const access = testRagAccess();
    const entries = tools(reg, {
      caller: { ...ALICE, isAdmin: true },
      access,
      providerRegistry: providers,
    });
    access.decision.canWrite = async () => false;
    const args = { provider: 'global-mem', name: 'created', scope: 'global' };
    assert.equal(
      ((await entries('rag_create_collection').handler({}, args)) as Answer).ok,
      false,
    );
    assert.equal(reg.get('created', 'global'), undefined);
    access.decision.canWrite = async () => true;
    assert.equal(
      ((await entries('rag_create_collection').handler({}, args)) as Answer).ok,
      true,
    );
    assert.equal(
      (
        (await entries('rag_delete_collection').handler(
          {},
          { name: 'created' },
        )) as Answer
      ).ok,
      true,
    );
    assert.equal(reg.get('created', 'global'), undefined);
  });
});

it('role creation requires an admin, assignment and server permission', async () => {
  const { reg, providers } = world();
  const provider = new InMemoryRagProvider({
    name: 'role-mem',
    supportedScopes: ['role'],
  });
  providers.registerProvider(provider);
  const access = {
    ...testRagAccess(),
    roles: provider.roles,
    bindings: provider.bindings,
  };
  assert.ok(
    (await access.roles.createRole({ roleId: 'team', name: 'Team' })).ok,
  );
  assert.ok((await access.roles.assign('alice', 'team')).ok);
  const args = {
    provider: 'role-mem',
    name: 'team-docs',
    scope: 'role',
    roleId: 'team',
  };
  const denied = (await tools(reg, { access, providerRegistry: providers })(
    'rag_create_collection',
  ).handler({}, args)) as Answer;
  assert.equal(denied.code, 'RAG_ACCESS_DENIED');
  assert.equal(reg.get('team-docs', 'role'), undefined);
  const allowed = (await tools(reg, {
    caller: { ...ALICE, isAdmin: true },
    access,
    providerRegistry: providers,
  })('rag_create_collection').handler({}, args)) as Answer;
  assert.equal(allowed.ok, true);
});

describe('owner-exact role mutations regression', () => {
  async function setup() {
    const reg = new SimpleRagRegistry();
    const providers = new SimpleRagProviderRegistry();
    reg.setProviderRegistry(providers);
    const a = editable();
    const b = editable();
    for (const [roleId, store] of [
      ['A', a],
      ['B', b],
    ] as const) {
      providers.registerProvider({
        name: roleId,
        kind: 'vector',
        editable: true,
        supportedScopes: ['role'],
        createCollection: async () => ({ ok: true, value: store }),
        deleteCollection: async () => {
          const writer = store.rag.writer();
          assert.ok(writer.clearAll);
          return writer.clearAll();
        },
      });
      reg.register('docs', store.rag, store.editor, {
        displayName: 'docs',
        scope: 'role',
        roleId,
        providerName: roleId,
      });
      await store.editor.upsert('original', {
        id: 'original',
        canonicalKey: 'original',
      });
    }
    const access = testRagAccess();
    assert.ok((await access.roles.createRole({ roleId: 'A', name: 'A' })).ok);
    assert.ok((await access.roles.assign('alice', 'A')).ok);
    return { reg, a, b, tool: tools(reg, { access }) };
  }

  for (const operation of ['rag_add', 'rag_correct', 'rag_deprecate']) {
    it(`${operation} writes only to the authorized role with a duplicate name`, async () => {
      const { a, b, tool } = await setup();
      const beforeA = await a.rag.list();
      const beforeB = await b.rag.list();
      const out = (await tool(operation).handler(
        {},
        {
          collection: 'docs',
          scope: 'role',
          text: 'added',
          canonicalKey: 'original',
          predecessorId: 'original',
          predecessorCanonicalKey: 'original',
          newText: 'corrected',
          id: 'original',
          reason: 'test',
        },
      )) as Answer;
      assert.equal(out.ok, true);
      assert.notDeepEqual(await a.rag.list(), beforeA);
      assert.deepEqual(await b.rag.list(), beforeB);
    });
  }

  it('deletes only the authorized role collection without warning', async () => {
    const { reg, a, b, tool } = await setup();
    const beforeB = await b.rag.list();
    const out = (await tool('rag_delete_collection').handler(
      {},
      { name: 'docs', scope: 'role' },
    )) as Answer;
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(
      reg.list().map((meta) => meta.roleId),
      ['B'],
    );
    const remainingA = await a.rag.list();
    assert.ok(remainingA.ok);
    assert.equal(remainingA.value.records.length, 0);
    assert.deepEqual(await b.rag.list(), beforeB);
  });

  for (const error of [
    new AmbiguousCollectionError('docs', ['role']),
    new RagError('unexpected', 'UNEXPECTED'),
  ]) {
    it(`delete refuses ${error.name} instead of claiming removal`, async () => {
      class RefusingRegistry extends SimpleRagRegistry {
        override async deleteCollection() {
          return { ok: false as const, error };
        }
      }
      const reg = new RefusingRegistry();
      const store = editable();
      reg.register('docs', store.rag, store.editor, {
        displayName: 'docs',
        scope: 'session',
        sessionId: 'S',
      });
      const out = (await tools(reg)('rag_delete_collection').handler(
        {},
        { name: 'docs' },
      )) as Answer;
      assert.equal(out.ok, false);
      assert.equal(out.code, error.code);
      assert.equal(out.error, error.message);
      assert.equal(out.warning, undefined);
      assert.equal(reg.list().length, 1);
    });
  }
});

describe('owner-exact registry addressing regression', () => {
  it('narrows every name-addressed method and preserves ownerless ambiguity', async () => {
    const reg = new SimpleRagRegistry();
    const a = new InMemoryRag();
    const b = new InMemoryRag();
    const editorA = new DirectEditStrategy(
      a.writer(),
      new GlobalUniqueIdStrategy(),
    );
    const editorB = new DirectEditStrategy(
      b.writer(),
      new GlobalUniqueIdStrategy(),
    );
    const ownerA = { scope: 'role', roleId: 'A' } as const;
    const ownerB = { scope: 'role', roleId: 'B' } as const;
    reg.register('docs', a, editorA, { displayName: 'docs', ...ownerA });
    reg.register('docs', b, editorB, { displayName: 'docs', ...ownerB });
    assert.throws(() => reg.get('docs', 'role'), AmbiguousCollectionError);
    assert.throws(
      () => reg.getEditor('docs', 'role'),
      AmbiguousCollectionError,
    );
    assert.throws(
      () => reg.unregister('docs', 'role'),
      AmbiguousCollectionError,
    );
    assert.throws(
      () => reg.replaceRag('docs', 'role', a),
      AmbiguousCollectionError,
    );
    const refused = await reg.deleteCollection('docs', 'role');
    assert.ok(!refused.ok && refused.error instanceof AmbiguousCollectionError);
    assert.equal(reg.get('docs', 'role', ownerA), a);
    assert.equal(reg.getEditor('docs', 'role', ownerB), editorB);
    assert.equal(
      reg.get('docs', 'role', { scope: 'role', roleId: 'absent' }),
      undefined,
    );
    assert.equal(reg.get('docs', 'user', ownerA), undefined);
    const replacement = new InMemoryRag();
    assert.equal(reg.replaceRag('docs', 'role', replacement, ownerA), true);
    assert.equal(reg.get('docs', 'role', ownerA), replacement);
    assert.equal(reg.get('docs', 'role', ownerB), b);
    assert.ok((await reg.deleteCollection('docs', 'role', ownerA)).ok);
    assert.equal(reg.get('docs', 'role', ownerA), undefined);
    assert.equal(reg.get('docs', 'role'), b);
    assert.equal(reg.unregister('docs', 'role', ownerA), false);
    assert.equal(reg.unregister('docs', 'role', ownerB), true);
  });
});
