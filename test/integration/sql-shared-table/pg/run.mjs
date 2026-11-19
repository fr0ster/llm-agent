// Live check of the shared table layout on a real Postgres with pgvector.
// Reads PG_TEST_URL; run `npm run build` at the repo root first (the built
// workspace packages are imported from the root node_modules).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const load = (spec) => import(pathToFileURL(rootRequire.resolve(spec)).href);

const { symmetricEmbedder } = await load('@mcp-abap-adt/llm-agent');
const {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
  registerRawRecordInsert,
} = await load('@mcp-abap-adt/llm-agent/testing/rag-filter-conformance');
const { sharedTableConformanceCases } = await load(
  '@mcp-abap-adt/llm-agent/testing/shared-table-conformance',
);
const { scanDeleteConformanceCases, isScanDeleteCaseSkipped } = await load(
  '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance',
);
const { PgVectorRag, PgVectorRagProvider, sharedLayoutSql } = await load(
  '@mcp-abap-adt/pg-vector-rag',
);
const { default: pg } = await import('pg');

const url = process.env.PG_TEST_URL;
if (!url) {
  console.error('PG_TEST_URL is not set');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: url, max: 5 });
function poolClient(pool, searchPath) {
  async function withConnection(work) {
    const connection = await pool.connect();
    try {
      if (searchPath)
        await connection.query(`SET search_path TO ${searchPath}`);
      return await work(connection);
    } finally {
      if (searchPath) await connection.query('RESET search_path');
      connection.release();
    }
  }
  return {
    query: (sql, params = []) =>
      searchPath
        ? withConnection((connection) => connection.query(sql, params))
        : pool.query(sql, params),
    end: async () => {},
    transaction: (work) =>
      withConnection(async (connection) => {
        await connection.query('BEGIN');
        try {
          const result = await work(connection);
          await connection.query('COMMIT');
          return result;
        } catch (error) {
          await connection.query('ROLLBACK');
          throw error;
        }
      }),
  };
}
const client = poolClient(pool);
const schema = `sst_${Date.now()}`;
const dim = CONFORMANCE_EMBEDDING_DIM;
const embedder = symmetricEmbedder(conformanceEmbedder());
const failures = [];
let total = 0;
// One summary line per kit: [label, passed, ran, skipped].
const kits = [];

const resetTables = () =>
  pool.query(
    `TRUNCATE "${schema}"."rag_documents", "${schema}"."rag_collections"`,
  );

function storeOf(collection, dimension = dim) {
  return registerRawRecordInsert(
    new PgVectorRag(
      {
        collectionName: collection,
        dimension,
        layout: 'shared',
        schema,
        embedder,
      },
      client,
    ),
    async (r) => {
      await client.query(
        `INSERT INTO "${schema}".rag_documents (collection, id, text, vector, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)`,
        [
          collection,
          r.id,
          r.text,
          JSON.stringify((await conformanceEmbedder().embed(r.text)).vector),
          JSON.stringify(r.metadata),
        ],
      );
    },
  );
}

function subject() {
  return {
    async openStore(collection) {
      return storeOf(collection);
    },
    async provider() {
      return new PgVectorRagProvider({
        name: 'pg',
        embedder,
        connection: { collectionName: '__unused', dimension: dim, schema },
        layout: 'shared',
        clientFactory: () => client,
      });
    },
    async rawInsert(collection, id, text) {
      const { vector } = await conformanceEmbedder().embed(text);
      await pool.query(
        `INSERT INTO "${schema}"."rag_documents" ("collection","id","text","vector","metadata") VALUES ($1,$2,$3,$4::vector,$5::jsonb)`,
        [collection, id, text, `[${vector.join(',')}]`, '{}'],
      );
    },
  };
}

const quoteIdent = (name) => `"${String(name).replaceAll('"', '""')}"`;
// The run's schema first, then the schema pgvector is installed in: the
// `vector` type and the `<=>` operator are referenced unqualified. Set once the
// extension exists.
let searchPath;
async function pgvectorSearchPath() {
  const { rows } = await pool.query(
    `SELECT n.nspname AS "schema" FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'`,
  );
  const extSchema = rows[0]?.schema;
  if (!extSchema) throw new Error('the pgvector extension is not installed');
  return extSchema === schema
    ? quoteIdent(schema)
    : `${quoteIdent(schema)}, ${quoteIdent(extSchema)}`;
}

