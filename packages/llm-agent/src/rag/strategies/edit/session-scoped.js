import { MissingIdError } from '../../corrections/errors.js';
/**
 * Stamps sessionId (and createdAt if missing) on every write before delegating
 * to the overlay writer. Pairs with SessionScopedRag on the read side.
 */
export class SessionScopedEditStrategy {
  writer;
  sessionId;
  idStrategy;
  _ttlMs;
  constructor(writer, sessionId, idStrategy, _ttlMs) {
    this.writer = writer;
    this.sessionId = sessionId;
    this.idStrategy = idStrategy;
    this._ttlMs = _ttlMs;
  }
  async upsert(text, metadata, options) {
    const stamped = {
      ...metadata,
      sessionId: this.sessionId,
      createdAt:
        typeof metadata.createdAt === 'number'
          ? metadata.createdAt
          : Date.now(),
    };
    let id;
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
  async deleteById(id, options) {
    return this.writer.deleteByIdRaw(id, options);
  }
  async clear() {
    if (this.writer.clearAll) return this.writer.clearAll();
    return { ok: true, value: undefined };
  }
}
//# sourceMappingURL=session-scoped.js.map
