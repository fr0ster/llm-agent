// packages/llm-agent/src/rag/__tests__/catalog-validation.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRagEditor,
  IRagProvider,
  RagProviderCreateCollectionOptions,
} from '@mcp-abap-adt/llm-agent';
import {
  AmbiguousCollectionError,
  CatalogRecordDeleteError,
  DuplicateCollectionError,
  describeRagCatalogRows,
  encodeRagAttributes,
  InvalidAttributesError,
  InvalidOwnerError,
  OrphanStoreError,
  parseRagCollectionRecord,
  RagError,
  ReservedCollectionNameError,
  ragOwnerKeys,
  validateRagAttributes,
  validateRagOwner,
} from '@mcp-abap-adt/llm-agent';
import { InMemoryRag } from '../in-memory-rag.js';
import { InMemoryRagProvider } from '../providers/in-memory-rag-provider.js';
import { SimpleRagProviderRegistry } from '../providers/simple-provider-registry.js';
import { SimpleRagRegistry } from '../registry/simple-rag-registry.js';

describe('validateRagAttributes', () => {
  it('accepts JSON, and absent attributes', () => {
    const value = {
      roles: ['a', 'b'],
      level: 2,
      open: false,
      none: null,
      nested: { x: [1, { y: 's' }] },
    };
    assert.deepEqual(validateRagAttributes(value), { ok: true, value });
    assert.deepEqual(validateRagAttributes(undefined), {
      ok: true,
      value: undefined,
    });
  });

  it('accepts one object reached twice, which is not a cycle', () => {
    const shared = { k: 1 };
    assert.equal(validateRagAttributes({ a: shared, b: [shared] }).ok, true);
  });

  it('refuses what JSON would change, naming where it is', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: Array<[unknown, RegExp]> = [
      [{ a: Number.NaN }, /\$\.a is NaN/],
      [{ a: [1, Number.POSITIVE_INFINITY] }, /\$\.a\[1\] is Infinity/],
      [Number.NEGATIVE_INFINITY, /\$ is -Infinity/],
      [cyclic, /\$\.self is a cycle/],
      [{ n: 1n }, /\$\.n is a bigint/],
      [{ f: () => 1 }, /\$\.f is a function/],
      [{ d: new Date(0) }, /\$\.d is a Date instance/],
      [{ u: undefined }, /\$\.u is undefined/],
    ];
    for (const [value, reason] of cases) {
      const res = validateRagAttributes(value);
      assert.equal(res.ok, false);
      assert.ok(!res.ok && res.error instanceof InvalidAttributesError);
      assert.equal(!res.ok && res.error.code, 'RAG_INVALID_ATTRIBUTES');
      assert.match(!res.ok ? res.error.reason : '', reason);
    }
  });
});

describe('validateRagOwner', () => {
  it('returns the owner with only the key its scope selects', () => {
    assert.deepEqual(validateRagOwner({ scope: 'global', userId: 'stray' }), {
      ok: true,
      value: { scope: 'global' },
    });
    assert.deepEqual(
      validateRagOwner({ scope: 'user', userId: 'u', sessionId: 's' }),
      { ok: true, value: { scope: 'user', userId: 'u' } },
    );
    assert.deepEqual(validateRagOwner({ scope: 'session', sessionId: 's' }), {
      ok: true,
      value: { scope: 'session', sessionId: 's' },
    });
  });

  it('refuses a missing or empty key, and a missing or unknown scope', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ scope: 'user' }, /userId/],
      [{ scope: 'user', userId: '' }, /userId/],
      [{ scope: 'session', sessionId: 7 }, /sessionId/],
      [{}, /no scope/],
      [{ scope: 'team' }, /unknown scope 'team'/],
      [null, /no scope/],
    ];
    for (const [input, reason] of cases) {
      const res = validateRagOwner(input);
      assert.ok(!res.ok && res.error instanceof InvalidOwnerError);
      assert.equal(!res.ok && res.error.code, 'RAG_INVALID_OWNER');
      assert.match(!res.ok ? res.error.reason : '', reason);
    }
  });

  it('gives the owner keys back for meta', () => {
    assert.deepEqual(ragOwnerKeys({ scope: 'global' }), {});
    assert.deepEqual(ragOwnerKeys({ scope: 'user', userId: 'u' }), {
      userId: 'u',
    });
    assert.deepEqual(ragOwnerKeys({ scope: 'session', sessionId: 's' }), {
      sessionId: 's',
    });
  });
});

