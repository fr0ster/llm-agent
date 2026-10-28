import type {
  CallOptions,
  IRagBackendWriter,
  PlannerMemoryEntry,
} from '@mcp-abap-adt/llm-agent';
import { scopedUsage } from '@mcp-abap-adt/llm-agent';
import type { PlannerMemoryOptions } from './planner-retrieval.js';
import { withDeadline } from './planner-retrieval.js';

interface QueuedChunk {
  entry: PlannerMemoryEntry;
  options: CallOptions;
}

/** Best-effort live indexing. Restoring a session never calls enqueue. */
export class PlannerMemoryWriter {
  private readonly writer?: IRagBackendWriter;
  private readonly queue: QueuedChunk[] = [];
  private active?: Promise<void>;
  private stopped = false;
  private readonly controller = new AbortController();
  constructor(
    private readonly sessionId: string,
    private readonly config: PlannerMemoryOptions,
    private readonly warn: (message: string) => void,
  ) {
    this.writer = config.rag.writer?.();
    if (!this.writer)
      warn('Planner memory has no writer; using read-only memory');
  }
  enqueue(
    kind: PlannerMemoryEntry['kind'],
    requestId: string,
    sourceId: string,
    text: string,
    options: CallOptions,
  ): void {
    if (!this.writer || this.stopped) return;
    const scopedOptions = {
      ...options,
      sessionId: this.sessionId,
      usage: scopedUsage(options.usage, {
        sessionId: this.sessionId,
        component: 'planner-memory',
      }),
    };
    for (let offset = 0; offset < text.length; offset += 2_000) {
      this.queue.push({
        entry: {
          kind,
          requestId,
          sourceId,
          offset,
          text: text.slice(offset, offset + 2_000),
        },
        options: scopedOptions,
      });
    }
    if (this.queue.length > 200) {
      this.queue.splice(0, this.queue.length - 200);
      this.warn('Planner memory queue full; oldest queued chunks dropped');
    }
    this.active ??= this.drain().finally(() => {
      this.active = undefined;
    });
  }
  private async drain(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    while (this.queue.length && !this.stopped) {
      // Keep attribution and batches tied to one source and turn.
      const first = this.queue.shift();
      if (!first) break;
      const batch = [first];
      while (
        this.queue[0]?.entry.sourceId === first.entry.sourceId &&
        this.queue[0]?.options.usage === first.options.usage
      ) {
        const next = this.queue.shift();
        if (next) batch.push(next);
      }
      try {
        await withDeadline(
          async (signal) => {
            const options = { ...first.options, signal };
            const documents = batch.map(({ entry }) => entry.text);
            const embeds =
              writer.upsertPrecomputedRaw || writer.upsertManyPrecomputedRaw
                ? this.config.documentEmbedder.embedDocuments
                  ? await this.config.documentEmbedder.embedDocuments(
                      documents,
                      options,
                    )
                  : await Promise.all(
                      documents.map((text) =>
                        this.config.documentEmbedder.embedDocument(
                          text,
                          options,
                        ),
                      ),
                    )
                : undefined;
            signal.throwIfAborted();
            if (embeds && embeds.length !== batch.length)
              throw new Error('Invalid embedding batch length');
            const items = batch.map(({ entry }, index) => ({
              id: `planner:${this.sessionId}:${entry.kind}:${entry.sourceId}:${entry.offset}`,
              text: entry.text,
              vector: embeds?.[index].vector ?? [],
              metadata: {
                sessionId: this.sessionId,
                kind: entry.kind,
                requestId: entry.requestId,
                sourceId: entry.sourceId,
                offset: entry.offset,
              },
            }));
            if (embeds && writer.upsertManyPrecomputedRaw) {
              const result = await writer.upsertManyPrecomputedRaw(
                items,
                options,
              );
              if (!result.ok) throw result.error;
            } else
              for (const item of items) {
                signal.throwIfAborted();
                const result =
                  embeds && writer.upsertPrecomputedRaw
                    ? await writer.upsertPrecomputedRaw(
                        item.id,
                        item.text,
                        item.vector,
                        item.metadata,
                        options,
                      )
                    : await writer.upsertRaw(
                        item.id,
                        item.text,
                        item.metadata,
                        options,
                      );
                if (!result.ok) throw result.error;
              }
          },
          30_000,
          this.controller.signal,
        );
      } catch {
        this.warn('Planner memory write failed or timed out; chunks dropped');
      }
    }
  }
  async close(): Promise<void> {
    try {
      await withDeadline(async () => {
        await this.active;
      }, 5_000);
    } catch {
      this.warn(
        'Planner memory close deadline reached; remaining writes dropped',
      );
    } finally {
      this.stopped = true;
      this.queue.length = 0;
      this.controller.abort();
    }
  }
}
