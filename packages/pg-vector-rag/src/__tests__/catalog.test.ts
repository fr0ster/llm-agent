import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IEmbedder,
  RagCollectionRecord,
  RagProviderCreateCollectionOptions,
} from '@mcp-abap-adt/llm-agent';
import { CatalogRecordDeleteError } from '@mcp-abap-adt/llm-agent';
import { PgVectorRagProvider } from '../pg-vector-rag-provider.js';
import { type FakeCatalogRow, type FakePg, fakePg } from './fake-pg.js';

const CATALOG = 'rag_collection_catalog';
const STORE = 'my_notes_a1b2c3d4e5f6';
const embedder: IEmbedder = { embed: async () => ({ vector: [0, 0, 0] }) };
const createOpts: RagProviderCreateCollectionOptions = {
  scope: 'user',
  userId: 'u-1',
  collectionName: 'my notes',
  attributes: { role: 'analyst', level: 2 },
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
  fake: FakePg,
  autoCreateSchema = true,
): PgVectorRagProvider {
  return new PgVectorRagProvider({
    name: 'pg',
    embedder,
    connection: { host: 'h', collectionName: '__unused' },
    defaultDimension: 3,
    autoCreateSchema,
    clientFactory: () => fake.client,
  });
}
const at = (fake: FakePg, re: RegExp): number =>
  fake.statements.findIndex((s) => re.test(s));
const storeCreate = new RegExp(`^CREATE TABLE "${STORE}"`);
const recordInsert = new RegExp(`^INSERT INTO "${CATALOG}"`);

describe('pg catalog: createCollection', () => {
  it('creates the store with a statement that fails if it exists, and records it last', async () => {
    const fake = fakePg();
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(res.ok, true);
    const createdAt = at(fake, storeCreate);
    assert.ok(
      createdAt >= 0 && at(fake, recordInsert) > createdAt,
      'store first, record last',
    );
    assert.equal(
      at(fake, new RegExp(`CREATE TABLE IF NOT EXISTS "${STORE}"`)),
      -1,
    );
    const described = await providerOn(fake).describeCollections();
    assert.ok(described.ok);
    assert.deepEqual(described.value, {
      records: [
        {
          scope: 'user',
          userId: 'u-1',
          storeName: STORE,
          name: 'my notes',
          attributes: { role: 'analyst', level: 2 },
        },
      ],
      rejected: [],
    });
  });

  it('records the store name as the logical name when none is given', async () => {
    const fake = fakePg();
    assert.ok(
      (await providerOn(fake).createCollection(STORE, { scope: 'global' })).ok,
    );
    assert.equal(fake.records.get(STORE)?.name, STORE);
  });

  it('refuses a collection whose record exists, and touches no store', async () => {
    const fake = fakePg();
    fake.tables.add(CATALOG);
    fake.tables.add(STORE);
    fake.records.set(STORE, row());
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
    assert.equal(at(fake, storeCreate), -1);
  });

  it('refuses a store that exists without a record, naming it', async () => {
    const fake = fakePg();
    fake.tables.add(STORE);
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_ORPHAN_STORE');
    assert.match(!res.ok ? res.error.message : '', new RegExp(STORE));
    assert.equal(at(fake, recordInsert), -1, 'nothing recorded');
    assert.ok(fake.tables.has(STORE), 'and nothing removed');
  });

  it('takes an orphan over with adoptExisting, creating nothing', async () => {
    const fake = fakePg();
    fake.tables.add(STORE);
    const res = await providerOn(fake).createCollection(STORE, {
      ...createOpts,
      adoptExisting: true,
    });
    assert.equal(res.ok, true);
    assert.equal(at(fake, storeCreate), -1);
    assert.ok(fake.records.has(STORE));
  });

  it('refuses adoptExisting for a store that is not there, with the backend error', async () => {
    const fake = fakePg();
    const res = await providerOn(fake).createCollection(STORE, {
      ...createOpts,
      adoptExisting: true,
    });
    assert.equal(!res.ok && res.error.code, 'RAG_CREATE_ERROR');
    assert.match(!res.ok ? res.error.message : '', /does not exist/);
    assert.ok(
      !fake.tables.has(STORE) && !fake.records.has(STORE),
      'adoption creates nothing',
    );
  });

  it('leaves the store in place, named, when the record cannot be written', async () => {
    const fake = fakePg();
    fake.failOn = recordInsert;
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_ORPHAN_STORE');
    assert.match(!res.ok ? res.error.message : '', new RegExp(STORE));
    assert.ok(
      fake.tables.has(STORE),
      'never removed: another registry may already adopt it',
    );
    assert.equal(at(fake, /^DROP TABLE/), -1);
  });

  it('loses cleanly to a registry that recorded the same store first', async () => {
    const fake = fakePg();
    fake.beforeInsertRecord = () => {
      fake.records.set(STORE, row({ scope: 'user', userId: 'u-1' }));
    };
    const res = await providerOn(fake).createCollection(STORE, createOpts);
    assert.equal(!res.ok && res.error.code, 'RAG_DUPLICATE_COLLECTION');
    assert.ok(fake.tables.has(STORE), "the winner's record points at it");
  });

  it('refuses an owner without its key, and non-JSON attributes, before any statement', async () => {
    const fake = fakePg();
    const provider = providerOn(fake);
    const noKey = await provider.createCollection(STORE, {
      scope: 'user',
    } as unknown as RagProviderCreateCollectionOptions);
    assert.equal(!noKey.ok && noKey.error.code, 'RAG_INVALID_OWNER');
    const nan = await provider.createCollection(STORE, {
      scope: 'global',
      attributes: Number.NaN,
    });
    assert.equal(!nan.ok && nan.error.code, 'RAG_INVALID_ATTRIBUTES');
    assert.deepEqual(fake.statements, []);
  });

  it('refuses its own catalog table as a collection', async () => {
    const fake = fakePg();
    const res = await providerOn(fake).createCollection(CATALOG, {
      scope: 'global',
    });
    assert.equal(res.ok, false);
    assert.deepEqual(fake.statements, []);
  });

  it('with autoCreateSchema false issues no DDL, requires the store, and records it', async () => {
    const fake = fakePg();
    fake.tables.add(CATALOG);
    const missing = await providerOn(fake, false).createCollection(
      STORE,
      createOpts,
    );
    assert.equal(!missing.ok && missing.error.code, 'RAG_CREATE_ERROR');
    fake.tables.add(STORE);
    const res = await providerOn(fake, false).createCollection(
      STORE,
      createOpts,
    );
    assert.equal(res.ok, true);
    assert.equal(
      at(fake, /^CREATE /),
      -1,
      'the operator makes tables in this mode',
    );
    assert.ok(fake.records.has(STORE));
  });
});