describe('catalog rows', () => {
  it('round-trips attributes through their JSON text, and tells null from absent', () => {
    const row = { storeName: 's_1', name: 'n', scope: 'global' };
    assert.deepEqual(
      parseRagCollectionRecord({ ...row, attributesJson: null }),
      {
        ok: true,
        record: { scope: 'global', storeName: 's_1', name: 'n' },
      },
    );
    assert.deepEqual(
      parseRagCollectionRecord({
        ...row,
        attributesJson: encodeRagAttributes(null),
      }),
      {
        ok: true,
        record: {
          scope: 'global',
          storeName: 's_1',
          name: 'n',
          attributes: null,
        },
      },
    );
    const attributes = { role: 'analyst', levels: [1, 2] };
    assert.deepEqual(
      parseRagCollectionRecord({
        ...row,
        attributesJson: encodeRagAttributes(attributes),
      }),
      {
        ok: true,
        record: { scope: 'global', storeName: 's_1', name: 'n', attributes },
      },
    );
    assert.equal(encodeRagAttributes(undefined), null);
  });

  it('rejects a row that is not a record, keeping its store name where it has one', () => {
    const described = describeRagCatalogRows([
      { storeName: 'ok_1', name: 'ok', scope: 'user', userId: 'u' },
      { name: 'no store', scope: 'global' },
      { storeName: 'no_name_1', scope: 'global' },
      { storeName: 'no_scope_1', name: 'n' },
      { storeName: 'no_user_1', name: 'n', scope: 'user', userId: null },
      { storeName: 'team_1', name: 'n', scope: 'team' },
      {
        storeName: 'bad_json_1',
        name: 'n',
        scope: 'global',
        attributesJson: '{not json',
      },
      { storeName: 'blob_1', name: 'n', scope: 'global', attributesJson: 42 },
    ]);
    assert.deepEqual(described.records, [
      { scope: 'user', userId: 'u', storeName: 'ok_1', name: 'ok' },
    ]);
    assert.deepEqual(
      described.rejected.map((r) => r.storeName),
      [
        undefined,
        'no_name_1',
        'no_scope_1',
        'no_user_1',
        'team_1',
        'bad_json_1',
        'blob_1',
      ],
    );
    const reasons = described.rejected.map((r) => r.reason);
    assert.match(reasons[0], /no store name/);
    assert.match(reasons[1], /no logical name/);
    assert.match(reasons[2], /no scope/);
    assert.match(reasons[3], /userId/);
    assert.match(reasons[4], /unknown scope 'team'/);
    assert.match(reasons[5], /not valid JSON/);
    assert.match(reasons[6], /stored as number/);
  });
});

describe('the named errors', () => {
  it('each is a RagError with its code', () => {
    const cases: Array<[RagError, string]> = [
      [new DuplicateCollectionError('docs'), 'RAG_DUPLICATE_COLLECTION'],
      [new OrphanStoreError('docs_1', 'why'), 'RAG_ORPHAN_STORE'],
      [
        new AmbiguousCollectionError('docs', ['global', 'user']),
        'RAG_AMBIGUOUS_COLLECTION',
      ],
      [
        new CatalogRecordDeleteError('docs_1', 'why'),
        'RAG_CATALOG_RECORD_DELETE',
      ],
      [
        new ReservedCollectionNameError('user/docs', 'user/'),
        'RAG_RESERVED_COLLECTION_NAME',
      ],
    ];
    for (const [error, code] of cases) {
      assert.ok(error instanceof RagError);
      assert.equal(error.code, code);
    }
    assert.equal(new OrphanStoreError('docs_1', 'why').storeName, 'docs_1');
    assert.equal(
      new CatalogRecordDeleteError('docs_1', 'why').storeName,
      'docs_1',
    );
    assert.deepEqual(
      new AmbiguousCollectionError('docs', ['global', 'user']).scopes,
      ['global', 'user'],
    );
    assert.match(new OrphanStoreError('docs_1', 'why').message, /docs_1/);
    assert.equal(
      new ReservedCollectionNameError('user/docs', 'user/').prefix,
      'user/',
    );
    assert.match(
      new ReservedCollectionNameError('user/docs', 'user/').message,
      /user\/docs/,
    );
  });
});

