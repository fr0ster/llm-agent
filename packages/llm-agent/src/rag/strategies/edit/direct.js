import { MissingIdError } from '../../corrections/errors.js';
export class DirectEditStrategy {
  writer;
  idStrategy;
  constructor(writer, idStrategy) {
    this.writer = writer;
    this.idStrategy = idStrategy;
  }
  async upsert(text, metadata, options) {
    let id;
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
  async deleteById(id, options) {
    return this.writer.deleteByIdRaw(id, options);
  }
  async clear() {
    if (this.writer.clearAll) return this.writer.clearAll();
    return { ok: true, value: undefined };
  }
}
//# sourceMappingURL=direct.js.map
