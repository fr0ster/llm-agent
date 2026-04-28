import { randomUUID } from 'node:crypto';
export class GlobalUniqueIdStrategy {
  resolve(metadata, _text) {
    return typeof metadata.id === 'string' && metadata.id.length > 0
      ? metadata.id
      : randomUUID();
  }
}
//# sourceMappingURL=global-unique.js.map