describe('pg catalog: describeCollections', () => {
  it('returns nothing, and creates nothing, when no catalog exists yet', async () => {
    const fake = fakePg();
    const res = await providerOn(fake).describeCollections();
    assert.deepEqual(res, { ok: true, value: { records: [], rejected: [] } });
    assert.equal(at(fake, /^CREATE /), -1);
  });

  it('reports malformed rows instead of returning them', async () => {
    const fake = fakePg();
    fake.tables.add(CATALOG);
    fake.records.set('good_1', row({ storeName: 'good_1', name: 'good' }));
    fake.records.set(
      'no_user_1',
      row({ storeName: 'no_user_1', scope: 'user' }),
    );
    fake.records.set('team_1', row({ storeName: 'team_1', scope: 'team' }));
    fake.records.set(
      'bad_json_1',
      row({ storeName: 'bad_json_1', attributesJson: '{' }),
    );
    fake.records.set('no_name_1', row({ storeName: 'no_name_1', name: '' }));
    const res = await providerOn(fake).describeCollections();
    assert.ok(res.ok);
    assert.deepEqual(res.value.records, [
      { scope: 'global', storeName: 'good_1', name: 'good' },
    ]);
    assert.deepEqual(
      res.value.rejected.map((r) => r.storeName),
      ['no_user_1', 'team_1', 'bad_json_1', 'no_name_1'],
    );
  });
});

describe('pg catalog: openCollection', () => {
  const record: RagCollectionRecord = {
    storeName: STORE,
    name: 'my notes',
    scope: 'global',
  };

  it('builds handles without a statement, and a write to a missing store fails instead of creating it', async () => {
    const fake = fakePg();
    const opened = await providerOn(fake).openCollection(record);
    assert.ok(opened.ok);
    assert.deepEqual(fake.statements, [], 'opening issues nothing');
    const written = await opened.value.editor.upsert('hello', { id: 'r1' });
    assert.equal(written.ok, false);
    assert.ok(!fake.tables.has(STORE), 'no handle creates its store');
    assert.equal(at(fake, /^CREATE /), -1);
  });

  it('refuses a record without its owner key', async () => {
    const fake = fakePg();
    const res = await providerOn(fake).openCollection({
      storeName: STORE,
      name: 'n',
      scope: 'user',
    } as unknown as RagCollectionRecord);
    assert.equal(!res.ok && res.error.code, 'RAG_INVALID_OWNER');
  });
});

describe('pg catalog: deleteCollection', () => {
  const seeded = (): FakePg => {
    const fake = fakePg();
    fake.tables.add(CATALOG);
    fake.tables.add(STORE);
    fake.records.set(STORE, row());
    return fake;
  };

  it('deletes the record before the data', async () => {
    const fake = seeded();
    const res = await providerOn(fake).deleteCollection(STORE);
    assert.equal(res.ok, true);
    const recordAt = at(fake, new RegExp(`^DELETE FROM "${CATALOG}"`));
    const dataAt = at(fake, new RegExp(`^DROP TABLE IF EXISTS "${STORE}"`));
    assert.ok(recordAt >= 0 && dataAt > recordAt);
    assert.ok(!fake.records.has(STORE) && !fake.tables.has(STORE));
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
    assert.ok(!res.ok && !(res.error instanceof CatalogRecordDeleteError));
    assert.equal(!res.ok && res.error.code, 'RAG_DELETE_ERROR');
    assert.ok(!fake.records.has(STORE));
  });

  it('still drops a store that predates the catalog', async () => {
    const fake = fakePg();
    fake.tables.add(STORE);
    assert.equal((await providerOn(fake).deleteCollection(STORE)).ok, true);
    assert.ok(!fake.tables.has(STORE));
  });

  it('refuses to drop its own catalog table', async () => {
    const fake = seeded();
    assert.equal((await providerOn(fake).deleteCollection(CATALOG)).ok, false);
    assert.ok(fake.tables.has(CATALOG));
  });
});
