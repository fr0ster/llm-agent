import type {
  IIdStrategy,
  IRagBackendWriter,
  IRagEditor,
} from '../../../interfaces/rag.js';
import type {
  CallOptions,
  RagError,
  RagMetadata,
  Result,
} from '../../../interfaces/types.js';
import { MissingIdError } from '../../corrections/errors.js';

/**
 * Stamps sessionId (and createdAt if missing) on every write before delegating
 * to the overlay writer. Pairs with SessionScopedRag on the read side.
 */
export class SessionScopedEditStrategy implements IRagEditor {
  constructor(
    private readonly writer: IRagBackendWriter,
    private readonly sessionId: string,
    private readonly idStrategy: IIdStrategy,
    readonly _ttlMs?: number,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    const stamped: RagMetadata = {
      ...metadata,
      sessionId: this.sessionId,
      createdAt:
        typeof metadata.createdAt === 'number'
          ? metadata.createdAt
          : Date.now(),
    };
    let id: string;
    try {
      id = this.idStrategy.resolve(stamped, text);
    } catch (e) {
      if (e instanceof MissingIdError) return { ok: false, error: e };
      throw e;
    }
    const res = await this.writer.upsertRaw(
      id,
      text,
      { ...stamped, id },
      options,
    );
    return res.ok ? { ok: true, value: { id } } : res;
  }

  async deleteById(
    id: string,
    options?: CallOptions,
  ): Promise<Result<boolean, RagError>> {
    return this.writer.deleteByIdRaw(id, options);
  }

  async clear(): Promise<Result<void, RagError>> {
    if (this.writer.clearAll) return this.writer.clearAll();
    return { ok: true, value: undefined };
  }
}
