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

export class DirectEditStrategy implements IRagEditor {
  constructor(
    protected readonly writer: IRagBackendWriter,
    protected readonly idStrategy: IIdStrategy,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<{ id: string }, RagError>> {
    let id: string;
    try {
      id = this.idStrategy.resolve(metadata, text);
    } catch (e) {
      if (e instanceof MissingIdError) return { ok: false, error: e };
      throw e;
    }
    const res = await this.writer.upsertRaw(
      id,
      text,
      { ...metadata, id },
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
