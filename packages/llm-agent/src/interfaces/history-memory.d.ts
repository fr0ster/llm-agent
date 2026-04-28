export interface IHistoryMemory {
  pushRecent(sessionId: string, summary: string): void;
  getRecent(sessionId: string, limit: number): string[];
  clear(sessionId: string): void;
}
//# sourceMappingURL=history-memory.d.ts.map
