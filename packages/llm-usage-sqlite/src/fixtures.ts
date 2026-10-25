import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
export const metric = (
  id = 'one',
  at = 15,
): Extract<UsageRecord, { kind: `x.${string}` }> => ({
  schema: 1,
  id,
  at,
  kind: 'x.metric',
  context: {
    sessionId: 's',
    userId: 'u',
    turnId: 'turn',
    taskId: 'task',
    role: 'executor',
    destination: 'test',
  },
  outcome: 'ok',
  values: { count: 2 },
});
export async function collect(
  records: AsyncIterable<UsageRecord>,
): Promise<UsageRecord[]> {
  const result: UsageRecord[] = [];
  for await (const r of records) result.push(r);
  return result;
}
