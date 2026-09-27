/**
 * Conformance kit for the identity filter every `IRag` store must honour.
 *
 * `query(embedding, k, { ragFilter })` may carry `sessionId` and/or `userId`
 * (the pipeline's `rag-query` stage sets them for `scope: 'session' | 'user'`).
 * A store that ignores them lets one user's records surface in another
 * user's context. The contract:
 *
 * - `ragFilter.sessionId` set → only records whose `metadata.sessionId`
 *   equals it; a record without `sessionId` is excluded.
 * - `ragFilter.userId` set → the same for `metadata.userId`.
 * - both set → both must match; neither set → no identity filtering.
 * - the filter applies BEFORE top-k: a filtered query still returns up to `k`
 *   matching records.
 *
 * Framework-agnostic: each case throws (`node:assert`) on a violation, so a
 * store package runs them under its own test runner:
 *
 * ```ts
 * for (const c of ragFilterConformanceCases) {
 *   it(c.name, () => c.run(async () => new MyRag({ embedder: conformanceEmbedder() })));
 * }
 * ```
 *
 * Every case asks the factory for a FRESH, empty store and seeds it through
 * `writer().upsertRaw`.
 */

import assert from 'node:assert/strict';
import type { IEmbedder, IRag } from '../interfaces/rag.js';
import type { CallOptions, RagMetadata } from '../interfaces/types.js';

/** A record a conformance case seeds. `metadata.id` identifies it in results. */
export interface ConformanceRecord {
  id: string;
  text: string;
  metadata: RagMetadata;
}

export interface RagFilterConformanceCase {
  readonly name: string;
  run(makeStore: () => Promise<IRag>): Promise<void>;
}

/** Dimension of {@link conformanceEmbedder}'s vectors. */
export const CONFORMANCE_EMBEDDING_DIM = 64;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic bag-of-words embedder: every token lands in one of
 * {@link CONFORMANCE_EMBEDDING_DIM} buckets, and the vector is L2-normalised.
 * Texts that share tokens are close; texts that share none are orthogonal —
 * which the top-k case relies on, and which keeps the conformance texts far
 * apart enough that no store's near-duplicate merge folds two records.
 */
export function conformanceEmbedder(): IEmbedder {
  return {
    async embed(text: string) {
      const v = new Array<number>(CONFORMANCE_EMBEDDING_DIM).fill(0);
      for (const t of tokens(text)) v[hash(t) % CONFORMANCE_EMBEDDING_DIM] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      // A zero vector breaks cosine distance in real backends.
      if (norm === 0) {
        v[0] = 1;
        return { vector: v };
      }
      return { vector: v.map((x) => x / norm) };
    },
  };
}

async function seed(rag: IRag, records: ConformanceRecord[]): Promise<void> {
  const writer = rag.writer?.();
  if (!writer) throw new Error('store under test exposes no writer()');
  for (const r of records) {
    const res = await writer.upsertRaw(r.id, r.text, r.metadata);
    if (!res.ok) throw res.error;
  }
}

async function queryIds(
  rag: IRag,
  text: string,
  k: number,
  ragFilter?: CallOptions['ragFilter'],
): Promise<string[]> {
  const embedder = conformanceEmbedder();
  const res = await rag.query(
    {
      text,
      toVector: async () => (await embedder.embed(text)).vector,
    },
    k,
    ragFilter ? { ragFilter } : undefined,
  );
  if (!res.ok) throw res.error;
  return res.value.map((r) => String(r.metadata.id)).sort();
}

const Q = 'quarterly revenue forecast';

export const ragFilterConformanceCases: readonly RagFilterConformanceCase[] = [
  {
    name: 'sessionId filter isolates two sessions',
    async run(makeStore) {
      const rag = await makeStore();
      await seed(rag, [
        {
          id: 's1-a',
          text: 'alpha harbour lighthouse',
          metadata: { sessionId: 's1' },
        },
        {
          id: 's2-a',
          text: 'bravo mountain glacier',
          metadata: { sessionId: 's2' },
        },
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10, { sessionId: 's1' }), [
        's1-a',
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10, { sessionId: 's2' }), [
        's2-a',
      ]);
    },
  },
  {
    name: 'userId filter isolates two users',
    async run(makeStore) {
      const rag = await makeStore();
      await seed(rag, [
        {
          id: 'u1-a',
          text: 'charlie desert oasis',
          metadata: { userId: 'u1' },
        },
        { id: 'u2-a', text: 'delta forest canopy', metadata: { userId: 'u2' } },
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10, { userId: 'u1' }), ['u1-a']);
      assert.deepEqual(await queryIds(rag, Q, 10, { userId: 'u2' }), ['u2-a']);
    },
  },
  {
    name: 'sessionId and userId together must both match',
    async run(makeStore) {
      const rag = await makeStore();
      await seed(rag, [
        {
          id: 's1u1',
          text: 'echo river delta',
          metadata: { sessionId: 's1', userId: 'u1' },
        },
        {
          id: 's1u2',
          text: 'foxtrot volcano crater',
          metadata: { sessionId: 's1', userId: 'u2' },
        },
        {
          id: 's2u1',
          text: 'golf tundra permafrost',
          metadata: { sessionId: 's2', userId: 'u1' },
        },
      ]);
      assert.deepEqual(
        await queryIds(rag, Q, 10, { sessionId: 's1', userId: 'u1' }),
        ['s1u1'],
      );
    },
  },
  {
    name: 'no identity filter returns records of every session and user',
    async run(makeStore) {
      const rag = await makeStore();
      await seed(rag, [
        {
          id: 's1-a',
          text: 'hotel savanna acacia',
          metadata: { sessionId: 's1', userId: 'u1' },
        },
        {
          id: 's2-a',
          text: 'india reef coral',
          metadata: { sessionId: 's2', userId: 'u2' },
        },
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10), ['s1-a', 's2-a']);
    },
  },
  {
    name: 'a record without sessionId/userId is excluded under that filter',
    async run(makeStore) {
      const rag = await makeStore();
      await seed(rag, [
        {
          id: 'owned',
          text: 'juliet canyon mesa',
          metadata: { sessionId: 's1', userId: 'u1' },
        },
        { id: 'unowned', text: 'kilo prairie bison', metadata: {} },
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10, { sessionId: 's1' }), [
        'owned',
      ]);
      assert.deepEqual(await queryIds(rag, Q, 10, { userId: 'u1' }), ['owned']);
    },
  },
  {
    name: 'the filter applies before top-k: k counts only matching records',
    async run(makeStore) {
      const rag = await makeStore();
      // The s2 records all share tokens with the query; the s1 record shares
      // none, so an unfiltered top-1 is always an s2 record.
      await seed(rag, [
        {
          id: 's2-a',
          text: 'quarterly revenue forecast europe',
          metadata: { sessionId: 's2' },
        },
        {
          id: 's2-b',
          text: 'quarterly revenue forecast asia',
          metadata: { sessionId: 's2' },
        },
        {
          id: 's2-c',
          text: 'quarterly revenue forecast americas',
          metadata: { sessionId: 's2' },
        },
        {
          id: 's1-a',
          text: 'lima penguin iceberg',
          metadata: { sessionId: 's1' },
        },
      ]);
      assert.deepEqual(await queryIds(rag, Q, 1, { sessionId: 's1' }), [
        's1-a',
      ]);
    },
  },
];
