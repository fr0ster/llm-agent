import {
  type ISessionBindingStore,
  SessionBindingConflictError,
} from '../../interfaces/rag-access.js';
import type { Result } from '../../interfaces/types.js';

export class InMemorySessionBindingStore implements ISessionBindingStore {
  private readonly bindings = new Map<string, string>();

  async bind(
    sessionId: string,
    userId: string,
  ): Promise<Result<void, SessionBindingConflictError>> {
    if (
      this.bindings.has(sessionId) &&
      this.bindings.get(sessionId) !== userId
    ) {
      return { ok: false, error: new SessionBindingConflictError() };
    }
    // No await between checking and setting: competing calls cannot rebind.
    this.bindings.set(sessionId, userId);
    return { ok: true, value: undefined };
  }
}
