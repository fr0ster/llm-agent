import { ReadOnlyError } from '../../corrections/errors.js';
export class ImmutableEditStrategy {
  collectionName;
  constructor(collectionName = 'immutable') {
    this.collectionName = collectionName;
  }
  async upsert() {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }
  async deleteById() {
    return { ok: false, error: new ReadOnlyError(this.collectionName) };
  }
}
//# sourceMappingURL=immutable.js.map
