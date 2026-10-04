import type {
  IDecisionModel,
  ILlm,
  IReranker,
  IRetrievalStrategy,
} from '@mcp-abap-adt/llm-agent';
import {
  DecisionReranker,
  EmbeddingRetrieval,
  LlmReranker,
  PASSAGE_QUESTION,
  RerankAllRetrieval,
  RerankedRetrieval,
  TOOL_QUESTION,
  wrapDecisionModel,
} from '@mcp-abap-adt/llm-agent-libs';
import type {
  SmartServerDecisionConfig,
  SmartServerRetrievalConfig,
} from './decision-config.js';

export interface ResolveRetrievalInput {
  /** `rag.retrieval` — server-wide, keyed by store (§13.4). */
  retrieval?: Record<string, SmartServerRetrievalConfig>;
  decisionCfg?: SmartServerDecisionConfig;
  makeDecisionModel?: (
    cfg: SmartServerDecisionConfig,
  ) => Promise<IDecisionModel>;
  /** Resolves a key of the `llm:` map (strict). */
  resolveLlm: (key: string) => Promise<ILlm>;
}

const MISSING_SEAM =
  'BuildAgentDeps.makeDecisionModel is required: the config asks for a decision model, and the library constructs none from configuration. Supply it from your composition root.';

/**
 * One retrieval strategy per configured store key (§13.4). Every listed store
 * gets a strategy — `embedding` included, so an explicit embedding store is
 * distinguishable from an unlisted one (precedence over the global reranker).
 * The decision model is built ONCE and shared; one `DecisionReranker` per
 * distinct question wording.
 */
export async function resolveRetrievalStrategies(
  input: ResolveRetrievalInput,
): Promise<Map<string, IRetrievalStrategy>> {
  const out = new Map<string, IRetrievalStrategy>();
  const entries = Object.entries(input.retrieval ?? {});
  if (entries.length === 0) return out;

  let decisionModel: IDecisionModel | undefined;
  const decisionRerankers = new Map<string, IReranker>();
  const decisionReranker = async (
    preset: typeof TOOL_QUESTION | typeof PASSAGE_QUESTION,
    task: string,
  ): Promise<IReranker> => {
    const cacheKey = JSON.stringify([preset.criteria, task]);
    const cached = decisionRerankers.get(cacheKey);
    if (cached) return cached;
    if (!decisionModel) {
      if (!input.decisionCfg) {
        throw new Error(
          'rag.retrieval: reranker: decision requires a decision: section',
        );
      }
      if (!input.makeDecisionModel) throw new Error(MISSING_SEAM);
      decisionModel = wrapDecisionModel(
        await input.makeDecisionModel(input.decisionCfg),
      );
    }
    const reranker = new DecisionReranker(decisionModel, {
      task,
      criteria: preset.criteria,
    });
    decisionRerankers.set(cacheKey, reranker);
    return reranker;
  };

  for (const [key, cfg] of entries) {
    if (cfg.strategy === 'embedding') {
      out.set(key, new EmbeddingRetrieval());
      continue;
    }
    const question = cfg.question ?? (key === 'tools' ? 'tool' : 'passage');
    const preset = question === 'tool' ? TOOL_QUESTION : PASSAGE_QUESTION;
    const task = cfg.task ?? (preset.task as string);

    let reranker: IReranker;
    if (cfg.reranker === 'decision') {
      reranker = await decisionReranker(preset, task);
    } else if (cfg.reranker === 'llm') {
      if (!cfg.llm) {
        throw new Error(`rag.retrieval.${key}: reranker: llm requires llm:`);
      }
      reranker = new LlmReranker(await input.resolveLlm(cfg.llm), {
        question: { task },
      });
    } else {
      throw new Error(
        `rag.retrieval.${key}: strategy ${cfg.strategy} requires reranker: decision | llm`,
      );
    }

    if (cfg.strategy === 'rerank') {
      out.set(
        key,
        new RerankedRetrieval(reranker, {
          ...(cfg.overfetch !== undefined ? { overfetch: cfg.overfetch } : {}),
          storeName: key,
        }),
      );
    } else {
      if (cfg.maxCandidates === undefined) {
        throw new Error(
          `rag.retrieval.${key}: strategy rerank-all requires maxCandidates`,
        );
      }
      out.set(
        key,
        new RerankAllRetrieval(reranker, {
          maxCandidates: cfg.maxCandidates,
          storeName: key,
        }),
      );
    }
  }
  return out;
}

/** Stores a `rag.retrieval` key may always name; others come from the registry. */
const BUILT_IN_STORES = ['tools', 'history'];

/**
 * Warnings for `rag.retrieval` keys that name no store (§14.5). The validator
 * cannot check keys (collections can appear at run time), so a typo such as
 * `tool:` for `tools:` would otherwise be a silent no-op. `user/…` and
 * `session/…` collections appear per session and are never flagged.
 */
export function unknownRetrievalKeyWarnings(
  retrieval: Record<string, unknown> | undefined,
  registeredNames: readonly string[],
): string[] {
  if (!retrieval) return [];
  const known = [...new Set([...BUILT_IN_STORES, ...registeredNames])].sort();
  return Object.keys(retrieval)
    .filter(
      (key) =>
        !known.includes(key) &&
        !key.startsWith('user/') &&
        !key.startsWith('session/'),
    )
    .map(
      (key) =>
        `rag.retrieval.${key} names no store; known stores: ${known.join(', ')}. Entries for collections that appear at run time are ignored until they exist.`,
    );
}
