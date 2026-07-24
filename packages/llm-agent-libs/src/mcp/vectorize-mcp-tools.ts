/**
 * MCP tool + skill vectorization — extracted from SmartAgentBuilder.build()
 * per docs/ARCHITECTURE.md tech-debt (the builder's MCP block: connect stays
 * in the builder; the vectorization is pulled into this small module).
 *
 * Chunking and retry are properties of the EMBEDDER (composeResilientEmbedder
 * in @mcp-abap-adt/llm-agent-rag's resolveEmbedder), NOT of this file: the
 * batch call below is deliberately naive and carries no batch-size constant.
 *
 * Pure coordinators of catalog components — no builder state, no private fields.
 */

import type {
  CallOptions,
  IEmbedder,
  ILogger,
  IMcpClient,
  IRag,
  IRagBackendWriter,
  IRequestLogger,
  ISkillManager,
  IToolRecordKey,
  LlmTool,
  RagMetadata,
  ToolCatalogStatus,
} from '@mcp-abap-adt/llm-agent';
import {
  DefaultWaitStrategy,
  defaultToolRecordKey,
  isBatchEmbedder,
} from '@mcp-abap-adt/llm-agent';

/**
 * Alias of ToolCatalogStatus, which is declared in `@mcp-abap-adt/llm-agent`
 * so the leaf contracts package need not depend on this one.
 *   total          — tools successfully listed across all clients
 *   clientFailures — clients whose listTools() failed; their tools never
 *                    reached `total`
 *   complete       — false when any client failed to list, or any listed tool
 *                    failed to be written
 */
export type ToolVectorizationSummary = ToolCatalogStatus;

const MAX_NAMES_IN_LOG = 10;

/** Preserved from the previous implementation — see the write loop below. */
const SEQUENTIAL_PACING_EVERY = 5;
const SEQUENTIAL_PACING_MS = 500;
// Stateless; honours signal, including one already aborted (unlike a raw
// addEventListener, which never fires for an event that already dispatched).
const pacingWait = new DefaultWaitStrategy();

interface Acc {
  total: number;
  vectorized: number;
  failed: string[];
  clientFailures: number;
}

function toolText(name: string, description: string | undefined): string {
  return `Tool: ${name} — ${description}`;
}

/**
 * Write one record. A tool counts as vectorized ONLY when the write returns
 * ok: true — the previous optional-chain form treated a missing writer as
 * success.
 *
 * Usage is logged ONLY on the sequential path (`vector === undefined`), where
 * the write itself embeds the text. On the batch path the caller already logged
 * one aggregated record for the whole `embedBatch`; logging here as well would
 * produce N+1 records and inflate reported token usage.
 */
async function writeOne(
  writer: IRagBackendWriter,
  id: string,
  text: string,
  vector: number[] | undefined,
  requestLogger: IRequestLogger,
  detail: 'tools' | 'skills',
  metadata: RagMetadata = {},
  options?: CallOptions,
): Promise<boolean> {
  const start = Date.now();
  const result =
    vector && writer.upsertPrecomputedRaw
      ? await writer.upsertPrecomputedRaw(id, text, vector, metadata, options)
      : await writer.upsertRaw(id, text, metadata, options);
  const ok = result?.ok === true;
  if (ok && vector === undefined) {
    const est = Math.ceil(text.length / 4);
    requestLogger.logLlmCall({
      component: 'embedding',
      model: 'embedder',
      promptTokens: est,
      completionTokens: 0,
      totalTokens: est,
      durationMs: Date.now() - start,
      estimated: true,
      scope: 'initialization',
      detail,
    });
  }
  return ok;
}

