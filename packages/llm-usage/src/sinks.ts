import { appendFile, readdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  type IUsageSink,
  UsageDeliveryError,
  type UsageRecord,
} from '@mcp-abap-adt/llm-agent';
import { type IUsageReader, selectUsage } from './read.js';

export function memorySink(options: {
  limit: number;
  evict?: boolean;
}): IUsageSink & IUsageReader {
  const records = new Map<string, UsageRecord>();
  if (!Number.isInteger(options.limit) || options.limit < 1)
    throw new RangeError('limit must be positive');
  return {
    async write(batch) {
      const additions = new Map(
        batch
          .filter((r) => !records.has(r.id))
          .map((r) => [r.id, structuredClone(r)]),
      );
      if (
        options.evict === false &&
        records.size + additions.size > options.limit
      ) {
        throw new UsageDeliveryError('Memory sink is full', false, 'SINK_FULL');
      }
      for (const [id, record] of additions) {
        records.set(id, record);
        while (records.size > options.limit)
          records.delete(records.keys().next().value as string);
      }
    },
    read(query) {
      return selectUsage(records.values(), query);
    },
  };
}

export function jsonlFileSink(options: {
  path: string;
  rotateBytes: number;
}): IUsageSink & IUsageReader {
  let serial = Promise.resolve();
  let rotation = 0;
  const ids = new Set<string>();
  async function* all(): AsyncIterable<UsageRecord> {
    const dir = dirname(options.path);
    const name = basename(options.path);
    let files: string[];
    try {
      files = (await readdir(dir))
        .filter(
          (f) =>
            f === name ||
            (f.startsWith(`${name}.`) &&
              /^\d+\.\d+$/.test(f.slice(name.length + 1))),
        )
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const file of files) {
      const data = await readFile(join(dir, file), 'utf8');
      for (const line of data.split('\n'))
        if (line.trim()) yield JSON.parse(line) as UsageRecord;
    }
  }
  const ready = (async () => {
    for await (const record of all()) ids.add(record.id);
  })();
  return {
    write(batch) {
      const snapshot = structuredClone([...batch]);
      const write = serial.then(async () => {
        await ready;
        for (const record of snapshot) {
          if (ids.has(record.id)) continue;
          const line = `${JSON.stringify(record)}\n`;
          let bytes = 0;
          try {
            bytes = (await stat(options.path)).size;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (
            bytes > 0 &&
            bytes + Buffer.byteLength(line) > options.rotateBytes
          ) {
            await rename(
              options.path,
              `${options.path}.${Date.now()}.${rotation++}`,
            );
          }
          await appendFile(options.path, line, 'utf8');
          ids.add(record.id);
        }
      });
      serial = write.catch(() => {});
      return write;
    },
    async *read(query) {
      await serial;
      await ready;
      yield* selectUsage(all(), query);
    },
    async close() {
      await serial;
      await ready;
    },
  };
}

export function combineSinks(...sinks: IUsageSink[]): IUsageSink {
  return {
    async write(batch) {
      const results = await Promise.allSettled(
        sinks.map((sink) => Promise.resolve().then(() => sink.write(batch))),
      );
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length) {
        const possible = results.some(
          (r) =>
            r.status === 'fulfilled' ||
            !(r.reason instanceof UsageDeliveryError) ||
            r.reason.possiblyDelivered,
        );
        throw new UsageDeliveryError('Combined sink write failed', possible);
      }
    },
    async close() {
      await Promise.all(sinks.map((sink) => sink.close?.()));
    },
  };
}
