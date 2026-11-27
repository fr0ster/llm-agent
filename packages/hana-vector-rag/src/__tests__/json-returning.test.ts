import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessForeignKeyHdbconstraint,
  accessForeignKeys,
  accessTableRuntimeDefinition,
  accessTables,
} from '../access-ddl.js';
import {
  catalogColumnsSql,
  createCatalogTableSql,
  deleteRecordSql,
  insertRecordSql,
  probeTableSql,
  recordExistsSql,
  selectRecordsSql,
  tableExistsSql,
  updateRecordSql,
} from '../catalog.js';
import {
  createTableSql,
  dropTableSql,
  fragmentOrdinalMigrationSql,
} from '../schema.js';
import {
  sharedCatalogHdbtable,
  sharedDocumentsHdbtable,
  sharedLayoutSql,
} from '../shared-ddl.js';
import {
  type HanaStoreSql,
  perCollectionStoreSql,
  type SqlStatement,
  sharedStoreSql,
} from '../store-sql.js';
import { hanaVectorLiteral } from '../vector-literal.js';

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
          : /^(?:N?VARCHAR(?:\(\d+\))?|JSON)$/i;
      assert.match(
        type.replace(/\s+/g, ''),
        allowed,
        `${fn} RETURNING ${type}`,
      );
    }
    previous = word;
  }
}

test('JSON_VALUE RETURNING guard rejects DECIMAL with precision', () => {
  for (const type of ['DECIMAL(38, 9)', 'DECIMAL(38,9)', 'DECIMAL(38)']) {
    const sql = `JSON_VALUE("METADATA", '$.ttl' RETURNING ${type})`;
    assert.throws(() => assertSupportedJsonReturning(sql), {
      code: 'ERR_ASSERTION',
    });
  }
});

const vector = hanaVectorLiteral([0, 1, 0], 3);

for (const store of [
  perCollectionStoreSql('docs', 3),
  sharedStoreSql('docs', 'RAG_DOCUMENTS'),
]) {
  test(`${store.layout} store SQL uses supported HANA JSON RETURNING types`, () => {
    const nowSecs = 1_800_000_000.125;
    const statements = {
      search: [
        store.search(vector, 3, { nowSecs }),
        store.search(
          vector,
          3,
          {
            nowSecs,
            namespace: 'ns',
            identity: { ownerScope: 'session', sessionId: 'session' },
          },
          6,
        ),
        store.search(vector, 3, {
          nowSecs,
          identity: { ownerScope: 'user', userId: 'user' },
        }),
      ],
      listPage: [
        store.listPage(undefined, 4, false),
        store.listPage('cursor', 4, true),
      ],
      byId: [store.byId('id')],
      countRows: [store.countRows()],
      scanPage: [store.scanPage(undefined, 4), store.scanPage('cursor', 4)],
      lockByIds: [store.lockByIds(['id', 'other'])],
      deleteByIds: [store.deleteByIds(['id', 'other'])],
      deleteById: [store.deleteById('id')],
      upsert: [store.upsert(vector, 'id', 'text', '{}')],
      insertFragment: [store.insertFragment('id', 1, vector, '{}')],
      removeFragments: [store.removeFragments('id')],
      clear: [store.clear()],
      lockForClear: [store.lockForClear()],
      createTable: [store.createTable()],
    } satisfies Record<
      Exclude<keyof HanaStoreSql, 'layout'>,
      (SqlStatement | string | undefined)[]
    >;
    for (const statement of Object.values(statements).flat()) {
      if (statement !== undefined)
        assertSupportedJsonReturning(
          typeof statement === 'string' ? statement : statement.sql,
        );
    }
  });
}

test('catalog and schema builders use supported HANA JSON RETURNING types', () => {
  const catalog = 'RAG_COLLECTIONS';
  const table = 'RAG_DOCUMENTS';
  for (const sql of [
    catalogColumnsSql(),
    createCatalogTableSql(catalog),
    tableExistsSql(false),
    tableExistsSql(true),
    probeTableSql(table),
    recordExistsSql(catalog),
    insertRecordSql(catalog),
    selectRecordsSql(catalog),
    deleteRecordSql(catalog),
    updateRecordSql(catalog),
    createTableSql(table, 3, { ifNotExists: false }),
    dropTableSql(table),
    fragmentOrdinalMigrationSql(table),
    fragmentOrdinalMigrationSql(table, 'shared'),
    sharedDocumentsHdbtable(table, 3),
    sharedCatalogHdbtable(catalog),
    sharedLayoutSql({ dimension: 3 }),
    ...accessTables.map(accessTableRuntimeDefinition),
    ...accessForeignKeys.map(accessForeignKeyHdbconstraint),
  ])
    assertSupportedJsonReturning(sql);
});
