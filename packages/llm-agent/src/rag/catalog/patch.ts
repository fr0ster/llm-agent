import {
  INVALID_ARGUMENT,
  RAG_COLLECTION_NOT_FOUND,
  type RagCatalogPatch,
} from '../../interfaces/rag-scan.js';
import { RagError, type Result } from '../../interfaces/types.js';
import { encodeRagAttributes, validateRagAttributes } from './validation.js';

/** A catalog patch checked before any call; an absent field keeps its value. */
export interface ValidatedRagCatalogPatch {
  /** The new display name: a non-empty string. */
  collectionName?: string;
  /** The new attributes, as `encodeRagAttributes` stores them. */
  attributesJson?: string | null;
}

/**
 * The checks every `IRagCatalogUpdater.updateCollection` runs before any
 * call: an empty patch (no key, or only undefined values) is
 * `INVALID_ARGUMENT`; a `collectionName` that is not a non-empty string
 * (`''`, whitespace only, `null`, a number) is `INVALID_ARGUMENT`, since the
 * catalog would reject the record on the next read; `attributes` are checked
 * as on create (`RAG_INVALID_ATTRIBUTES`) and encoded the same way.
 */
export function validateRagCatalogPatch(
  patch: RagCatalogPatch,
): Result<ValidatedRagCatalogPatch, RagError> {
  if (
    typeof patch !== 'object' ||
    patch === null ||
    (patch.collectionName === undefined && patch.attributes === undefined)
  ) {
    return {
      ok: false,
      error: new RagError(
        'updateCollection needs collectionName or attributes',
        INVALID_ARGUMENT,
      ),
    };
  }
  const name: unknown = patch.collectionName;
  if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
    return {
      ok: false,
      error: new RagError(
        'updateCollection collectionName must be a non-empty string',
        INVALID_ARGUMENT,
      ),
    };
  }
  const attributes = validateRagAttributes(patch.attributes);
  if (!attributes.ok) return attributes;
  return {
    ok: true,
    value: {
      ...(name === undefined ? {} : { collectionName: name }),
      ...(patch.attributes === undefined
        ? {}
        : { attributesJson: encodeRagAttributes(attributes.value) }),
    },
  };
}

/** The refusal for a catalog record that does not exist. */
export function ragCollectionNotFound(storeName: string): {
  ok: false;
  error: RagError;
} {
  return {
    ok: false,
    error: new RagError(
      `no catalog record for store '${storeName}'`,
      RAG_COLLECTION_NOT_FOUND,
    ),
  };
}