describe('an untyped caller of createCollection', () => {
  it('is refused by an in-memory provider before anything is built', async () => {
    const p = new InMemoryRagProvider({
      name: 'mem',
      supportedScopes: ['session', 'user', 'global'],
    });
    const noKey = await p.createCollection('x', {
      scope: 'session',
    } as unknown as RagProviderCreateCollectionOptions);
    assert.equal(!noKey.ok && noKey.error.code, 'RAG_INVALID_OWNER');
    const nan = await p.createCollection('x', {
      scope: 'global',
      attributes: Number.NaN,
    });
    assert.equal(!nan.ok && nan.error.code, 'RAG_INVALID_ATTRIBUTES');
    const adopt = await p.createCollection('x', {
      scope: 'global',
      adoptExisting: true,
    });
    assert.equal(
      adopt.ok,
      false,
      'an in-memory store never outlives the process, so there is nothing to adopt',
    );
  });

  it('is refused by the registry before its provider is asked', async () => {
    let asked = 0;
    const provider: IRagProvider = {
      name: 'spy',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session', 'user', 'global'],
      createCollection: async () => {
        asked++;
        return {
          ok: true,
          value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
        };
      },
    };
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider(provider);
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(providers);
    const noKey = await reg.createCollection({
      providerName: 'spy',
      collectionName: 'c',
      scope: 'user',
    } as never);
    assert.equal(!noKey.ok && noKey.error.code, 'RAG_INVALID_OWNER');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const bad = await reg.createCollection({
      providerName: 'spy',
      collectionName: 'c',
      scope: 'global',
      attributes: cyclic as never,
    });
    assert.equal(!bad.ok && bad.error.code, 'RAG_INVALID_ATTRIBUTES');
    assert.equal(
      asked,
      0,
      'no provider was asked for an invalid owner or attributes',
    );
  });
});

describe('SimpleRagRegistry.createCollection forwards what a catalog needs', () => {
  it('hands the provider the logical name, the attributes, adoptExisting and the owner', async () => {
    const seen: Array<{
      name: string;
      opts: RagProviderCreateCollectionOptions;
    }> = [];
    const provider: IRagProvider = {
      name: 'spy',
      kind: 'vector',
      editable: true,
      supportedScopes: ['session', 'user', 'global'],
      createCollection: async (name, opts) => {
        seen.push({ name, opts });
        return {
          ok: true,
          value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
        };
      },
    };
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider(provider);
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(providers);
    const res = await reg.createCollection({
      providerName: 'spy',
      collectionName: 'my notes',
      scope: 'user',
      userId: 'u-1',
      attributes: { role: 'analyst' },
      adoptExisting: true,
    });
    assert.ok(res.ok);
    assert.equal(res.value.userId, 'u-1');
    assert.equal(seen.length, 1);
    assert.match(
      seen[0].name,
      /^my_notes_[0-9a-f]{12}$/,
      'the provider still gets the store name',
    );
    assert.deepEqual(seen[0].opts, {
      scope: 'user',
      userId: 'u-1',
      collectionName: 'my notes',
      attributes: { role: 'analyst' },
      adoptExisting: true,
    });
  });

  it('drops a key the scope does not select, so it never reaches a catalog', async () => {
    const seen: RagProviderCreateCollectionOptions[] = [];
    const provider: IRagProvider = {
      name: 'spy',
      kind: 'vector',
      editable: true,
      supportedScopes: ['global'],
      createCollection: async (_name, opts) => {
        seen.push(opts);
        return {
          ok: true,
          value: { rag: new InMemoryRag(), editor: {} as IRagEditor },
        };
      },
    };
    const providers = new SimpleRagProviderRegistry();
    providers.registerProvider(provider);
    const reg = new SimpleRagRegistry();
    reg.setProviderRegistry(providers);
    const res = await reg.createCollection({
      providerName: 'spy',
      collectionName: 'g',
      scope: 'global',
      userId: 'stray',
    } as never);
    assert.ok(res.ok);
    assert.equal('userId' in seen[0], false);
    assert.equal(res.value.userId, undefined);
  });
});
