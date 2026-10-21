import type { IRunRecordStore, RunRecord } from '@mcp-abap-adt/llm-agent';

/** Stores only the most recent adaptive run for each session. */
export class InMemoryRunRecordStore implements IRunRecordStore {
  private readonly records = new Map<string, RunRecord>();
  async load(sessionId: string): Promise<RunRecord | undefined> {
    return this.records.get(sessionId);
  }
  async save(sessionId: string, record: RunRecord): Promise<void> {
    this.records.set(sessionId, record);
  }
}
