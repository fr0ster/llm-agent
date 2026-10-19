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

/** A store name is a non-empty string; anything else is `INVALID_ARGUMENT`. */
export function validateRagStoreName(
  storeName: unknown,
): Result<void, RagError> {
  return typeof storeName === 'string' && storeName.trim() !== ''
    ? { ok: true, value: undefined }
    : {
        ok: false,
        error: new RagError(
          'updateCollection storeName must be a non-empty string',
          INVALID_ARGUMENT,
        ),
      };
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
    Array.isArray(patch) ||
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
  const given: unknown = patch.attributes;
  if (
    given !== undefined &&
    (typeof given !== 'object' || given === null || Array.isArray(given))
  ) {
    return {
      ok: false,
      error: new RagError(
        'updateCollection attributes must be an object',
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
