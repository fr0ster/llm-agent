// Live check of scan / deleteWhere / updateCollection on a real Qdrant.
// Runs only when QDRANT_TEST_URL is set (and QDRANT_TEST_API_KEY, if the
// instance needs one); otherwise it prints a SKIP line and exits 0.
// Run `npm run build` at the repo root first.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const url = process.env.QDRANT_TEST_URL?.replace(/\/+$/, '');
if (!url) {
  console.log(
    'SKIP qdrant scan/delete/catalog checks: QDRANT_TEST_URL is not set',
  );
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const load = (spec) => import(pathToFileURL(rootRequire.resolve(spec)).href);

const { symmetricEmbedder } = await load('@mcp-abap-adt/llm-agent');
const { conformanceEmbedder } = await load(
  '@mcp-abap-adt/llm-agent/testing/rag-filter-conformance',
);
const { scanDeleteConformanceCases, isScanDeleteCaseSkipped } = await load(
  '@mcp-abap-adt/llm-agent/testing/scan-delete-conformance',
);
const { QdrantRag, QdrantRagProvider } = await load('@mcp-abap-adt/qdrant-rag');

const apiKey = process.env.QDRANT_TEST_API_KEY;
const credential = apiKey ? { secret: async () => apiKey } : undefined;
const embedder = symmetricEmbedder(conformanceEmbedder());
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created = new Set();
let seq = 0;

const headers = {
  'Content-Type': 'application/json',
  ...(apiKey ? { 'api-key': apiKey } : {}),
};
const dropCollection = (name) =>
  fetch(`${url}/collections/${name}`, { method: 'DELETE', headers }).catch(
    () => {},
  );

const storeOf = (name) => {
  created.add(name);
  return new QdrantRag({
    url,
    collectionName: name,
    embedder,
    ...(credential ? { credential } : {}),
  });
};

// A fresh subject per call: new collection names, so storage starts empty.
const makeSubject = async () => {
  const n = ++seq;
  const a = `scan_${runId}_${n}_a`;
  const b = `scan_${runId}_${n}_b`;
  const catalogCollection = `scan_cat_${runId}_${n}`;
  created.add(catalogCollection);
  return {
    async store() {
      return storeOf(a);
    },
    async sibling() {
      return storeOf(b);
    },
    async catalog() {
      const provider = new QdrantRagProvider({
        name: 'qdrant',
        url,
        embedder,
        catalogCollection,
        ...(credential ? { credential } : {}),
      });
      return {
        provider,
        async create(name) {
          created.add(name);
          const res = await provider.createCollection(name, {
            scope: 'global',
          });
          if (!res.ok) throw res.error;
        },
      };
    },
  };
};

const kit = { ran: 0, failed: 0, skipped: 0 };
const failures = [];
try {
  for (const c of scanDeleteConformanceCases) {
    try {
      await c.run(makeSubject);
      kit.ran++;
      console.log(`PASS ${c.name}`);
    } catch (err) {
      if (isScanDeleteCaseSkipped(err)) {
        kit.skipped++;
        console.log(`SKIP ${c.name}: ${err.message}`);
      } else {
        kit.ran++;
        kit.failed++;
        failures.push([c.name, err]);
        console.log(`FAIL ${c.name}`);
      }
    }
  }
} finally {
  for (const name of created) await dropCollection(name);
}
console.log(
  `CONFORMANCE ${kit.failed > 0 ? 'FAIL' : kit.ran === 0 ? 'SKIP' : 'PASS'} ${kit.ran - kit.failed}/${kit.ran} (${kit.ran === 0 ? 'all skipped' : `qdrant scan/delete/catalog kit${kit.skipped ? `; ${kit.skipped} skipped` : ''}`})`,
);
if (failures.length > 0) {
  for (const [name, err] of failures)
    console.log(`  ${name}: ${err?.stack ?? err}`);
  process.exitCode = 1;
}
