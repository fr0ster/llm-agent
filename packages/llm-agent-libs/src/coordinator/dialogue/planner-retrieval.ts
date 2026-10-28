import type {
  CallOptions,
  IDocumentEmbedder,
  IPlannerKnowledge,
  IQueryEmbedder,
  IQueryEmbedding,
  IRag,
  PlannerKnowledgeEntry,
  PlannerMemoryEntry,
} from '@mcp-abap-adt/llm-agent';
import { QueryEmbedding, scopedUsage } from '@mcp-abap-adt/llm-agent';

export interface PlannerMemoryOptions {
  rag: IRag;
  queryEmbedder: IQueryEmbedder;
  documentEmbedder: IDocumentEmbedder;
  embeddingKey?: string;
}
export interface PlannerRetrievalOptions {
  plannerMemory?: PlannerMemoryOptions;
  plannerKnowledge?: IPlannerKnowledge[];
  memoryK?: number;
  knowledgeK?: number;
  memoryCharBudget?: number;
  knowledgeCharBudget?: number;
  retrievalTimeoutMs?: number;
}

/** A shared, read-only collection; no session identity filter is applied. */
export class RagPlannerKnowledge implements IPlannerKnowledge {
  constructor(
    readonly name: string,
    private readonly rag: IRag,
    readonly queryEmbedder: IQueryEmbedder,
    readonly embeddingKey?: string,
  ) {}
  async search(
    query: { text: string; embedding?: IQueryEmbedding },
    k: number,
    options?: CallOptions,
  ): Promise<PlannerKnowledgeEntry[]> {
    const result = await this.rag.query(
      query.embedding ??
        new QueryEmbedding(query.text, this.queryEmbedder, options),
      k,
      options,
    );
    if (!result.ok) throw result.error;
    return result.value.map((entry) => ({
      collection: this.name,
      id: entry.metadata.id ?? '',
      text: entry.text,
    }));
  }
}

export function validateRetrievalOptions(
  options: PlannerRetrievalOptions,
): void {
  if ((options.plannerKnowledge?.length ?? 0) > 10)
    throw new Error('At most 10 planner knowledge collections are supported');
  for (const [name, value, maximum] of [
    ['memoryK', options.memoryK ?? 8, 20],
    ['knowledgeK', options.knowledgeK ?? 4, 10],
    ['memoryCharBudget', options.memoryCharBudget ?? 12_000, 12_000],
    ['knowledgeCharBudget', options.knowledgeCharBudget ?? 12_000, 12_000],
    [
      'retrievalTimeoutMs',
      options.retrievalTimeoutMs ?? 3_000,
      Number.MAX_SAFE_INTEGER,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
}

/** Bound even implementations that ignore cancellation; observe late rejections. */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeout: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([controller.signal, parent])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return work(signal);
      }),
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(new Error('Planner operation cancelled or timed out'));
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => controller.abort(), timeout);
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

export async function retrievePlannerContext(
  config: PlannerRetrievalOptions,
  sessionId: string,
  requestId: string,
  text: string,
  elided: boolean,
  options: CallOptions,
  warn: (message: string) => void,
): Promise<{
  memory: PlannerMemoryEntry[];
  knowledge: PlannerKnowledgeEntry[];
}> {
  const query = text.slice(0, 2_000);
  const memory = config.plannerMemory;
  const sources = config.plannerKnowledge ?? [];
  const first = sources[0];
  const embedder =
    memory?.queryEmbedder ??
    (first instanceof RagPlannerKnowledge ? first.queryEmbedder : undefined);
  const key = memory ? memory.embeddingKey : first?.embeddingKey;
  const call = {
    ...options,
    sessionId,
    usage: scopedUsage(options.usage, {
      sessionId,
      component: 'planner-retrieval',
    }),
  };
  const output: {
    memory: PlannerMemoryEntry[];
    knowledge: PlannerKnowledgeEntry[];
  } = { memory: [], knowledge: [] };
  try {
    await withDeadline(
      async (signal) => {
        const scoped = { ...call, signal };
        const embedding = embedder
          ? new QueryEmbedding(query, embedder, scoped)
          : undefined;
        const jobs: Promise<void>[] = [];
        if (memory && embedding)
          jobs.push(
            (async () => {
              try {
                const result = await memory.rag.query(
                  embedding,
                  2 * (config.memoryK ?? 8),
                  { ...scoped, ragFilter: { sessionId } },
                );
                signal.throwIfAborted();
                if (!result.ok) throw result.error;
                output.memory = result.value
                  .flatMap((entry): PlannerMemoryEntry[] => {
                    const meta = entry.metadata;
                    const kind = meta.kind;
                    if (
                      meta.sessionId !== sessionId ||
                      (meta.requestId === requestId && !elided)
                    )
                      return [];
                    if (
                      kind !== 'planner-input' &&
                      kind !== 'planner-reply' &&
                      kind !== 'planner-task' &&
                      kind !== 'planner-plan'
                    )
                      return [];
                    if (
                      typeof meta.requestId !== 'string' ||
                      typeof meta.sourceId !== 'string' ||
                      typeof meta.offset !== 'number'
                    )
                      return [];
                    return [
                      {
                        kind,
                        requestId: meta.requestId,
                        sourceId: meta.sourceId,
                        offset: meta.offset,
                        text: entry.text,
                      },
                    ];
                  })
                  .slice(0, config.memoryK ?? 8);
              } catch {
                warn('Planner memory retrieval failed or timed out');
              }
            })(),
          );
        const knowledgeResults: PlannerKnowledgeEntry[][] = sources.map(
          () => [],
        );
        for (const [index, source] of sources.entries())
          jobs.push(
            (async () => {
              try {
                const entries = await source.search(
                  {
                    text: query,
                    ...(key !== undefined &&
                    source.embeddingKey === key &&
                    embedding
                      ? { embedding }
                      : {}),
                  },
                  config.knowledgeK ?? 4,
                  scoped,
                );
                signal.throwIfAborted();
                knowledgeResults[index] = entries
                  .slice(0, config.knowledgeK ?? 4)
                  .map((entry) => ({ ...entry, collection: source.name }));
                output.knowledge = knowledgeResults.flat();
              } catch {
                warn(
                  `Planner knowledge retrieval failed or timed out: ${source.name}`,
                );
              }
            })(),
          );
        await Promise.all(jobs);
      },
      config.retrievalTimeoutMs ?? 3_000,
      options.signal,
    );
  } catch {
    warn('Planner retrieval deadline reached');
  }
  // Copy arrays: late source completions must never change the turn snapshot.
  return { memory: [...output.memory], knowledge: [...output.knowledge] };
}
