import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IEmbedder,
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
} from '@mcp-abap-adt/llm-agent';
import { CatalogRecordDeleteError, staticLogin } from '@mcp-abap-adt/llm-agent';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { type FakeCatalogRow, type FakeHana, fakeHana } from './fake-hana.js';

const CATALOG = 'rag_collection_catalog';
const STORE = 'my_notes_a1b2c3d4e5f6';
const embedder: IEmbedder = { embed: async () => ({ vector: [0, 0, 0] }) };
const createOpts: RagProviderCreateCollectionOptions = {
  scope: 'session',
  sessionId: 's-1',
  collectionName: 'my notes',
  attributes: { role: 'analyst' },
};
const row = (over: Partial<FakeCatalogRow> = {}): FakeCatalogRow => ({
  storeName: STORE,
  name: 'my notes',
  scope: 'global',
  userId: null,
  sessionId: null,
  attributesJson: null,
  ...over,
});

function providerOn(
  fake: FakeHana,
  autoCreateSchema = true,
): HanaVectorRagProvider {
  return new HanaVectorRagProvider({
    name: 'hana',
    embedder,
    connection: {
      host: 'h',
      collectionName: '__unused',
      credential: staticLogin('u', 'p'),
    },
    defaultDimension: 3,
    autoCreateSchema,
    clientFactory: () => fake.client,
  });
}
const at = (fake: FakeHana, re: RegExp): number =>
  fake.statements.findIndex((s) => re.test(s));
const storeCreate = new RegExp(`^CREATE TABLE "${STORE}"`);
const recordInsert = new RegExp(`^INSERT INTO "${CATALOG}"`);

describe('hana catalog: createCollection', () => {
  it('creates the store with a statement that fails if it exists, and records it last', async () => {
    const fake = fakeHana();
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(res.ok, true);
    const createdAt = at(fake, storeCreate);
    assert.ok(createdAt >= 0 && at(fake, recordInsert) > createdAt);
    assert.equal(
      at(fake, new RegExp(`CREATE TABLE IF NOT EXISTS "${STORE}"`)),
      -1,
    );
    const described = await providerOn(fake).describeCollections();
    assert.ok(described.ok);
    assert.deepEqual(described.value.records, [
      {
        scope: 'session',
        sessionId: 's-1',
        storeName: STORE,
        name: 'my notes',
        attributes: { role: 'analyst' },
      },
    ]);
  });

  it('refuses a collection whose record exists', async () => {
    const fake = fakeHana();
    fake.tables.add(CATALOG);
    fake.tables.add(STORE);
    fake.records.set(STORE, row());
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
    assert.equal(at(fake, storeCreate), -1);
  });

  it('refuses a store that exists without a record, naming it, and adopts it on request', async () => {
    const fake = fakeHana();
    fake.tables.add(STORE);
    const refused = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!refused.ok && refused.error.code, 'RAG_ORPHAN_STORE');
    assert.match(!refused.ok ? refused.error.message : '', new RegExp(STORE));
    const adopted = await providerOn(fake).createCollection(STORE, {
      ...createOpts,
      adoptExisting: true,
    });
    assert.equal(adopted.ok, true);
    assert.ok(fake.records.has(STORE));
  });

  it('refuses adoptExisting for a store that is not there, and creates nothing', async () => {
    const fake = fakeHana();
    const res = await providerOn(fake).createCollection(STORE, {
      ...createOpts,
      adoptExisting: true,
    });
    assert.equal(!res.ok && res.error.code, 'RAG_CREATE_ERROR');
    assert.ok(!fake.tables.has(STORE) && !fake.records.has(STORE));
  });

  it('leaves the store in place when the record cannot be written', async () => {
    const fake = fakeHana();
    fake.failOn = recordInsert;
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_ORPHAN_STORE');
    assert.ok(fake.tables.has(STORE));
    assert.equal(at(fake, /^DROP TABLE/), -1);
  });

  it('loses cleanly to a registry that recorded the same store first', async () => {
    const fake = fakeHana();
    fake.beforeInsertRecord = () => {
      fake.records.set(STORE, row());
    };
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
    assert.ok(fake.tables.has(STORE));
  });

  it('refuses an owner without its key before any statement', async () => {
    const fake = fakeHana();
    const res = await providerOn(fake).createCollection(STORE, {
      scope: 'session',
    } as unknown as RagProviderCreateCollectionOptions);
    assert.equal(!res.ok && res.error.code, 'RAG_INVALID_OWNER');
    assert.deepEqual(fake.statements, []);
  });

  it('with autoCreateSchema false issues no DDL, requires the store, and records it', async () => {
    const fake = fakeHana();
    fake.tables.add(CATALOG);
    const missing = await providerOn(fake, false).createCollection(
      STORE,
      createOpts,
    );
    assert.equal(missing.ok, false);
    fake.tables.add(STORE);
    assert.equal(
      (await providerOn(fake, false).createCollection(STORE, createOpts)).ok,
      true,
    );
    assert.equal(at(fake, /^CREATE /), -1);
  });
});

