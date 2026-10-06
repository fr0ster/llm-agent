// packages/llm-agent-libs/src/collections/__tests__/staged-retrieval-helpers.ts
// Shared fixtures for the StagedRetrieval tests; not a *.test.ts file, so the runner skips it.
import {
  type IRag,
  type RagJsonValue,
  type RagResult,
  type RecordDraft,
  type RecordOwner,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import { prepareItem, storeItems } from '../record-writer.js';

export const G: RecordOwner = { scope: 'global' };

/** Write one item through the real write path; the first record is the canonical one. Throws when the item is not indexed. */
export async function put(
  rag: IRag,
  itemId: string,
  records: Array<[kind: string, text: string]>,
  opts: {
    owner?: RecordOwner;
    data?: RagJsonValue;
    canonicalKind?: string;
  } = {},
): Promise<void> {
  const owner = opts.owner ?? G;
  const [canonical] = records;
  const drafts: RecordDraft[] = records.map(([kind, text], i) => ({
    text,
    itemId,
    recordKind: kind,
    owner,
    ...(i === 0
      ? opts.data !== undefined
        ? { metadata: { data: opts.data } }
        : {}
      : { itemText: canonical[1] }),
  }));
  const p = prepareItem(
    { itemId, drafts },
    {
      canonicalKind: opts.canonicalKind ?? canonical[0],
      profile: 'test',
      maxRecordsPerItem: 10,
    },
  );
  if (!p.ok) throw new Error(p.reason);
  // A fixture that failed to land must fail the test, never leave the store silently short.
  const stored = await storeItems(rag, [p.item]);
  if (stored.rejected) throw stored.rejected;
  if (!stored.indexed[0]) {
    throw new Error(
      `put ${itemId}: not indexed — ${stored.failures[0] ?? stored.batchFailure ?? 'no reason'}`,
    );
  }
}

/** InMemoryRag returns zero-score records too; tests want only real matches. */
export function matchesOnly(rag: IRag, seenK: number[] = []): IRag {
  return {
    query: async (q, k, o) => {
      seenK.push(k);
      const r = await rag.query(q, k, o);
      return r.ok ? { ok: true, value: r.value.filter((x) => x.score > 0) } : r;
    },
    healthCheck: (o) => rag.healthCheck(o),
    getById: (id, o) => rag.getById(id, o),
    writer: () => rag.writer?.(),
  };
}

export const q = (text: string) => new TextOnlyEmbedding(text);
export const ids = (r: { ok: boolean; value?: RagResult[] }) =>
  r.ok ? (r.value ?? []).map((x) => x.metadata.id) : r;

/** Sets each hit's stage-1 score by its item id (others keep theirs) and re-sorts:
 *  the test chooses the scores. `rag` is an object-literal IRag (e.g. `matchesOnly`'s). */
export function scored(
  rag: IRag,
  byItem: Readonly<Record<string, number>>,
): IRag {
  return {
    ...rag,
    query: async (q, k, o) => {
      const r = await rag.query(q, k, o);
      if (!r.ok) return r;
      const value = r.value
        .map((x) => ({
          ...x,
          score: byItem[String(x.metadata.itemId)] ?? x.score,
        }))
        .sort((a, b) => b.score - a.score);
      return { ok: true, value };
    },
  };
}
