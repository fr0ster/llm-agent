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
import {
  isScanDeleteCaseSkipped,
  scanDeleteConformanceCases,
} from '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance';
import hana from '@sap/hana-client';

const out = (line) => console.log(`SST ${line}`);
const SHIPPED_DIMENSION = 1536;
const failures = [];
let total = 0;
// One summary line per kit.
const kits = [];

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

// A raw runtime-user connection, only for the statements the store never
// sends: orphan rows, cleanup and diagnostics. The stores and the provider
// connect on their own, through the package.
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
  const health = await new HanaVectorRag({
    ...connection,
    collectionName: 'probe',
    layout: 'shared',
    embedder,
  }).healthCheck();
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
  const wrong = await new HanaVectorRag({
    ...connection,
    collectionName: 'probe',
    layout: 'shared',
    dimension: SHIPPED_DIMENSION + 1,
    embedder,
  }).healthCheck();
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
  const sharedKitStart = { total };
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
          new HanaVectorRag({
            ...connection,
            collectionName: p(collection),
            layout: 'shared',
            embedder,
          }),
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
      // Every makeSubject() call must see empty tables: the filter case calls
      // it once per sub-check, in the same collections.
      await kase.run(async () => {
        await wipe();
        return subject();
      });
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
  kits.push({
    label: 'shared-table kit (incl. startup checks)',
    ran: total - sharedKitStart.total + 2,
    failed: failures.length,
    skipped: 0,
  });

  // --- scan / deleteWhere / updateCollection kit, shared layout ------------
  // The per-collection layout is not run here: it creates a table per
  // collection (DDL), and this runner's runtime user has DML only. Its HANA
  // statements are covered by the package's unit tests.
  out(
    'scan kit: per-collection layout NOT run (runtime user has no DDL); shared layout only',
  );
  const scanKit = {
    label: 'scan/delete/catalog kit, shared layout',
    ran: 0,
    failed: 0,
    skipped: 0,
  };
  const newProvider = () =>
    new HanaVectorRagProvider({
      name: 'hana',
      embedder,
      connection,
      defaultDimension: SHIPPED_DIMENSION,
      layout: 'shared',
    });
  // Catalog facade: store names get the case prefix on the way in and lose it
  // on the way out, so the kit's exact assertions hold.
  const catalogFacade = (prefix) => {
    const inner = newProvider();
    const p = (name) => `${prefix}${name}`;
    const unprefix = (name) => name.slice(prefix.length);
    return {
      name: inner.name,
      kind: inner.kind,
      editable: inner.editable,
      supportedScopes: inner.supportedScopes,
      async createCollection(name, opts) {
        return inner.createCollection(p(name), opts);
      },
      async deleteCollection(name) {
        return inner.deleteCollection(p(name));
      },
      async updateCollection(name, patch) {
        return inner.updateCollection(p(name), patch);
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
  };
  const scanStore = (prefix, collection) =>
    padQuery(
      new HanaVectorRag({
        ...connection,
        collectionName: `${prefix}${collection}`,
        layout: 'shared',
        embedder,
      }),
    );
  const wipePrefix = async (prefix) => {
    await client.exec(
      `DELETE FROM "RAG_DOCUMENTS" WHERE LEFT("COLLECTION", ?) = ?`,
      [prefix.length, prefix],
    );
    await client.exec(
      `DELETE FROM "RAG_COLLECTIONS" WHERE LEFT(STORE_NAME, ?) = ?`,
      [prefix.length, prefix],
    );
  };
  let scanRun = 0;
  for (const kase of scanDeleteConformanceCases) {
    const prefix = `sst${Date.now()}s${++scanRun}_`;
    try {
      await kase.run(async () => {
        await wipePrefix(prefix);
        return {
          async store() {
            return scanStore(prefix, 'scan_a');
          },
          async sibling() {
            return scanStore(prefix, 'scan_b');
          },
          async catalog() {
            const provider = catalogFacade(prefix);
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
      });
      scanKit.ran++;
      out(`PASS [scan kit] ${kase.name}`);
    } catch (err) {
      if (isScanDeleteCaseSkipped(err)) {
        scanKit.skipped++;
        out(`SKIP [scan kit] ${kase.name}: ${err.message}`);
      } else {
        scanKit.ran++;
        scanKit.failed++;
        failures.push([`[scan kit] ${kase.name}`, err]);
        out(`FAIL [scan kit] ${kase.name}`);
      }
    } finally {
      try {
        await wipePrefix(prefix);
      } catch (err) {
        out(`could not clean up ${prefix}*: ${err}`);
      }
    }
  }
  kits.push(scanKit);

  // --- explicit extra checks (review watch items) --------------------------
  const extras = { label: 'extra HANA checks', ran: 0, failed: 0, skipped: 0 };
  const extra = async (name, fn) => {
    extras.ran++;
    const prefix = `sst${Date.now()}x${extras.ran}_`;
    try {
      await wipePrefix(prefix);
      await fn(prefix);
      out(`${name} OK`);
    } catch (err) {
      extras.failed++;
      failures.push([`[extra] ${name}`, err]);
      out(`FAIL ${name}`);
    } finally {
      await wipePrefix(prefix).catch(() => {});
    }
  };
  const recordsOf = async (provider) => {
    const res = await provider.describeCollections();
    if (!res.ok) throw res.error;
    return res.value.records;
  };
  const assertEq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(
        `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
  };
  // COALESCE(?, col) with a NULL bound parameter: NVARCHAR(5000) and NCLOB.
  await extra('updateCollection name-only', async (prefix) => {
    const provider = newProvider();
    const store = `${prefix}upd_name`;
    const created = await provider.createCollection(store, {
      scope: 'global',
      collectionName: 'Before',
      attributes: { keep: 'yes', n: 1 },
    });
    if (!created.ok) throw created.error;
    const patched = await provider.updateCollection(store, {
      collectionName: 'Після ✓',
    });
    if (!patched.ok) throw patched.error;
    const rec = (await recordsOf(provider)).find((r) => r.storeName === store);
    assertEq(rec?.name, 'Після ✓', 'name');
    assertEq(rec?.attributes, { keep: 'yes', n: 1 }, 'attributes untouched');
  });
  await extra('updateCollection attributes-only', async (prefix) => {
    const provider = newProvider();
    const store = `${prefix}upd_attr`;
    const created = await provider.createCollection(store, {
      scope: 'global',
      collectionName: 'Stays',
      attributes: { old: true },
    });
    if (!created.ok) throw created.error;
    const big = { blob: 'я'.repeat(9000) }; // beyond NVARCHAR(5000): NCLOB
    const patched = await provider.updateCollection(store, {
      attributes: big,
    });
    if (!patched.ok) throw patched.error;
    const rec = (await recordsOf(provider)).find((r) => r.storeName === store);
    assertEq(rec?.name, 'Stays', 'name untouched');
    assertEq(rec?.attributes, big, 'attributes replaced');
  });
  // Mixed-case and non-ASCII ids in a paged scan: each exactly once.
  await extra('scan ordering mixed-case non-ASCII', async (prefix) => {
    const store = scanStore(prefix, 'order');
    const writer = store.writer();
    const ids = ['B', 'a', 'é', 'Ж', 'z'];
    for (const id of ids) {
      const r = await writer.upsertRaw(id, `record ${id}`, {});
      if (!r.ok) throw r.error;
    }
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const res = await store.scan({
        pageSize: 2,
        ...(cursor ? { cursor } : {}),
      });
      if (!res.ok) throw res.error;
      seen.push(...res.value.records.map((r) => r.id));
      cursor = res.value.cursor;
      if (++pages > 20) throw new Error('scan never ended');
    } while (cursor !== undefined);
    assertEq([...seen].sort(), [...ids].sort(), 'each id exactly once');
    out(`scan order returned ${JSON.stringify(seen)}`);
  });
  kits.push(extras);
  await client.close().catch(() => {});
} catch (err) {
  failures.push(['setup', err]);
  total++;
}

for (const k of kits) {
  const pass = k.ran - k.failed;
  out(
    `CONFORMANCE ${k.failed === 0 ? 'PASS' : 'FAIL'} ${pass}/${k.ran} (${k.label}${k.skipped ? `; ${k.skipped} skipped, seam absent` : ''})`,
  );
}
if (failures.length > 0) {
  for (const [name, err] of failures)
    for (const line of String(err?.stack ?? err).split('\n'))
      out(`  ${name}: ${line}`);
  process.exitCode = 1;
}
// The stores' own connections keep the event loop alive; leave once the log
// has flushed (the manifest's `sleep` keeps the container for log reading).
setTimeout(() => process.exit(process.exitCode ?? 0), 1000);