describe('hana catalog: describeCollections', () => {
  it('returns nothing, and creates nothing, when no catalog exists yet', async () => {
    const fake = fakeHana();
    assert.deepEqual(await providerOn(fake).describeCollections(), {
      ok: true,
      value: { records: [], rejected: [] },
    });
    assert.equal(at(fake, /^CREATE /), -1);
  });

  it('decodes an NCLOB handed back as a Buffer, and rejects malformed rows', async () => {
    const fake = fakeHana();
    fake.tables.add(CATALOG);
    fake.records.set(
      'a_1',
      row({
        storeName: 'a_1',
        attributesJson: Buffer.from('{"k":[1]}', 'utf8'),
      }),
    );
    fake.records.set('b_1', row({ storeName: 'b_1', scope: 'session' }));
    const res = await providerOn(fake).describeCollections();
    assert.ok(res.ok);
    assert.deepEqual(res.value.records, [
      {
        scope: 'global',
        storeName: 'a_1',
        name: 'my notes',
        attributes: { k: [1] },
      },
    ]);
    assert.deepEqual(
      res.value.rejected.map((r) => r.storeName),
      ['b_1'],
    );
  });
});

describe('hana catalog: openCollection', () => {
  it('builds handles without a statement, and a write to a missing store fails instead of creating it', async () => {
    const fake = fakeHana();
    const record: RagCollectionRecord = {
      storeName: STORE,
      name: 'n',
      scope: 'global',
    };
    const opened = await providerOn(fake).openCollection(record);
    assert.ok(opened.ok);
    assert.deepEqual(fake.statements, []);
    assert.equal(
      (await opened.value.editor.upsert('hello', { id: 'r1' })).ok,
      false,
    );
    assert.ok(!fake.tables.has(STORE));
    assert.equal(at(fake, /^CREATE /), -1);
  });
});

describe('hana catalog: deleteCollection', () => {
  const seeded = (): FakeHana => {
    const fake = fakeHana();
    fake.tables.add(CATALOG);
    fake.tables.add(STORE);
    fake.records.set(STORE, row());
    return fake;
  };

  it('deletes the record before the data', async () => {
    const fake = seeded();
    assert.equal((await providerOn(fake).deleteCollection(STORE)).ok, true);
    const recordAt = at(fake, new RegExp(`^DELETE FROM "${CATALOG}"`));
    assert.ok(
      recordAt >= 0 &&
        at(fake, new RegExp(`^DROP TABLE IF EXISTS "${STORE}"`)) > recordAt,
    );
  });

  it('leaves record and data alone when the record cannot be deleted', async () => {
    const fake = seeded();
    fake.failOn = new RegExp(`^DELETE FROM "${CATALOG}"`);
    const res = await providerOn(fake).deleteCollection(STORE);
    assert.ok(!res.ok && res.error instanceof CatalogRecordDeleteError);
    assert.equal(at(fake, /^DROP TABLE/), -1);
    assert.ok(fake.records.has(STORE) && fake.tables.has(STORE));
  });

  it('reports a data failure after the record is gone as a plain delete error', async () => {
    const fake = seeded();
    fake.failOn = /^DROP TABLE/;
    const res = await providerOn(fake).deleteCollection(STORE);
    assert.equal(!res.ok && res.error.code, 'RAG_DELETE_ERROR');
    assert.ok(!fake.records.has(STORE));
  });
});
