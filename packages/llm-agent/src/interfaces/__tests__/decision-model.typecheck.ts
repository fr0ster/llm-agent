// Compile-time only (tsconfig.typecheck.json → `npm run typecheck`).
import type {
  IProbabilityDecision,
  IRelevanceDecision,
  RelevanceResult,
} from '../decision-model.js';

// A type query, not an import: Biome's import sorting would merge an import
// of the removed name into the import above and move it off this directive's
// line (TS2578 + TS2305; verified with Biome 2.5.14).
// @ts-expect-error IDecisionModel is removed — a major release, no alias (spec §13 line 40, D58)
export type _Removed = import('../decision-model.js').IDecisionModel;
declare const newName: IProbabilityDecision;
declare const relevance: IRelevanceDecision;
// @ts-expect-error a relevance decision is not a probability decision (no decide)
export const _c: IProbabilityDecision = relevance;
// @ts-expect-error a probability decision is not a relevance decision (no score)
export const _d: IRelevanceDecision = newName;
// @ts-expect-error a relevance result has scores, not answers
export const _e: RelevanceResult = { answers: {}, model: 'm' };
