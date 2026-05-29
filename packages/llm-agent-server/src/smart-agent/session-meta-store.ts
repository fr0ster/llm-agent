export interface SessionMetaRow {
  sessionId: string;
  userIdentity: string | null;
  title?: string;
  createdAt: string;
  lastUsedAt?: string;
  status: 'idle' | 'in-progress' | 'drained';
  promptCount?: number;
}

export interface ISessionMetaStore {
  create(row: SessionMetaRow): Promise<void>;
  get(sessionId: string): Promise<SessionMetaRow | undefined>;
  listForUser(userIdentity: string): Promise<SessionMetaRow[]>;
  touch(sessionId: string, at: string): Promise<void>;
  setStatus(sessionId: string, status: SessionMetaRow['status']): Promise<void>;
  delete(sessionId: string): Promise<void>;
  inProgressSessions(): Promise<SessionMetaRow[]>;
}

export class InMemorySessionMetaStore implements ISessionMetaStore {
  private readonly rows = new Map<string, SessionMetaRow>();
  async create(row: SessionMetaRow) {
    this.rows.set(row.sessionId, { ...row });
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? { ...r } : undefined;
  }
  async listForUser(u: string) {
    return [...this.rows.values()]
      .filter((r) => r.userIdentity === u)
      .map((r) => ({ ...r }));
  }
  async touch(id: string, at: string) {
    const r = this.rows.get(id);
    if (r) r.lastUsedAt = at;
  }
  async setStatus(id: string, status: SessionMetaRow['status']) {
    const r = this.rows.get(id);
    if (r) r.status = status;
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async inProgressSessions() {
    return [...this.rows.values()]
      .filter((r) => r.status === 'in-progress')
      .map((r) => ({ ...r }));
  }
}

// Note: A PgSessionMetaStore (using the existing pg client from pg-vector-rag) ships behind
// config in a later commit. The in-memory store is the default for v1.
