// Live check of the shared table layout on SAP HANA Cloud, run as a throwaway
// CF app bound to the `hdi-llm` HDI container (deploy the tables first with
// ../deployer). Every line is prefixed `SST ` so `cf logs --recent | grep SST`
// finds it.
//
// Credentials: the binding's RUNTIME user (DML only) - never hdi_user. No DDL
// is sent by the store; this runner sends none either.
//
// Dimension: the shipped hdbtable fixes REAL_VECTOR(1536), while the
// conformance embedder produces 64 dimensions. Every vector is therefore
// zero-padded to 1536 (cosine similarity is unchanged by zero padding) and the
// stores are configured with `dimension: 1536`. The conformance cases build
// their query vectors with the unwrapped embedder, so the handles returned by
// the store and the provider are wrapped to pad a query vector too.
//
// Collections: each case runs in uniquely prefixed collections
// (`sst<timestamp>c<n>_...`); a facade strips the prefix so the cases' exact
// list assertions hold, and the case's rows and catalog records are deleted
// afterwards, even on failure.

import {
  HanaVectorRag,
  HanaVectorRagProvider,
} from '@mcp-abap-adt/hana-vector-rag';
import { staticLogin, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import {
  CONFORMANCE_EMBEDDING_DIM,
  conformanceEmbedder,
} from '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance';
import { sharedTableConformanceCases } from '@mcp-abap-adt/llm-agent/testing/shared-table-conformance';
import hana from '@sap/hana-client';

const out = (line) => console.log(`SST ${line}`);
const SHIPPED_DIMENSION = 1536;
const failures = [];
let total = 0;

function pad(vector) {
  if (vector.length > SHIPPED_DIMENSION)
    throw new Error(`vector longer than ${SHIPPED_DIMENSION}`);
  return [...vector, ...new Array(SHIPPED_DIMENSION - vector.length).fill(0)];
}

function paddedEmbedder() {
  const base = conformanceEmbedder();
  return {
    async embed(text) {
      const r = await base.embed(text);
      return { ...r, vector: pad(r.vector) };
    },
  };
}

// The package's own createHanaClient does `(await import('@sap/hana-client'))
// .createConnection`, which is undefined for this CommonJS module under ESM
// (only `default` is exposed). Until that is fixed in the package, connect here
// and hand the client to the store and provider (the HanaClient interface).
function connect(c) {
  const conn = hana.createConnection();
  const call =
    (fn) =>
    (sql, params = []) =>
      new Promise((resolve, reject) =>
        conn.exec(sql, params, (err, r) =>
          err ? reject(err) : resolve(fn(r)),
        ),
      );
  return new Promise((resolve, reject) =>
    conn.connect(
      {
        serverNode: `${c.host}:${c.port}`,
        uid: c.user,
        pwd: c.password,
        encrypt: 'true',
        sslValidateCertificate: 'true',
        currentSchema: c.schema,
        communicationTimeout: 15_000,
      },
      (err) =>
        err
          ? reject(err)
          : resolve({
              exec: call((r) => ({
                rowCount:
                  typeof r === 'number' ? r : Array.isArray(r) ? r.length : 0,
              })),
              query: call((r) => r ?? []),
              close: () =>
                new Promise((res, rej) =>
                  conn.disconnect((e) => (e ? rej(e) : res())),
                ),
            }),
    ),
  );
}

function credentials() {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) throw new Error('VCAP_SERVICES is not set');
  const c = JSON.parse(raw).hana?.[0]?.credentials;
  if (!c) throw new Error('VCAP_SERVICES has no hana[0] binding');
  return c; // only host, port, schema, user, password are used below
}

