// Live check of the shared table layout on a real Postgres with pgvector.
// Reads PG_TEST_URL; run `npm run build` at the repo root first (the built
// workspace packages are imported from the root node_modules).
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const load = (spec) => import(pathToFileURL(rootRequire.resolve(spec)).href);

const { symmetricEmbedder } = await load('@mcp-abap-adt/llm-agent');
const { CONFORMANCE_EMBEDDING_DIM, conformanceEmbedder } = await load(
  '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance',
);
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
const client = {
  query: (sql, params = []) => pool.query(sql, params),
  end: async () => {},
};
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
  return new PgVectorRag(
    {
      collectionName: collection,
      dimension,
      layout: 'shared',
      schema,
      embedder,
    },
    client,
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

try {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`CREATE SCHEMA "${schema}"`);
  // The script is the deployed layout; apply it with the schema as search_path.
  const conn = await pool.connect();
  try {
    await conn.query(`SET search_path TO "${schema}", public`);
    for (const stmt of sharedLayoutSql({ dimension: dim }).split(';\n')) {
      const sql = stmt.trim().replace(/;$/, '');
      if (sql) await conn.query(sql);
    }
  } finally {
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
    ran: total - sharedKitStart.total + 2,
    failed: failures.length,
    skipped: 0,
  });

  // --- scan / deleteWhere / updateCollection kit, both layouts -------------
  // The per-collection layout ignores `schema` for its data tables, so this
  // kit uses a client that sets search_path to the run's own schema on every
  // statement: everything it creates lands there. The exact table names are
  // tracked and only those are dropped (the schema itself goes at the end).
  const pcTables = new Set();
  const pcClient = {
    async query(sql, params = []) {
      const conn = await pool.connect();
      try {
        await conn.query(`SET search_path TO "${schema}", public`);
        return await conn.query(sql, params);
      } finally {
        conn.release();
      }
    },
    end: async () => {},
  };
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
    new PgVectorRag(
      {
        collectionName: collection,
        dimension: dim,
        layout: 'per-collection',
        embedder,
      },
      pcClient,
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
