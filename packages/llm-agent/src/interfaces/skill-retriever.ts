import type {
  CallOptions,
  LlmUsage,
  Result,
  SmartAgentError,
} from './types.js';

export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
}

export interface SkillRetrievalRequest {
  readonly text: string;
  readonly candidates: readonly SkillCandidate[];
}

export interface SkillRetrievalResult {
  /** Names drawn from the request's candidate catalogue. */
  readonly names: readonly string[];
  readonly usage?: LlmUsage;
}

export const SKILL_RETRIEVAL_INVALID = 'SKILL_RETRIEVAL_INVALID';

export interface ISkillRetriever {
  readonly name: string;
  retrieve(
    request: SkillRetrievalRequest,
    options?: CallOptions,
  ): Promise<Result<SkillRetrievalResult, SmartAgentError>>;
}
