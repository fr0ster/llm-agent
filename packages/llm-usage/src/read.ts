import type { UsageRecord } from '@mcp-abap-adt/llm-agent';

export interface UsageQuery {
  from: number;
  to: number;
  kinds?: string[];
  sessionId?: string;
}
export interface IUsageReader {
  read(query: UsageQuery): AsyncIterable<UsageRecord>;
}

export function matchesUsage(record: UsageRecord, q: UsageQuery): boolean {
  if (record.kind === 'x.usage.lost' && 'values' in record) {
    return (
      Number(record.values.affectedFrom) < q.to &&
      Number(record.values.affectedTo) >= q.from &&
      (q.sessionId === undefined ||
        !record.context.sessionId ||
        record.context.sessionId === q.sessionId)
    );
  }
  return (
    record.at >= q.from &&
    record.at < q.to &&
    (!q.kinds || q.kinds.includes(record.kind)) &&
    (q.sessionId === undefined || record.context.sessionId === q.sessionId)
  );
}

export async function* selectUsage(
  records: AsyncIterable<UsageRecord> | Iterable<UsageRecord>,
  query: UsageQuery,
): AsyncIterable<UsageRecord> {
  const seen = new Set<string>();
  for await (const record of records) {
    if (!seen.has(record.id) && matchesUsage(record, query)) {
      seen.add(record.id);
      yield structuredClone(record);
    }
  }
}

export const USAGE_CSV_COLUMNS = [
  'schema',
  'id',
  'at',
  'kind',
  'outcome',
  'errorCode',
  'context.sessionId',
  'context.userId',
  'context.turnId',
  'context.taskId',
  'context.requestId',
  'context.traceId',
  'context.role',
  'context.destination',
  'operationId',
  'physicalSeq',
  'outerAttempt',
  'providerAttempt',
  'chunkPath',
  'granularity',
  'retriesVisible',
  'provider',
  'model',
  'stream',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'tokensSource',
  'durationMs',
  'firstTokenMs',
  'throttledMs',
  'closedEarly',
  'inputs',
  'inputChars',
  'inputMessages',
  'systemMessages',
  'userMessages',
  'assistantMessages',
  'toolMessages',
  'systemChars',
  'userChars',
  'assistantChars',
  'toolChars',
  'toolDefs',
  'toolDefsChars',
  'server',
  'tool',
  'dispatched',
  'embedded',
  'transportOutcome',
  'toolOutcome',
  'requestBytes',
  'responseBytes',
  'taskId',
  'worker',
  'state',
  'queuedMs',
  'runMs',
  'endKnown',
  'toolCalls',
  'budgetExhausted',
  'values.affectedFrom',
  'values.affectedTo',
  'values.unconfirmed',
  'values.llm.call',
  'values.embedding.call',
  'values.tool.call',
  'values.task',
  'values',
  'loss_evidence',
] as const;

/** CSV uses fixed columns; extension values are flattened as values.* in its JSON cell. */
export async function* exportRecords(
  records: AsyncIterable<UsageRecord>,
  format: 'jsonl' | 'csv',
): AsyncIterable<string> {
  const seen = new Set<string>();
  const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  if (format === 'csv') yield `${USAGE_CSV_COLUMNS.join(',')}\n`;
  for await (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    if (format === 'jsonl') {
      yield `${JSON.stringify(record)}\n`;
      continue;
    }
    const flat: Record<string, unknown> = { ...record };
    for (const [key, value] of Object.entries(record.context))
      flat[`context.${key}`] = value;
    if ('values' in record) {
      for (const [key, value] of Object.entries(record.values))
        flat[`values.${key}`] = value;
      flat.values = JSON.stringify(
        Object.fromEntries(
          Object.entries(record.values).map(([k, v]) => [`values.${k}`, v]),
        ),
      );
    }
    flat.loss_evidence = record.kind === 'x.usage.lost';
    yield `${USAGE_CSV_COLUMNS.map((k) => quote(flat[k])).join(',')}\n`;
  }
}
