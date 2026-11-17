export interface IHistoryMemory {
  pushRecent(sessionId: string, summary: string): void;
  getRecent(sessionId: string, limit: number): string[];
  clear(sessionId: string): void;
  /** Clear every caller identity belonging to this session. */
  clearSession?(sessionId: string): void;
}
