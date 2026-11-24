import {
  type CallOptions,
  collectWithContextOverflow,
  type IQueryEmbedder,
  type IToolRetriever,
  type IToolSelectionStrategy,
  QueryEmbedding,
  type RagAccess,
  type RagResult,
  type Result,
  type SmartAgentError,
  TextOnlyEmbedding,
  type ToolRetrievalRequest,
  type ToolRetrievalResult,
  toolNameFromRecord,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentRagStores } from '../../agent.js';
import { denyRagAccess, ownerBoundQuery } from '../../rag/owner-bound-query.js';
import { DEFAULT_TOOL_SELECTION } from '../tool-selection/index.js';
import { toolRetrievalError } from './tool-retrieval-error.js';

export interface RagToolRetrieverOptions {
  readonly ragStores: SmartAgentRagStores;
  readonly ragResults: Record<string, RagResult[]>;
  readonly ragAccess?: RagAccess;
  readonly embedder?: IQueryEmbedder;
  readonly toolSelectionStrategy?: IToolSelectionStrategy;
  readonly k?: number;
  readonly hardMode?: boolean;
}

interface RagToolRetrievalResult extends ToolRetrievalResult {
  readonly ragDiagnostics: {
    readonly ragMatchedTools: readonly string[];
    readonly toolSelectionStrategy: string;
  };
}

/** Reuses preloaded RAG results and queries the stores when retrieval was skipped. */
export class RagToolRetriever implements IToolRetriever {
  readonly name = 'rag';

  constructor(private readonly config: RagToolRetrieverOptions) {}

  async retrieve(
    { text, candidates }: ToolRetrievalRequest,
    options?: CallOptions,
  ): Promise<Result<RagToolRetrievalResult, SmartAgentError>> {
    try {
      const { ragStores, ragResults, ragAccess, embedder, hardMode } =
        this.config;
      let allRagResults = Object.values(ragResults).flat();
      if (allRagResults.length === 0 && candidates.length > 0) {
        const k = this.config.k ?? 20;
        const embedding = embedder
          ? new QueryEmbedding(text, embedder, options)
          : new TextOnlyEmbedding(text);
        const queries = await collectWithContextOverflow(
          Object.entries(ragStores).map(async ([name, store]) => ({
            name,
            result: await ownerBoundQuery(
              store,
              embedding,
              k,
              options ?? {},
              ragAccess ?? denyRagAccess,
            ),
          })),
          ({ result }) => (result.ok ? undefined : result.error),
          { rejectImmediately: true },
        );
        if (!queries.ok) return queries;
        for (const { name, result } of queries.value) {
          if (!result.ok) return result;
          ragResults[name] = result.value;
        }
        allRagResults = Object.values(ragResults).flat();

        options?.sessionLogger?.logStep('tool_select_rag_fallback', {
          reason:
            'RAG retrieval was skipped, querying stores for tool discovery',
          query: text.slice(0, 200),
          k,
          resultCount: allRagResults.length,
          results: allRagResults.map((r) => ({
            id: r.metadata.id,
            score: r.score,
            text: r.text.slice(0, 120),
          })),
        });
      }

      const strategy =
        this.config.toolSelectionStrategy ?? DEFAULT_TOOL_SELECTION;
      const ragToolNames = new Set(
        strategy
          .select(allRagResults)
          .map((r) => toolNameFromRecord(r.metadata))
          .filter((name) => name !== undefined),
      );
      const offerAll = hardMode && ragToolNames.size === 0;
      return {
        ok: true,
        value: {
          names: candidates
            .filter(({ name }) => offerAll || ragToolNames.has(name))
            .map(({ name }) => name),
          ragDiagnostics: {
            ragMatchedTools: [...ragToolNames],
            toolSelectionStrategy: strategy.name,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: toolRetrievalError(error, options?.signal) };
    }
  }
}
