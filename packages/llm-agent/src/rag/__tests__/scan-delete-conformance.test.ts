import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IRagProvider,
  RagCollectionRecord,
  RagJsonValue,
} from '../../interfaces/rag.js';
import {
  INVALID_ARGUMENT,
  type IRagCatalogUpdater,
  RAG_COLLECTION_NOT_FOUND,
  type RagCatalogPatch,
} from '../../interfaces/rag-scan.js';
import { RagError, type Result } from '../../interfaces/types.js';
import {
  conformanceEmbedder,
  isScanDeleteCaseSkipped,
  type ScanDeleteConformanceCase,
  type ScanDeleteSubject,
  scanDeleteConformanceCases,
} from '../../testing/scan-delete-conformance.js';
import { InMemoryRag } from '../in-memory-rag.js';
import { symmetricEmbedder } from '../retrieval-embedder.js';
import { VectorRag } from '../vector-rag.js';

// The in-process stores have no sibling collection and no catalog: the cases
// that need them are reported as skipped.
const subjects: Array<[string, () => Promise<ScanDeleteSubject>]> = [
  ['InMemoryRag', async () => ({ store: async () => new InMemoryRag() })],
  [
    'VectorRag',
    async () => ({
      store: async () =>
        new VectorRag(symmetricEmbedder(conformanceEmbedder())),
    }),
  ],
];

for (const [label, makeSubject] of subjects) {
  describe(`scan/delete conformance — ${label}`, () => {
    for (const c of scanDeleteConformanceCases) {
      it(c.name, async (t) => {
        try {
          await c.run(makeSubject);
        } catch (err) {
          if (!isScanDeleteCaseSkipped(err)) throw err;
          t.skip(err.message);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Kit self-check: the sibling and catalog cases, against fakes, so they are
// exercised here even though no in-process store offers those seams.
// ---------------------------------------------------------------------------

type Flaw =
  | 'none'
  | 'merge'
  | 'wrong-code'
  | 'accept-empty'
  | 'keys-empty'
  | 'accept-blank-name';

/** A catalog-only provider over a Map, with an optional deliberate flaw. */
function fakeCatalog(flaw: Flaw = 'none'): {
  provider: IRagProvider & IRagCatalogUpdater;
  create(name: string): Promise<void>;
} {
  const records = new Map<string, RagCollectionRecord>();
  const provider: IRagProvider & IRagCatalogUpdater = {
    name: 'fake-catalog',
    kind: 'fake',
    editable: true,
    supportedScopes: ['global'],
    async createCollection() {
      return { ok: false, error: new RagError('not supported') };
    },
    async describeCollections() {
      return {
        ok: true,
        value: { records: [...records.values()], rejected: [] },
      };
    },
    async updateCollection(
      storeName: string,
      patch: RagCatalogPatch,
    ): Promise<Result<void, RagError>> {
      // 'keys-empty' counts keys, so an all-undefined patch slips through.
      const empty =
        flaw === 'keys-empty'
          ? Object.keys(patch).length === 0
          : patch.collectionName === undefined &&
            patch.attributes === undefined;
      if (empty && flaw !== 'accept-empty') {
        return { ok: false, error: new RagError('empty', INVALID_ARGUMENT) };
      }
      const name: unknown = patch.collectionName;
      if (
        flaw !== 'accept-blank-name' &&
        name !== undefined &&
        (typeof name !== 'string' || name.trim() === '')
      ) {
        return { ok: false, error: new RagError('name', INVALID_ARGUMENT) };
      }
      const rec = records.get(storeName);
      if (!rec) {
        const code =
          flaw === 'wrong-code' ? 'RAG_ERROR' : RAG_COLLECTION_NOT_FOUND;
        return { ok: false, error: new RagError('missing', code) };
      }
      const attributes =
        patch.attributes === undefined
          ? rec.attributes
          : flaw === 'merge'
            ? ({
                ...(rec.attributes as object),
                ...patch.attributes,
              } as RagJsonValue)
            : (patch.attributes as RagJsonValue);
      records.set(storeName, {
        ...rec,
        ...(patch.collectionName !== undefined
          ? { name: patch.collectionName }
          : {}),
        ...(attributes !== undefined ? { attributes } : {}),
      });
      return { ok: true, value: undefined };
    },
  };
  return {
    provider,
    async create(name) {
      records.set(name, { storeName: name, name, scope: 'user', userId: 'u1' });
    },
  };
}

function fullSubject(flaw: Flaw = 'none'): () => Promise<ScanDeleteSubject> {
  return async () => ({
    store: async () => new InMemoryRag(),
    // Separate instances: separate storage, but the case logic runs.
    sibling: async () => new InMemoryRag(),
    catalog: async () => fakeCatalog(flaw),
  });
}

function caseNamed(name: string): ScanDeleteConformanceCase {
  const c = scanDeleteConformanceCases.find((x) => x.name === name);
  assert.ok(c, name);
  return c;
}

describe('scan/delete conformance kit — seams present', () => {
  for (const c of scanDeleteConformanceCases.filter((x) => x.requires)) {
    it(c.name, () => c.run(fullSubject()));
  }

  it('declares the seam of every seam case', () => {
    assert.deepEqual(
      scanDeleteConformanceCases
        .filter((x) => x.requires)
        .map((x) => x.requires),
      ['sibling', 'catalog', 'catalog', 'catalog', 'catalog'],
    );
  });

  it('rejects a catalog that merges attributes', async () => {
    await assert.rejects(
      caseNamed('updateCollection replaces attributes and keeps the owner').run(
        fullSubject('merge'),
      ),
    );
  });

  it('rejects a catalog with the wrong missing-record code', async () => {
    await assert.rejects(
      caseNamed(
        'updateCollection on a missing record is RAG_COLLECTION_NOT_FOUND',
      ).run(fullSubject('wrong-code')),
    );
  });

  it('rejects a catalog that accepts an empty patch', async () => {
    await assert.rejects(
      caseNamed('updateCollection refuses an empty patch').run(
        fullSubject('accept-empty'),
      ),
    );
  });

  it('rejects a catalog that only refuses a patch with no keys', async () => {
    await assert.rejects(
      caseNamed('updateCollection refuses an empty patch').run(
        fullSubject('keys-empty'),
      ),
    );
  });

  it('rejects a catalog that accepts a blank collectionName', async () => {
    await assert.rejects(
      caseNamed('updateCollection refuses an invalid collectionName').run(
        fullSubject('accept-blank-name'),
      ),
    );
  });

  it('gives create() fresh SQL-identifier names on every run', async () => {
    const seen: string[] = [];
    const recording: () => Promise<ScanDeleteSubject> = async () => ({
      store: async () => new InMemoryRag(),
      catalog: async () => {
        const inner = fakeCatalog();
        return {
          provider: inner.provider,
          async create(name) {
            seen.push(name);
            await inner.create(name);
          },
        };
      },
    });
    for (let round = 0; round < 2; round++) {
      for (const c of scanDeleteConformanceCases.filter(
        (x) => x.requires === 'catalog',
      )) {
        await c.run(recording);
      }
    }
    assert.ok(seen.length > 0);
    assert.equal(new Set(seen).size, seen.length, 'no name repeats');
    for (const name of seen) {
      assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/);
    }
  });

  it('rejects a deleteWhere that reaches the sibling', async () => {
    const shared = new InMemoryRag();
    await assert.rejects(
      caseNamed('deleteWhere stays inside its collection').run(async () => ({
        store: async () => shared,
        sibling: async () => shared,
      })),
    );
  });
});
