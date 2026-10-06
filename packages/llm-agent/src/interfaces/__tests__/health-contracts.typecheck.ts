// Compile-time only (tsconfig.typecheck.json → `npm run typecheck`).
// Spec §17.43 (D96, D97): additive, optional contract members.
import type {
  DecisionError,
  IProbabilityDecision,
  IRelevanceDecision,
} from '../decision-model.js';
import type { HealthComponentStatus } from '../health.js';
import type { LoadedPlugins } from '../plugin.js';
import type { IReranker } from '../reranker.js';
import type { CallOptions, RagError, Result } from '../types.js';

// Optional: an implementation without healthCheck still compiles.
export const _r: IReranker = {
  rerank: async (_q, r) => ({ ok: true, value: r }),
};
export const _p: IProbabilityDecision = {
  decide: async () => ({ ok: true, value: { answers: {}, model: 'm' } }),
};
export const _s: IRelevanceDecision = {
  score: async () => ({ ok: true, value: { scores: [], model: 'm' } }),
};

// The signatures.
export type _RH =
  NonNullable<IReranker['healthCheck']> extends (
    options?: CallOptions,
  ) => Promise<Result<boolean, RagError>>
    ? true
    : never;
export const _rh: _RH = true;
export type _PH =
  NonNullable<IProbabilityDecision['healthCheck']> extends (
    options?: CallOptions,
  ) => Promise<Result<boolean, DecisionError>>
    ? true
    : never;
export const _ph: _PH = true;
export type _SH =
  NonNullable<IRelevanceDecision['healthCheck']> extends (
    options?: CallOptions,
  ) => Promise<Result<boolean, DecisionError>>
    ? true
    : never;
export const _sh: _SH = true;

export const _wrong: IReranker = {
  rerank: async (_q, r) => ({ ok: true, value: r }),
  // @ts-expect-error a health check answers a boolean, not a string
  healthCheck: async () => ({ ok: true, value: 'yes' }),
};

// LoadedPlugins.skipped is optional; HealthComponentStatus.reranker too.
export const _lp: Pick<LoadedPlugins, 'skipped'> = {};
export const _lp2: Pick<LoadedPlugins, 'skipped'> = {
  skipped: [{ file: 'f', error: 'e' }],
};
export const _hc: HealthComponentStatus = { llm: true, rag: true, mcp: [] };
export const _hc2: HealthComponentStatus = {
  llm: true,
  rag: true,
  mcp: [],
  reranker: [{ name: 'global', ok: false, error: 'down' }],
};
