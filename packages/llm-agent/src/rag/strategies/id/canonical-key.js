import { MissingIdError } from '../../corrections/errors.js';
export class CanonicalKeyIdStrategy {
    resolve(metadata, _text) {
        const key = metadata.canonicalKey;
        if (typeof key !== 'string' || key.length === 0) {
            throw new MissingIdError('CanonicalKeyIdStrategy');
        }
        const version = typeof metadata.version === 'number' && metadata.version > 0
            ? metadata.version
            : 1;
        return `${key}:v${version}`;
    }
}
//# sourceMappingURL=canonical-key.js.map