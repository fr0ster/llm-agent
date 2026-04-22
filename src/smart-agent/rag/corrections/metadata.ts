import { RagError } from '../../interfaces/types.js';

export type CorrectionTag =
  | 'verified'
  | 'deprecated'
  | 'superseded'
  | 'correction';

export interface CorrectionMetadata {
  canonicalKey: string;
  tags?: CorrectionTag[];
  sessionId?: string;
  supersededBy?: string;
  deprecatedAt?: number;
  deprecatedReason?: string;
}

export function validateCorrectionMetadata(meta: CorrectionMetadata): void {
  if (typeof meta.canonicalKey !== 'string' || meta.canonicalKey.length === 0) {
    throw new RagError(
      'CorrectionMetadata.canonicalKey must be a non-empty string',
      'RAG_VALIDATION_ERROR',
    );
  }
}

function withTag(
  meta: CorrectionMetadata,
  tag: CorrectionTag,
): CorrectionMetadata {
  const existing = meta.tags ?? [];
  return existing.includes(tag) ? meta : { ...meta, tags: [...existing, tag] };
}

export function deprecateMetadata(
  current: CorrectionMetadata,
  reason: string,
  nowSeconds?: number,
): CorrectionMetadata {
  validateCorrectionMetadata(current);
  const stamped: CorrectionMetadata = {
    ...current,
    deprecatedReason: reason,
    deprecatedAt: nowSeconds ?? Math.floor(Date.now() / 1000),
  };
  return withTag(stamped, 'deprecated');
}

export function buildCorrectionMetadata(input: {
  predecessor: CorrectionMetadata;
  predecessorId: string;
  newEntryId: string;
  reason: string;
}): { predecessor: CorrectionMetadata; next: CorrectionMetadata } {
  validateCorrectionMetadata(input.predecessor);
  const predecessor = withTag(
    {
      ...input.predecessor,
      supersededBy: input.newEntryId,
      deprecatedReason: input.reason,
      deprecatedAt: Math.floor(Date.now() / 1000),
    },
    'superseded',
  );
  const next: CorrectionMetadata = withTag(
    {
      canonicalKey: input.predecessor.canonicalKey,
      sessionId: input.predecessor.sessionId,
    },
    'correction',
  );
  return { predecessor, next };
}

export function filterActive<T>(
  items: readonly T[],
  getMeta: (item: T) => CorrectionMetadata | undefined,
  options?: { includeInactive?: boolean },
): T[] {
  if (options?.includeInactive) return [...items];
  return items.filter((item) => {
    const tags = getMeta(item)?.tags ?? [];
    return !tags.includes('deprecated') && !tags.includes('superseded');
  });
}
