import type { JsonValue } from './tool-loop-context-strategy.js';
import { type CallOptions, type Result, SmartAgentError } from './types.js';

/**
 * What is judged, and how a question or criterion is put: text, a JSON object,
 * or a JSON array.
 */
export type DecisionEntry = string | { [k: string]: JsonValue } | JsonValue[];

/** A yes/no question. */
export interface NoulQuestion {
  type: 'noul';
  instructions?: DecisionEntry;
  criteria?: { true?: DecisionEntry; false?: DecisionEntry };
}

/** Pick one of at least two named labels. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions?: DecisionEntry;
  /** At least two labels; a `null` description leaves the label undescribed. */
  criteria: Record<string, DecisionEntry | null>;
}

/** Place the state on an ordered rubric. */
export interface ScoreQuestion {
  type: 'score';
  instructions?: DecisionEntry;
  /** At least two rubric levels; the index is the score. */
  criteria: readonly (DecisionEntry | null)[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  type: 'noul';
  /** P(yes), finite, in [0, 1]. */
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** One of the question's labels. */
  choice: string;
  /** Finite, in [0, 1]. */
  confidence: number;
  /** Exactly the question's labels; each value finite, in [0, 1]. */
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected score, finite, in [0, levels − 1]; may fall between levels. */
  score: number;
  /** Finite, in [0, 1]. */
  confidence: number;
  /** Exactly the keys 0 … levels − 1; each value finite, in [0, 1]. */
  probabilities: Record<number, number>;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionRequest {
  state: DecisionEntry;
  /** Non-empty; keys name the answers. */
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionResult {
  /** Same keys as `questions`; each answer's `type` matches its question's. */
  answers: Record<string, DecisionAnswer>;
  /** The model that actually answered (e.g. `jev-1.13.0` for `jev-latest`). */
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type DecisionErrorCode =
  | 'DECISION_UNSUPPORTED_QUESTION'
  | 'DECISION_INVALID_REQUEST'
  | 'DECISION_AUTH'
  | 'DECISION_RATE_LIMITED'
  | 'DECISION_UNAVAILABLE'
  | 'DECISION_ABORTED'
  | 'DECISION_ERROR';

export class DecisionError extends SmartAgentError {
  constructor(message: string, code: DecisionErrorCode = 'DECISION_ERROR') {
    super(message, code);
    this.name = 'DecisionError';
  }
}

/**
 * A model that answers typed questions about a state with probabilities, not text
 * (spec §3.9; the 30.1.0 decision interface, renamed — same members, same rules; the old
 * name is removed, D58).
 *
 * - Returns `Result`; never throws for provider failures.
 * - A question type the implementation cannot answer fails the whole request
 *   with `DECISION_UNSUPPORTED_QUESTION`; answers are never dropped or faked.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 * - On `ok: true` the numeric invariants documented on the answer types hold;
 *   consumers may rely on them without re-checking.
 */
export interface IProbabilityDecision {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  decide(
    request: DecisionRequest,
    options?: CallOptions,
  ): Promise<Result<DecisionResult, DecisionError>>;
}

/** What a relevance decision judges: passages against one query. */
export interface RelevanceRequest {
  /** Non-empty. */
  query: string;
  /** Non-empty; each a non-empty string. `RelevanceScore.index` points into it. */
  passages: readonly string[];
}

/** One passage's relevance. */
export interface RelevanceScore {
  /** Index into `RelevanceRequest.passages`. */
  index: number;
  /** Finite. NOT a probability: higher = more relevant. Comparable for the same query
   *  and model — also across calls; never across queries or models. */
  score: number;
}

export interface RelevanceResult {
  /** Exactly one entry per passage, each index once; any order. */
  scores: readonly RelevanceScore[];
  /** The model that actually answered. */
  model: string;
  usage?: { inputTokens: number; outputTokens?: number };
}

/**
 * A model that scores how relevant each passage is to a query — a
 * cross-encoder (spec §3.9).
 *
 * - Returns `Result`; never throws for provider failures. Errors are
 *   `DecisionError` with the existing codes; `DECISION_UNSUPPORTED_QUESTION`
 *   is never returned.
 * - The score is NOT a probability. It depends on the (query, passage) pair
 *   alone — a cross-encoder scores each pair independently — so scores for the
 *   SAME query from the SAME model are comparable, also across calls (a
 *   reranker may batch and merge). Never compare across queries, across
 *   models, or with a probability. A threshold on it is the consumer's
 *   calibration.
 * - Cancellation through `options.signal` yields `DECISION_ABORTED`.
 */
export interface IRelevanceDecision {
  /** Configured model identifier, for logs. */
  readonly model?: string;
  score(
    request: RelevanceRequest,
    options?: CallOptions,
  ): Promise<Result<RelevanceResult, DecisionError>>;
}
