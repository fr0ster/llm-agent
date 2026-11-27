import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Result,
  staticLogin,
  symmetricEmbedder,
} from '@mcp-abap-adt/llm-agent';
import { createHanaVectorRagAccessStores } from '../access-stores.js';
import { HanaVectorRag } from '../hana-vector-rag.js';
import { HanaVectorRagProvider } from '../hana-vector-rag-provider.js';
import { migrateHanaVectorRagAccess } from '../migrate-access.js';
import { fragmentOrdinalMigrationSql } from '../schema.js';
import { sharedLayoutSql } from '../shared-ddl.js';
import { perCollectionStoreSql } from '../store-sql.js';
import { storingHana } from './storing-hana.js';

function assertSupportedSql(sql: string): void {
  assert.doesNotMatch(sql, /\bIF\s+(?:NOT\s+)?EXISTS\b/i);
  assertSupportedJsonReturning(sql);
}

function assertSupportedJsonReturning(sql: string): void {
  const functions: string[] = [];
  let previous = '';
  // Track the enclosing call so nested expressions and quoted paths cannot
  // hide a RETURNING clause or attach it to the wrong JSON function.
  for (const { 0: token, index } of sql.matchAll(
    /'(?:[^']|'')*'|"(?:[^"]|"")*"|\w+|\S/g,
  )) {
    const word = token.toUpperCase();
    if (word === '(') functions.push(previous);
    if (word === ')') functions.pop();
    const fn = functions.at(-1);
    if (word === 'RETURNING' && (fn === 'JSON_VALUE' || fn === 'JSON_QUERY')) {
      const [type = ''] =
        sql
          .slice(index + token.length)
          .trimStart()
          .match(/^\w+(?:\s*\([^()]*\))?/) ?? [];
      const allowed =
        fn === 'JSON_VALUE'
          ? /^(?:INTEGER|BIGINT|DECIMAL|BOOLEAN|N?VARCHAR\(\d+\)|NCLOB)$/i
          : /^(?:N?VARCHAR\(\d+\)|JSON)$/i;
      assert.match(
        type.replace(/\s+/g, ''),
        allowed,
        `${fn} RETURNING ${type}`,
      );
    }
    previous = word;
  }
}

test('SQL guard rejects unsupported JSON output types and conditional DDL', () => {
  for (const sql of [
    'CREATE TABLE IF NOT EXISTS "docs" (id INTEGER)',
    'DROP TABLE IF EXISTS "docs"',
    'DROP TABLE if\nexists "docs"',
    ...[
      'DOUBLE',
      'DECIMAL(38, 9)',
      'DECIMAL(38,9)',
      'DECIMAL(38)',
      'JSON',
      'VARCHAR',
    ].map((type) => `JSON_VALUE("METADATA", '$.ttl' RETURNING ${type})`),
    ...['NCLOB', 'DECIMAL', 'VARCHAR', 'NVARCHAR'].map(
      (type) => `JSON_QUERY("METADATA", '$.ttl' RETURNING ${type})`,
    ),
  ]) {
    assert.throws(() => assertSupportedSql(sql), { code: 'ERR_ASSERTION' });
  }
  for (const [fn, types] of [
    [
      'JSON_VALUE',
      [
        'INTEGER',
        'BIGINT',
        'DECIMAL',
        'BOOLEAN',
        'VARCHAR(20)',
        'NVARCHAR(20)',
        'NCLOB',
      ],
    ],
    ['JSON_QUERY', ['VARCHAR(20)', 'NVARCHAR(20)', 'JSON']],
  ] as const)
    for (const type of types)
      assertSupportedSql(
        `COALESCE(${fn}("METADATA", '$.ttl' RETURNING ${type}), NULL)`,
      );
});

const dimension = 3;
const vector = [1, 0, 0];
const connection = {
  collectionName: 'docs',
  credential: staticLogin('u', 'p'),
};
const embedder = symmetricEmbedder({ embed: async () => ({ vector }) });
const catalogTable = 'RAG_COLLECTIONS';
const documentsTable = 'RAG_DOCUMENTS';

