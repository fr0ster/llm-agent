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
    access: testRagAccess([ALICE]),
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
      access: testRagAccess([ALICE]),
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
      access: testRagAccess([ALICE]),
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
      access: testRagAccess([ALICE]),
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

describe('collections shared through bound roles', () => {
  it('authorizes a foreign user collection and applies unbinding immediately', async () => {
    const reg = new SimpleRagRegistry();
    const store = editable();
    reg.register('shared', store.rag, store.editor, {
      displayName: 'Shared',
      scope: 'user',
      userId: 'owner',
    });
    const access = testRagAccess([ALICE]);
    assert.ok(
      (
        await access.roleAdmin.createRole({
          roleId: 'readers',
          name: 'Readers',
        })
      ).ok,
    );
    assert.ok((await access.roleAdmin.assign(ALICE.userId, 'readers')).ok);
    assert.ok((await access.roleAdmin.bindCollection('shared', 'readers')).ok);
    const describe = tools(reg, { access })('rag_describe_collection');
    assert.equal(
      ((await describe.handler({}, { name: 'shared' })) as Answer).ok,
      true,
    );
    assert.ok(
      (await access.roleAdmin.unbindCollection('shared', 'readers')).ok,
    );
    assert.equal(
      ((await describe.handler({}, { name: 'shared' })) as Answer).ok,
      false,
    );
  });
});

describe('tool argument identity and global authorization', () => {
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
    const access = testRagAccess([ALICE]);
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
    const access = testRagAccess([ALICE]);
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
    access.decision.canWrite = async () => false;
    assert.equal(
      (
        (await entries('rag_delete_collection').handler(
          {},
          { name: 'created' },
        )) as Answer
      ).ok,
      false,
    );
    assert.ok(reg.get('created', 'global'));
    access.decision.canWrite = async () => true;
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

describe('shared user collection delete errors', () => {
  for (const error of [
    new AmbiguousCollectionError('docs', ['user']),
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
        scope: 'user',
        userId: 'owner',
      });
      const access = testRagAccess([ALICE]);
      assert.ok(
        (
          await access.roleAdmin.createRole({
            roleId: 'reader',
            name: 'Reader',
          })
        ).ok,
      );
      assert.ok((await access.roleAdmin.assign(ALICE.userId, 'reader')).ok);
      assert.ok((await access.roleAdmin.bindCollection('docs', 'reader')).ok);
      const out = (await tools(reg, { access })(
        'rag_delete_collection',
      ).handler({}, { name: 'docs' })) as Answer;
      assert.equal(out.ok, false);
      assert.equal(out.code, error.code);
      assert.equal(out.error, error.message);
      assert.equal(out.warning, undefined);
      assert.equal(reg.list().length, 1);
    });
  }
});