try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`CREATE SCHEMA "${schema}"`);
  searchPath = await pgvectorSearchPath();
  console.log(`search_path: ${searchPath}`);
  // The script is the deployed layout; apply it with the schema as search_path.
  const conn = await pool.connect();
  try {
    await conn.query(`SET search_path TO ${searchPath}`);
    const released = sharedLayoutSql({ dimension: dim })
      .replace('  "fragment_ordinal" INTEGER NOT NULL DEFAULT 0,\n', '')
      .replace(
        'PRIMARY KEY ("collection", "id", "fragment_ordinal")',
        'PRIMARY KEY ("collection", "id")',
      );
    await conn.query(released);
    const { vector } = await conformanceEmbedder().embed('legacy records');
    for (const id of ['first', 'second'])
      await conn.query(
        'INSERT INTO rag_documents (collection, id, text, vector, metadata) VALUES ($1, $2, $3, $4::vector, $5::jsonb)',
        ['legacy', id, id, JSON.stringify(vector), '{}'],
      );
    await conn.query(
      'CREATE INDEX rag_vector_index ON rag_documents USING hnsw (vector vector_cosine_ops)',
    );
    const previousVectors = await conn.query(
      'SELECT vector::text FROM rag_documents ORDER BY id',
    );
    const migration = await readFile(
      resolve(
        root,
        'packages/pg-vector-rag/ddl/migrations/001-fragment-ordinal.sql',
      ),
      'utf8',
    );
    await conn.query(migration);
    await conn.query(migration);
    const preserved = await conn.query(
      'SELECT id, text, fragment_ordinal, vector::text FROM rag_documents ORDER BY id',
    );
    assert.deepEqual(
      preserved.rows.map(({ id, text, fragment_ordinal }) => [
        id,
        text,
        fragment_ordinal,
      ]),
      [
        ['first', 'first', 0],
        ['second', 'second', 0],
      ],
    );
    assert.deepEqual(
      preserved.rows.map(({ vector }) => vector),
      previousVectors.rows.map(({ vector }) => vector),
    );
    assert.ok(
      (await conn.query("SELECT to_regclass('rag_vector_index') AS index"))
        .rows[0].index,
    );
    const legacy = await storeOf('legacy').query(
      { text: 'legacy', toVector: async () => vector },
      2,
    );
    assert.ok(legacy.ok);
    assert.deepEqual(
      legacy.value.map(({ text }) => text),
      ['first', 'second'],
    );
    await resetTables();
    console.log(
      'PASS released shared table migration, including rerun and indexed search',
    );
  } finally {
    // The connection goes back to the pool: leave no search_path behind.
    await conn.query('RESET search_path');
    conn.release();
  }

  // Startup check on a real Postgres: the atttypmod query.
  const reported = await pool.query(
    `SELECT a.atttypmod AS "dim" FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attname = 'vector' AND NOT a.attisdropped`,
    [`"${schema}"."rag_documents"`],
  );
  console.log(
    `atttypmod reports dimension ${reported.rows[0]?.dim} (configured ${dim})`,
  );
  total++;
  const health = await storeOf('probe').healthCheck();
  if (health.ok) console.log('PASS startup check (shared tables + dimension)');
  else {
    failures.push(['startup check', health.error]);
    console.log('FAIL startup check');
  }
  total++;
  const wrong = await storeOf('probe', dim + 1).healthCheck();
  if (!wrong.ok && wrong.error.code === 'SHARED_LAYOUT_NOT_DEPLOYED')
    console.log(
      `PASS startup check rejects a wrong dimension: ${wrong.error.message}`,
    );
  else {
    failures.push([
      'startup check, wrong dimension',
      wrong.ok ? new Error('accepted') : wrong.error,
    ]);
    console.log('FAIL startup check, wrong dimension');
  }

  total++;
  const regression =
    'indexed fragments rank distinct records and cascade replacement and deletion';
  try {
    await resetTables();
    const rag = storeOf('fragments');
    const perpendicular = Array.from({ length: dim }, (_, index) =>
      Number(index === 0),
    );
    const query = Array.from({ length: dim }, (_, index) =>
      Number(index === 1),
    );
    const legacy = perpendicular.map((value, index) => value + query[index]);
    assert.ok(
      (await rag.upsertPrecomputed('legacy', legacy, { id: 'legacy' })).ok,
    );
    assert.ok(
      (
        await rag.upsertPrecomputed(
          'best tail',
          [perpendicular, query, query, query],
          { id: 'long' },
        )
      ).ok,
    );
    const lookup = { text: 'tail', toVector: async () => query };
    const search = await rag.query(lookup, 2);
    assert.ok(search.ok, search.ok ? undefined : search.error.message);
    assert.deepEqual(
      search.value.map(({ text }) => text),
      ['best tail', 'legacy'],
    );
    const fragments = async () =>
      (
        await pool.query(
          `SELECT "fragment_ordinal" FROM "${schema}"."rag_documents" WHERE "collection" = 'fragments' AND "fragment_ordinal" > 0 ORDER BY "fragment_ordinal"`,
        )
      ).rows.length;
    assert.equal(await fragments(), 3);
    assert.ok(
      (
        await rag.upsertPrecomputed('replacement', perpendicular, {
          id: 'long',
        })
      ).ok,
    );
    assert.equal(await fragments(), 0);
    assert.ok(
      (
        await rag.upsertPrecomputed('best tail', [perpendicular, query], {
          id: 'long',
        })
      ).ok,
    );
    assert.ok((await rag.writer().deleteByIdRaw('long')).ok);
    assert.equal(await fragments(), 0);
    console.log(`PASS ${regression}`);
  } catch (error) {
    failures.push([regression, error]);
    console.log(`FAIL ${regression}`);
  }

  const sharedKitStart = { total };
  for (const c of sharedTableConformanceCases) {
    total++;
    try {
      await c.run(async () => {
        await resetTables();
        return subject();
      });
      console.log(`PASS ${c.name}`);
    } catch (err) {
      failures.push([c.name, err]);
      console.log(`FAIL ${c.name}`);
    }
  }
  kits.push({
    label: 'shared-table kit (incl. startup checks)',
    ran: total - sharedKitStart.total + 3,
    failed: failures.length,
    skipped: 0,
  });

  // --- scan / deleteWhere / updateCollection kit, both layouts -------------
  // The per-collection layout ignores `schema` for its data tables, so this
  // kit uses a client that sets search_path to the run's own schema (then
  // pgvector's schema, for the `vector` type) on every statement and resets
  // it before the connection goes back: everything it creates lands there. The exact table names are
  // tracked and only those are dropped (the schema itself goes at the end).
  const pcTables = new Set();
  const pcClient = poolClient(pool, searchPath);
  const dropPerCollectionTables = async () => {
    for (const table of pcTables)
      await pool.query(`DROP TABLE IF EXISTS "${schema}"."${table}"`);
    pcTables.clear();
  };
  const sharedScanSubject = async () => {
    await resetTables();
    return {
      async store() {
        return storeOf('scan_a');
      },
      async sibling() {
        return storeOf('scan_b');
      },
      async catalog() {
        const provider = await subject().provider();
        return {
          provider,
          async create(name) {
            const res = await provider.createCollection(name, {
              scope: 'global',
            });
            if (!res.ok) throw res.error;
          },
        };
      },
    };
  };
  const perCollectionStore = (collection) =>
    registerRawRecordInsert(
      new PgVectorRag(
        {
          collectionName: collection,
          dimension: dim,
          layout: 'per-collection',
          embedder,
        },
        pcClient,
      ),
      async (r) => {
        // Initialize the test table through a valid write before raw fixture insertion.
        const store = new PgVectorRag(
          { collectionName: collection, dimension: dim, embedder },
          pcClient,
        );
        await store.ensureSchema();
        await pcClient.query(
          `INSERT INTO "${collection}" (id, text, vector, metadata) VALUES ($1, $2, $3::vector, $4::jsonb)`,
          [
            r.id,
            r.text,
            JSON.stringify((await conformanceEmbedder().embed(r.text)).vector),
            JSON.stringify(r.metadata),
          ],
        );
      },
    );
  const perCollectionScanSubject = async () => {
    await dropPerCollectionTables();
    return {
      async store() {
        pcTables.add('scan_a');
        return perCollectionStore('scan_a');
      },
      async catalog() {
        const provider = new PgVectorRagProvider({
          name: 'pg',
          embedder,
          connection: { collectionName: '__unused', dimension: dim },
          defaultDimension: dim,
          clientFactory: () => pcClient,
        });
        pcTables.add('rag_collection_catalog');
        return {
          provider,
          async create(name) {
            pcTables.add(name);
            const res = await provider.createCollection(name, {
              scope: 'global',
            });
            if (!res.ok) throw res.error;
          },
        };
      },
    };
  };
  for (const [label, makeSubject] of [
    ['scan/delete/catalog kit, shared layout', sharedScanSubject],
    [
      'scan/delete/catalog kit, per-collection layout',
      perCollectionScanSubject,
    ],
  ]) {
    const kit = { label, ran: 0, failed: 0, skipped: 0 };
    for (const c of scanDeleteConformanceCases) {
      try {
        await c.run(makeSubject);
        kit.ran++;
        console.log(`PASS [${label}] ${c.name}`);
      } catch (err) {
        if (isScanDeleteCaseSkipped(err)) {
          kit.skipped++;
          console.log(`SKIP [${label}] ${c.name}: ${err.message}`);
        } else {
          kit.ran++;
          kit.failed++;
          failures.push([`[${label}] ${c.name}`, err]);
          console.log(`FAIL [${label}] ${c.name}`);
        }
      }
    }
    kits.push(kit);
  }
  await dropPerCollectionTables();
} catch (err) {
  failures.push(['setup', err]);
  total++;
} finally {
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } catch (err) {
    console.error(`could not drop schema ${schema}: ${err}`);
  }
  await pool.end();
}

for (const k of kits) {
  const pass = k.ran - k.failed;
  console.log(
    `CONFORMANCE ${k.failed === 0 ? 'PASS' : 'FAIL'} ${pass}/${k.ran} (${k.label}${k.skipped ? `; ${k.skipped} skipped, seam absent` : ''})`,
  );
}
if (failures.length > 0) {
  for (const [name, err] of failures)
    console.log(`  ${name}: ${err?.stack ?? err}`);
  process.exitCode = 1;
}