function value<T>(result: Result<T, Error>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function checkStatements(statements: string[]): void {
  if (process.env.HANA_SQL_COMPAT_PRINT === '1')
    process.stdout.write(
      `HANA_SQL ${JSON.stringify([...new Set(statements)])}\n`,
    );
  for (const sql of statements) assertSupportedSql(sql);
}

for (const layout of ['per-collection', 'shared'] as const) {
  test(`recorded ${layout} store, provider, and migration statements use supported HANA SQL`, async () => {
    const shared = layout === 'shared';
    const schema = 'APP';
    const db = storingHana({ dimension, schema });
    const table = shared ? documentsTable : connection.collectionName;
    const providerConfig = {
      name: 'hana',
      layout,
      defaultDimension: dimension,
      embedder,
      catalogTable,
      clientFactory: () => db.client,
    };
    const provider = new HanaVectorRagProvider({
      ...providerConfig,
      connection: { ...connection, ...(shared ? { schema } : {}) },
    });
    const currentSchemaProvider = new HanaVectorRagProvider({
      ...providerConfig,
      connection: { ...connection, ...(shared ? {} : { schema }) },
    });
    const store = new HanaVectorRag(
      {
        ...connection,
        ...(shared ? { schema } : {}),
        embedder,
        dimension,
        layout,
      },
      db.client,
    );
    value(await provider.createCollection('collection', { scope: 'global' }));
    value(await provider.listCollections());
    value(await currentSchemaProvider.listCollections());
    const { records } = value(await provider.describeCollections());
    assert.equal(records.length, 1);
    value(await provider.openCollection(records[0]));
    value(
      await provider.updateCollection('collection', {
        collectionName: 'renamed',
        attributes: { enabled: true },
      }),
    );
    value(await provider.deleteCollection('collection'));
    value(await provider.createCollection('collection', { scope: 'global' }));

    await store.ensureSchema();
    value(await store.healthCheck());
    if (!shared) {
      value(
        await provider.createCollection('docs', {
          scope: 'global',
          adoptExisting: true,
        }),
      );
      const count = perCollectionStoreSql(table, dimension).countRows();
      await db.client.query(count.sql, count.params);
    }
    value(await store.upsert('first', { id: 'first', namespace: 'ns' }));
    value(
      await store.upsertPrecomputed(
        'second',
        [
          [0, 1, 0],
          [0, 1, 0],
        ],
        { id: 'second', namespace: 'ns' },
      ),
    );
    value(await store.upsert('third', { id: 'third' }));
    assert.equal(
      value(await store.getById('first', { ragFilter: { namespace: 'ns' } }))
        ?.text,
      'first',
    );

    for (const includeText of [false, true]) {
      const page = value(await store.list({ limit: 1, includeText }));
      assert.ok(page.cursor);
      value(await store.list({ limit: 1, includeText, cursor: page.cursor }));
    }
    const page = value(await store.scan({ pageSize: 1 }));
    assert.ok(page.cursor);
    value(await store.scan({ pageSize: 1, cursor: page.cursor }));
    const embedding = { text: 'first', toVector: async () => vector };
    for (const identity of [
      {},
      { owner: { scope: 'global' } },
      { userId: 'user' },
      { sessionId: 'session' },
    ] as const) {
      for (const namespace of [undefined, 'ns']) {
        // A large k triggers the exact fallback for each filter shape.
        value(
          await store.query(embedding, 10, {
            ragFilter: { ...identity, namespace },
          }),
        );
      }
    }
    // The first candidates are two fragments of one record, so the ANN cap expands.
    value(
      await store.query({ ...embedding, toVector: async () => [0, 1, 0] }, 2),
    );

    const writer = store.writer();
    assert.equal(value(await writer.deleteByIdRaw('third')), true);
    assert.equal(
      value(await store.deleteWhere({ namespace: 'ns' })).deleted,
      2,
    );
    value(await store.upsert('single', { id: 'single', namespace: 'ns' }));
    assert.equal(
      value(await store.deleteWhere({ namespace: 'ns' })).deleted,
      1,
    );
    assert.ok(writer.clearAll);
    value(await writer.clearAll());

    // Seed the old metadata before access migration to exercise both backfill updates.
    db.insertRow(shared ? documentsTable : 'collection', {
      ...(shared ? { COLLECTION: 'collection' } : {}),
      ID: 'legacy',
      TEXT: 'legacy',
      VECTOR: vector,
      METADATA: '{}',
    });
    value(await migrateHanaVectorRagAccess(provider));
    value(await migrateHanaVectorRagAccess(currentSchemaProvider));
    const { roles, roleAdmin, bindings } =
      createHanaVectorRagAccessStores(provider);
    value(await roleAdmin.createRole({ roleId: 'role', name: 'Role' }));
    value(await roleAdmin.listRoles());
    value(await roleAdmin.assign('user', 'role'));
    value(await roles.rolesOf('user'));
    value(await roleAdmin.revoke('user', 'role'));
    value(await roleAdmin.bindCollection('collection', 'role'));
    value(await roles.collectionRoles('collection'));
    value(await roleAdmin.unbindCollection('collection', 'role'));
    value(await roleAdmin.bindCollection('collection', 'role'));
    value(await bindings.bind('session', 'user'));
    value(await bindings.bind('session', 'user'));
    assert.equal((await bindings.bind('session', 'other')).ok, false);
    value(await bindings.getUserId('session'));
    value(await provider.deleteCollection('collection'));
    assert.equal(value(await roles.collectionRoles('collection')).size, 0);
    value(await roleAdmin.deleteRole('role'));
    provider.close();
    currentSchemaProvider.close();
    checkStatements(db.statements);
  });
}

test('fresh access migration and first provider create record their catalog DDL', async () => {
  const db = storingHana({ dimension });
  for (const catalogTable of ['migration_catalog', 'provider_catalog']) {
    const provider = new HanaVectorRagProvider({
      name: 'hana',
      layout: 'per-collection',
      connection,
      embedder,
      defaultDimension: dimension,
      catalogTable,
      clientFactory: () => db.client,
    });
    if (catalogTable === 'migration_catalog')
      value(await migrateHanaVectorRagAccess(provider));
    else value(await provider.createCollection('docs', { scope: 'global' }));
    provider.close();
  }
  checkStatements(db.statements);
});

test('access migration of a legacy catalog records its ALTER TABLE', async () => {
  const db = storingHana({ dimension, legacyCatalog: true });
  const provider = new HanaVectorRagProvider({
    name: 'hana',
    connection,
    embedder,
    defaultDimension: dimension,
    catalogTable,
    clientFactory: () => db.client,
  });
  value(await migrateHanaVectorRagAccess(provider));
  provider.close();
  assert.ok(db.statements.some((sql) => sql.startsWith('ALTER TABLE')));
  checkStatements(db.statements);
});

test('runtime table DDL handles concurrent creation and a retried deletion', async () => {
  const db = storingHana({ dimension });
  const config = { ...connection, embedder, dimension };
  const first = new HanaVectorRag(config, db.client);
  const second = new HanaVectorRag(config, db.client);
  const denied = Object.assign(new Error('Insufficient privilege'), {
    code: 258,
  });
  const exec = db.client.exec;
  db.client.exec = async () => {
    throw denied;
  };
  await assert.rejects(first.ensureSchema(), (error) => error === denied);
  db.client.exec = exec;
  await Promise.all([first.ensureSchema(), second.ensureSchema()]);
  assert.equal(
    db.statements.filter((sql) => sql.startsWith('CREATE TABLE "docs"')).length,
    2,
  );
  const provider = new HanaVectorRagProvider({
    name: 'hana',
    connection,
    embedder,
    clientFactory: () => db.client,
  });
  value(await provider.deleteCollection('docs'));
  value(await provider.deleteCollection('docs'));
  provider.close();
  checkStatements(db.statements);
});

test('operator SQL scripts use supported HANA SQL', () => {
  checkStatements([
    ...sharedLayoutSql({ dimension }).split(';\n'),
    fragmentOrdinalMigrationSql(documentsTable, 'shared'),
  ]);
});
