import { MissingIdError } from '../../corrections/errors.js';
export class CallerProvidedIdStrategy {
  resolve(metadata, _text) {
    if (typeof metadata.id !== 'string' || metadata.id.length === 0) {
      throw new MissingIdError('CallerProvidedIdStrategy');
    }
    return metadata.id;
  }
}
//# sourceMappingURL=caller-provided.js.map
