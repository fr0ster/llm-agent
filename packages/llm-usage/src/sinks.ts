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
}): IUsageSink &
  IUsageReader & { close(): Promise<void>; stats(): { skippedLines: number } } {
  let serial = Promise.resolve();
  let rotation = 0;
  let skippedLines = 0;
  let needsNewline = false;
  let initializationFailure: { error: unknown } | undefined;
  const ids = new Set<string>();
  async function* all(initializing = false): AsyncIterable<UsageRecord> {
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
      if (initializing && file === name)
        needsNewline = data.length > 0 && !data.endsWith('\n');
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let record: UsageRecord;
        try {
          record = JSON.parse(line) as UsageRecord;
        } catch {
          if (initializing) skippedLines++;
          continue;
        }
        yield record;
      }
    }
  }
  const ready = (async () => {
    for await (const record of all(true)) ids.add(record.id);
  })().catch((error: unknown) => {
    initializationFailure = { error };
  });
  return {
    stats() {
      return { skippedLines };
    },
    write(batch) {
      const snapshot = structuredClone([...batch]);
      const write = serial.then(async () => {
        await ready;
        if (initializationFailure) {
          const { error } = initializationFailure;
          const failure = new UsageDeliveryError(
            error instanceof Error ? error.message : String(error),
            false,
            (error as NodeJS.ErrnoException | null)?.code,
          );
          failure.cause = error;
          throw failure;
        }
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
            needsNewline = false;
          }
          await appendFile(
            options.path,
            `${needsNewline ? '\n' : ''}${line}`,
            'utf8',
          );
          needsNewline = false;
          ids.add(record.id);
        }
      });
      serial = write.catch(() => {});
      return write;
    },
    async *read(query) {
      await serial;
      await ready;
      if (initializationFailure) throw initializationFailure.error;
      yield* selectUsage(all(), query);
    },
    async close() {
      await serial;
      await ready;
      if (initializationFailure) throw initializationFailure.error;
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
