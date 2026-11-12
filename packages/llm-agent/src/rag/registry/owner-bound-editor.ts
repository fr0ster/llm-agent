import type { IRagEditor, RagCollectionOwner } from '../../interfaces/rag.js';
import { RagAccessDeniedError } from '../../interfaces/rag-access.js';
import type { RagMetadata } from '../../interfaces/types.js';

/** Stamp at the registry boundary, before ID generation and every edit strategy. */
export function stampRagOwner(
  metadata: RagMetadata,
  owner: RagCollectionOwner,
): RagMetadata {
  const tags: RagMetadata = {
    ownerScope: owner.scope,
    ...(owner.scope === 'session' ? { sessionId: owner.sessionId } : {}),
    ...(owner.scope === 'user' ? { userId: owner.userId } : {}),
  };
  for (const key of ['ownerScope', 'sessionId', 'userId', 'roleId'] as const) {
    if (key in metadata && (!(key in tags) || metadata[key] !== tags[key]))
      throw new RagAccessDeniedError(
        'Record owner conflicts with collection owner',
      );
  }
  return { ...metadata, ...tags };
}

export function ownerBoundEditor(
  editor: IRagEditor,
  owner: RagCollectionOwner,
): IRagEditor {
  const clear = editor.clear?.bind(editor);
  return {
    async upsert(text, metadata, options) {
      try {
        return await editor.upsert(
          text,
          stampRagOwner(metadata, owner),
          options,
        );
      } catch (error) {
        if (error instanceof RagAccessDeniedError) return { ok: false, error };
        throw error;
      }
    },
    deleteById: (id, options) => editor.deleteById(id, options),
    ...(clear ? { clear } : {}),
  };
}
