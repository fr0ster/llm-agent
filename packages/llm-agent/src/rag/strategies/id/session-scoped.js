import { randomUUID } from 'node:crypto';
export class SessionScopedIdStrategy {
  sessionId;
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
  resolve(metadata, _text) {
    const suffix =
      (typeof metadata.id === 'string' && metadata.id) ||
      (typeof metadata.canonicalKey === 'string' && metadata.canonicalKey) ||
      randomUUID();
    return `${this.sessionId}:${suffix}`;
  }
}
//# sourceMappingURL=session-scoped.js.map
