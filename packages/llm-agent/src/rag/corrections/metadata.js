import { RagError } from '../../interfaces/types.js';
export function validateCorrectionMetadata(meta) {
    if (typeof meta.canonicalKey !== 'string' || meta.canonicalKey.length === 0) {
        throw new RagError('CorrectionMetadata.canonicalKey must be a non-empty string', 'RAG_VALIDATION_ERROR');
    }
}
function withTag(meta, tag) {
    const existing = meta.tags ?? [];
    return existing.includes(tag) ? meta : { ...meta, tags: [...existing, tag] };
}
export function deprecateMetadata(current, reason, nowSeconds) {
    validateCorrectionMetadata(current);
    const stamped = {
        ...current,
        deprecatedReason: reason,
        deprecatedAt: nowSeconds ?? Math.floor(Date.now() / 1000),
    };
    return withTag(stamped, 'deprecated');
}
export function buildCorrectionMetadata(input) {
    validateCorrectionMetadata(input.predecessor);
    const predecessor = withTag({
        ...input.predecessor,
        supersededBy: input.newEntryId,
        deprecatedReason: input.reason,
        deprecatedAt: Math.floor(Date.now() / 1000),
    }, 'superseded');
    const next = withTag({
        canonicalKey: input.predecessor.canonicalKey,
        sessionId: input.predecessor.sessionId,
    }, 'correction');
    return { predecessor, next };
}
export function filterActive(items, getMeta, options) {
    if (options?.includeInactive)
        return [...items];
    return items.filter((item) => {
        const tags = getMeta(item)?.tags ?? [];
        return !tags.includes('deprecated') && !tags.includes('superseded');
    });
}
//# sourceMappingURL=metadata.js.map