// A handle whose query pads the (64-dimension) vector the cases build.
function padQuery(rag) {
  return new Proxy(rag, {
    get(target, prop) {
      if (prop === 'query')
        return (embedding, k, options) =>
          target.query(
            {
              ...embedding,
              text: embedding.text,
              toVector: async () => pad(await embedding.toVector()),
            },
            k,
            options,
          );
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function padHandles(res) {
  return res.ok
    ? { ok: true, value: { ...res.value, rag: padQuery(res.value.rag) } }
    : res;
}

try {
  const c = credentials();
  const connection = {
    host: c.host,
    port: Number(c.port),
    schema: c.schema,
    credential: staticLogin(c.user, c.password),
    collectionName: '__unused',
    dimension: SHIPPED_DIMENSION,
    connectTimeout: 15_000,
  };
  const client = await connect(c);
  out(`connected to ${c.host}:${c.port}, schema ${c.schema}, user ${c.user}`);
  const embedder = symmetricEmbedder(paddedEmbedder());

  // Startup check: the dimension HANA reports for RAG_DOCUMENTS."VECTOR".
  const dims = await client.query(
    `SELECT LENGTH AS "dim" FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = 'RAG_DOCUMENTS' AND COLUMN_NAME = 'VECTOR'`,
  );
  out(
    `SYS.TABLE_COLUMNS.LENGTH reports dimension ${dims[0]?.dim} (configured ${SHIPPED_DIMENSION}; conformance embedder ${CONFORMANCE_EMBEDDING_DIM}, zero-padded)`,
  );
  total++;
  const health = await new HanaVectorRag(
    { ...connection, collectionName: 'probe', layout: 'shared', embedder },
    client,
  ).healthCheck();
  if (health.ok) out('PASS startup check (shared tables + dimension)');
  else {
    failures.push(['startup check', health.error]);
    out(`FAIL startup check: ${health.error}`);
    const rows = await client.query(
      `SELECT COLUMN_NAME, DATA_TYPE_NAME, LENGTH, SCALE FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND TABLE_NAME = 'RAG_DOCUMENTS'`,
    );
    out(`RAG_DOCUMENTS columns: ${JSON.stringify(rows)}`);
  }
  total++;
  const wrong = await new HanaVectorRag(
    {
      ...connection,
      collectionName: 'probe',
      layout: 'shared',
      dimension: SHIPPED_DIMENSION + 1,
      embedder,
    },
    client,
  ).healthCheck();
  if (!wrong.ok && wrong.error.code === 'SHARED_LAYOUT_NOT_DEPLOYED')
    out(`PASS startup check rejects a wrong dimension: ${wrong.error.message}`);
  else {
    failures.push([
      'startup check, wrong dimension',
      wrong.ok ? new Error('accepted') : wrong.error,
    ]);
    out('FAIL startup check, wrong dimension');
  }

  let run = 0;
  for (const kase of sharedTableConformanceCases) {
    total++;
    const prefix = `sst${Date.now()}c${++run}_`;
    const wipe = async () => {
      await client.exec(
        `DELETE FROM "RAG_DOCUMENTS" WHERE LEFT("COLLECTION", ?) = ?`,
        [prefix.length, prefix],
      );
      await client.exec(
        `DELETE FROM "RAG_COLLECTIONS" WHERE LEFT(STORE_NAME, ?) = ?`,
        [prefix.length, prefix],
      );
    };
    const subject = () => {
      const p = (name) => `${prefix}${name}`;
      const unprefix = (name) => name.slice(prefix.length);
      const store = (collection) =>
        padQuery(
          new HanaVectorRag(
            {
              ...connection,
              collectionName: p(collection),
              layout: 'shared',
              embedder,
            },
            client,
          ),
        );
      return {
        async openStore(collection) {
          return store(collection);
        },
        async provider() {
          const inner = new HanaVectorRagProvider({
            name: 'hana',
            embedder,
            connection,
            defaultDimension: SHIPPED_DIMENSION,
            layout: 'shared',
            clientFactory: () => client,
          });
          return {
            name: inner.name,
            kind: inner.kind,
            editable: inner.editable,
            supportedScopes: inner.supportedScopes,
            async createCollection(name, opts) {
              return padHandles(await inner.createCollection(p(name), opts));
            },
            async deleteCollection(name) {
              return inner.deleteCollection(p(name));
            },
            async listCollections() {
              const res = await inner.listCollections();
              return res.ok
                ? {
                    ok: true,
                    value: res.value
                      .filter((n) => n.startsWith(prefix))
                      .map(unprefix),
                  }
                : res;
            },
            async describeCollections() {
              const res = await inner.describeCollections();
              if (!res.ok) return res;
              return {
                ok: true,
                value: {
                  ...res.value,
                  records: res.value.records
                    .filter((r) => r.storeName.startsWith(prefix))
                    .map((r) => ({ ...r, storeName: unprefix(r.storeName) })),
                },
              };
            },
          };
        },
        async rawInsert(collection, id, text) {
          const { vector } = await paddedEmbedder().embed(text);
          await client.exec(
            `INSERT INTO "RAG_DOCUMENTS" ("COLLECTION","ID","TEXT","VECTOR","METADATA") VALUES (?,?,?,TO_REAL_VECTOR(?),?)`,
            [p(collection), id, text, `[${vector.join(',')}]`, '{}'],
          );
        },
      };
    };
    try {
      await wipe();
      await kase.run(async () => subject());
      out(`PASS ${kase.name}`);
    } catch (err) {
      failures.push([kase.name, err]);
      out(`FAIL ${kase.name}`);
    } finally {
      try {
        await wipe();
      } catch (err) {
        out(`could not clean up ${prefix}*: ${err}`);
      }
    }
  }
  await client.close().catch(() => {});
} catch (err) {
  failures.push(['setup', err]);
  total++;
}

if (failures.length === 0) {
  out(`CONFORMANCE PASS ${total}/${total}`);
} else {
  out(`CONFORMANCE FAIL ${total - failures.length}/${total}`);
  for (const [name, err] of failures)
    for (const line of String(err?.stack ?? err).split('\n'))
      out(`  ${name}: ${line}`);
  process.exitCode = 1;
}