export async function vectorizeMcpTools(
  clients: IMcpClient[],
  toolsRag: IRag | undefined,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
  toolRecordKey: IToolRecordKey = defaultToolRecordKey,
  options?: CallOptions,
): Promise<ToolVectorizationSummary | undefined> {
  const writer = toolsRag?.writer?.();
  // No store, or a deliberately read-only one: nothing is attempted, and the
  // status stays unknown rather than reporting a permanently incomplete
  // catalog for a configuration that never intended to write.
  if (!toolsRag || !writer) return undefined;
  // Cancellable: reconnect revectorization carries a request signal, so an
  // aborted request must stop listing, embedding and writing rather than run to
  // completion in the background.
  if (options?.signal?.aborted) return undefined;

  const acc: Acc = { total: 0, vectorized: 0, failed: [], clientFailures: 0 };
  // Why the batch path was abandoned, if it was. Reported once, inside the
  // summary line: swallowing it entirely would hide exactly the provider
  // message that made #236 diagnosable in the first place.
  let batchFailure: string | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: reading the store's private embedder for batch optimisation
  const storeEmbedder = (toolsRag as any).embedder as IEmbedder | undefined;
  const clientCount = clients.length;

  for (let clientIndex = 0; clientIndex < clients.length; clientIndex++) {
    if (options?.signal?.aborted) break;
    const adapter = clients[clientIndex];
    const keyFor = (toolName: string): string => {
      const id = toolRecordKey.key({ toolName, clientIndex, clientCount });
      // Enforce the IToolRecordKey contract at write time: a key without the
      // `tool:` prefix would be written and counted as vectorized, but every
      // retrieval path (toolNameFromRecord) would ignore it — a silent
      // unretrievable record. Fail fast instead.
      if (!id.startsWith('tool:')) {
        throw new Error(
          `IToolRecordKey produced "${id}" for tool "${toolName}"; a tool record id must start with "tool:" so retrieval can tell it apart from skills.`,
        );
      }
      return id;
    };
    // Only listing is guarded at client level. A write that throws must NOT be
    // charged to the client, must not abort the remaining tools, and must land
    // in `failed` — see the per-tool try/catch below.
    let tools: LlmTool[];
    try {
      const toolsResult = await adapter.listTools(options);
      if (!toolsResult.ok) {
        acc.clientFailures++;
        continue;
      }
      tools = toolsResult.value;
    } catch {
      acc.clientFailures++;
      continue;
    }

    acc.total += tools.length;
    const texts = tools.map((t) => toolText(t.name, t.description));
    // Computed once, outside any per-tool try/catch, so an invalid key strategy
    // fails the boot fast rather than landing every tool in `failed`.
    const ids = tools.map((t) => keyFor(t.name));

    let vectors: number[][] | undefined;
    if (
      storeEmbedder &&
      isBatchEmbedder(storeEmbedder) &&
      writer.upsertPrecomputedRaw !== undefined
    ) {
      const start = Date.now();
      try {
        const results = await storeEmbedder.embedBatch(texts, options);
        vectors = results.map((r) => r.vector);
        const real = results.reduce<{ p: number; t: number } | null>(
          (a, r) =>
            r.usage
              ? {
                  p: (a?.p ?? 0) + r.usage.promptTokens,
                  t: (a?.t ?? 0) + r.usage.totalTokens,
                }
              : a,
          null,
        );
        const est = texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0);
        // The ONLY usage record for the batch path; writeOne stays silent when
        // it receives a precomputed vector.
        requestLogger.logLlmCall({
          component: 'embedding',
          model: 'embedder',
          promptTokens: real?.p ?? est,
          completionTokens: 0,
          totalTokens: real?.t ?? est,
          durationMs: Date.now() - start,
          estimated: real === null,
          scope: 'initialization',
          detail: 'tools',
        });
      } catch (err) {
        // Falls through to the sequential path below. Chunking and retry
        // already ran inside the embedder, so reaching here means the
        // provider is genuinely unusable for batch work.
        vectors = undefined;
        batchFailure ??= err instanceof Error ? err.message : String(err);
      }
    }

    // Bulk fast path: when we have precomputed vectors AND the writer supports
    // a native bulk upsert, write the whole catalog in one call instead of N.
    // All-or-nothing, so on failure we fall through to the per-tool loop, which
    // classifies exactly which record is bad.
    if (vectors && writer.upsertManyPrecomputedRaw) {
      const bulk = await writer
        .upsertManyPrecomputedRaw(
          tools.map((t, i) => ({
            id: ids[i],
            text: texts[i],
            vector: (vectors as number[][])[i],
            // Store the name so retrieval recovers it via toolNameFromRecord,
            // independent of the key scheme (default or a custom one).
            metadata: { name: t.name },
          })),
          options,
        )
        .catch((err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err : new Error(String(err)),
        }));
      if (bulk.ok) {
        acc.vectorized += tools.length;
        continue;
      }
      // else: fall through to the per-tool loop below.
    }

    for (let i = 0; i < tools.length; i++) {
      if (options?.signal?.aborted) break;
      let ok = false;
      try {
        ok = await writeOne(
          writer,
          ids[i],
          texts[i],
          vectors?.[i],
          requestLogger,
          'tools',
          { name: tools[i].name },
          options,
        );
      } catch {
        // A throwing write is this tool's failure, not the client's: the loop
        // continues and the name lands in `failed`.
        ok = false;
      }
      if (!ok) acc.failed.push(tools[i].name);
      else acc.vectorized++;

      // Sequential path only: without precomputed vectors each write embeds
      // one text, so this loop is one provider request per tool. Retry reacts
      // only AFTER a 429 and does not throttle successful calls. The pause is
      // kept because removing it strictly increases pressure — not because it
      // is known to be sufficient: it was active during the incident in #236
      // and the boot still logged 385 rate-limit failures.
      if (
        vectors === undefined &&
        (i + 1) % SEQUENTIAL_PACING_EVERY === 0 &&
        i < tools.length - 1
      ) {
        // Cancellable via DefaultWaitStrategy: an already-aborted signal returns
        // immediately, so a request aborted during the preceding write does not
        // sit through the full pause. The next loop iteration then breaks.
        await pacingWait.wait(SEQUENTIAL_PACING_MS, options?.signal);
      }
    }
  }

  const summary: ToolVectorizationSummary = {
    total: acc.total,
    vectorized: acc.vectorized,
    failed: acc.failed,
    clientFailures: acc.clientFailures,
    complete: acc.clientFailures === 0 && acc.failed.length === 0,
  };

  const batchNote = batchFailure
    ? `; batch embedding unavailable, used the sequential fallback: ${batchFailure}`
    : '';

  if (summary.complete) {
    logger?.log({
      type: 'warning',
      traceId: 'builder',
      message: `vectorized ${summary.vectorized}/${summary.total} MCP tools${batchNote}`,
    });
  } else {
    const shown = summary.failed.slice(0, MAX_NAMES_IN_LOG).join(', ');
    const more =
      summary.failed.length > MAX_NAMES_IN_LOG
        ? ` (+${summary.failed.length - MAX_NAMES_IN_LOG} more)`
        : '';
    logger?.log({
      type: 'warning',
      traceId: 'builder',
      message:
        `vectorized ${summary.vectorized}/${summary.total} MCP tools, ` +
        `${summary.failed.length} failed: ${shown}${more}` +
        (summary.clientFailures > 0
          ? `; ${summary.clientFailures} client(s) failed to list tools`
          : '') +
        batchNote,
    });
  }

  return summary;
}

export async function vectorizeSkills(
  skillManager: ISkillManager,
  toolsRag: IRag,
  requestLogger: IRequestLogger,
  logger: ILogger | undefined,
): Promise<void> {
  const writer = toolsRag.writer?.();
  if (!writer) return;
  const skillsResult = await skillManager.listSkills();
  if (!skillsResult.ok) return;
  // Skills keep their per-item warning: unlike the tool catalog, a skill set is
  // small, so there is no log-flooding problem to solve here, and #236's scope
  // is the tool path.
  for (const s of skillsResult.value) {
    const text = `Skill: ${s.name}\n${s.description}`;
    let ok = false;
    try {
      ok = await writeOne(
        writer,
        `skill:${s.name}`,
        text,
        undefined,
        requestLogger,
        'skills',
        { name: s.name },
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      logger?.log({
        type: 'warning',
        traceId: 'builder',
        message: `Skill vectorization failed for "${s.name}"`,
      });
    }
  }
}
