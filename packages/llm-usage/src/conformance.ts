import type { IUsageSink, UsageRecord } from '@mcp-abap-adt/llm-agent';
import type { IUsageReader } from './read.js';

/** Register the selection contract tests for a fresh reader/sink pair. */
export async function usageReaderConformance(
  name: string,
  factory: () =>
    | Promise<IUsageSink & IUsageReader>
    | (IUsageSink & IUsageReader),
): Promise<void> {
  const { test } = await import('node:test');
  const deepEqual: typeof import('node:assert/strict').deepEqual = (
    await import('node:assert/strict')
  ).deepEqual;
  test(`${name}: reader selection and loss evidence`, async () => {
    const sink = await factory();
    const ordinary: UsageRecord = {
      schema: 1,
      id: 'ordinary',
      at: 15,
      kind: 'x.metric',
      context: { sessionId: 's' },
      outcome: 'ok',
      values: {},
    };
    const loss: UsageRecord = {
      ...ordinary,
      id: 'loss',
      at: 100,
      kind: 'x.usage.lost',
      values: { affectedFrom: 5, affectedTo: 15, 'llm.call': 1 },
    };
    try {
      await sink.write([
        ordinary,
        ordinary,
        loss,
        { ...loss, id: 'global', context: { sessionId: '' } },
        { ...loss, id: 'other', context: { sessionId: 'other' } },
      ]);
      const collect = async (records: AsyncIterable<UsageRecord>) => {
        const ids: string[] = [];
        for await (const r of records) ids.push(r.id);
        return ids.sort();
      };
      deepEqual(
        await collect(
          sink.read({ from: 10, to: 20, sessionId: 's', kinds: ['llm.call'] }),
        ),
        ['global', 'loss'],
      );
      deepEqual(
        await collect(sink.read({ from: 10, to: 20, sessionId: 's' })),
        ['global', 'loss', 'ordinary'],
      );
      deepEqual(await collect(sink.read({ from: 20, to: 30 })), []);
      deepEqual(
        await collect(
          sink.read({ from: 0, to: 15, kinds: ['x.metric'], sessionId: 's' }),
        ),
        ['global', 'loss'],
      );
    } finally {
      await sink.close?.();
    }
  });
}
