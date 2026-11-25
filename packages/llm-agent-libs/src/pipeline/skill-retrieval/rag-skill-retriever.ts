import {
  type CallOptions,
  collectWithContextOverflow,
  type IQueryEmbedder,
  type ISkillRetriever,
  QueryEmbedding,
  type RagAccess,
  type RagResult,
  type Result,
  type SkillRetrievalRequest,
  type SkillRetrievalResult,
  type SmartAgentError,
  TextOnlyEmbedding,
} from '@mcp-abap-adt/llm-agent';
import type { SmartAgentRagStores } from '../../agent.js';
import { denyRagAccess, ownerBoundQuery } from '../../rag/owner-bound-query.js';
import { retrievalError } from '../catalogue-retrieval/retrieval-error.js';

export interface RagSkillRetrieverOptions {
  readonly ragStores: SmartAgentRagStores;
  readonly ragAccess?: RagAccess;
  readonly embedder?: IQueryEmbedder;
  readonly k?: number;
}

function addMatches(results: readonly RagResult[], matches: Set<string>): void {
  for (const { metadata } of results) {
    const { id } = metadata;
    if (id?.startsWith('skill:')) matches.add(id.slice('skill:'.length));
  }
}

/** Selects skills from RAG record IDs, querying stores when none were matched. */
export class RagSkillRetriever implements ISkillRetriever {
  readonly name = 'rag';

  constructor(private readonly config: RagSkillRetrieverOptions) {}

  async retrieve(
    {
      text,
      candidates,
      ragResults = {},
    }: SkillRetrievalRequest & {
      readonly ragResults?: Readonly<Record<string, readonly RagResult[]>>;
    },
    options?: CallOptions,
  ): Promise<Result<SkillRetrievalResult, SmartAgentError>> {
    try {
      const matches = await this.findMatches(text, ragResults, options);
      if (!matches.ok) return matches;
      return {
        ok: true,
        value: {
          names: candidates
            .filter(({ name }) => matches.value.has(name))
            .map(({ name }) => name),
        },
      };
    } catch (error) {
      return {
        ok: false,
        error: retrievalError(error, 'skill', options?.signal),
      };
    }
  }

  /** Lets the default stage keep RAG discovery ahead of skill enumeration. */
  async findMatches(
    text: string,
    ragResults: Readonly<Record<string, readonly RagResult[]>>,
    options?: CallOptions,
  ): Promise<Result<ReadonlySet<string>, SmartAgentError>> {
    const matches = new Set<string>();
    for (const results of Object.values(ragResults))
      addMatches(results, matches);
    if (matches.size > 0) return { ok: true, value: matches };

    const { ragStores, ragAccess, embedder, k = 15 } = this.config;
    const embedding = embedder
      ? new QueryEmbedding(text, embedder, options)
      : new TextOnlyEmbedding(text);
    const queries = await collectWithContextOverflow(
      Object.values(ragStores).map((store) =>
        ownerBoundQuery(
          store,
          embedding,
          k,
          options ?? {},
          ragAccess ?? denyRagAccess,
        ),
      ),
      (result) => (result.ok ? undefined : result.error),
      { rejectImmediately: true },
    );
    if (!queries.ok) return queries;
    for (const result of queries.value) {
      if (!result.ok) return result;
      addMatches(result.value, matches);
    }
    if (matches.size > 0) {
      options?.sessionLogger?.logStep('skill_select_rag_fallback', {
        query: text.slice(0, 200),
        k,
        matchedSkills: [...matches],
      });
    }
    return { ok: true, value: matches };
  }
}
