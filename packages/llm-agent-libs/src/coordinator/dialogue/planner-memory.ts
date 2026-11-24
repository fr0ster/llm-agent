import type {
  CallOptions,
  IRagBackendWriter,
  PlannerMemoryEntry,
  SmartAgentError,
} from '@mcp-abap-adt/llm-agent';
import {
  contextExceededError,
  embedDocumentRecords,
  scopedUsage,
  stampRagOwner,
} from '@mcp-abap-adt/llm-agent';
import type { PlannerMemoryOptions } from './planner-retrieval.js';

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
  constructor(
    private readonly sessionId: string,
    private readonly config: PlannerMemoryOptions,
    private readonly warn: (message: string) => void,
    private readonly onOverflow?: (
      requestId: string,
      error: SmartAgentError,
    ) => void,
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
    for (let offset = 0; offset < text.length; ) {
      let end = Math.min(offset + 2_000, text.length);
      if (text[end - 1] === '\r' && text[end] === '\n') end--;
      const boundary = text.charCodeAt(end);
      if (
        boundary >= 0xdc00 &&
        boundary <= 0xdfff &&
        text.codePointAt(end - 1) !== text.charCodeAt(end - 1)
      )
        end--;
      this.queue.push({
        entry: {
          kind,
          requestId,
          sourceId,
          offset,
          text: text.slice(offset, end),
        },
        options: scopedOptions,
      });
      offset = end;
    }
    this.active ??= this.drain().finally(() => {
      this.active = undefined;
    });
  }
  private async drain(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    while (this.queue.length) {
      // Keep attribution and batches tied to one source and turn.
      const first = this.queue.shift();
      if (!first) break;
      const batch = [first];
      while (this.queue[0]?.options === first.options) {
        const next = this.queue.shift();
        if (next) batch.push(next);
      }
      try {
        const options = first.options;
        const signal = options.signal;
        const embeds =
          writer.upsertPrecomputedRaw || writer.upsertManyPrecomputedRaw
            ? await embedDocumentRecords(
                this.config.documentEmbedder,
                batch.map(({ entry }) => entry.text),
                undefined,
                options,
              )
            : undefined;
        signal?.throwIfAborted();
        const items = batch.map(({ entry }, index) => {
          const fragments = embeds?.[index];
          return {
            id: `planner:${this.sessionId}:${entry.kind}:${entry.sourceId}:${entry.offset}`,
            text: entry.text,
            vector:
              fragments?.length === 1
                ? fragments[0].vector
                : (fragments?.map(({ vector }) => vector) ?? []),
            metadata: stampRagOwner(
              {
                kind: entry.kind,
                requestId: entry.requestId,
                sourceId: entry.sourceId,
                offset: entry.offset,
              },
              { scope: 'session', sessionId: this.sessionId },
            ),
          };
        });
        if (embeds && writer.upsertManyPrecomputedRaw) {
          const result = await writer.upsertManyPrecomputedRaw(items, options);
          if (!result.ok) throw result.error;
        } else {
          for (const item of items) {
            signal?.throwIfAborted();
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
        }
      } catch (error) {
        const overflow = contextExceededError(error);
        if (overflow) {
          this.onOverflow?.(first.entry.requestId, overflow);
          this.warn(
            `Planner memory write failed: ${overflow.code}; chunks dropped`,
          );
        } else {
          this.warn('Planner memory write failed; chunks dropped');
        }
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.active;
    if (this.queue.length) await this.drain();
  }
}
