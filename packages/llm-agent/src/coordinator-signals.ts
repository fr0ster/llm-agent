import type { LlmUsage } from './interfaces/types.js';

/** A role (planner/reviewer) needs a REALITY fact; the coordinator routes the
 *  query to the state-oracle and re-invokes the role (autonomous, same turn). */
export class NeedInfoSignal extends Error {
  readonly query: string;
  /** Token usage consumed by the LLM call that produced this signal.
   *  Throwers SHOULD populate it (`signal.usage = res.usage`) before
   *  re-throwing, so the coordinator can attribute LLM spend on signal
   *  paths (which would otherwise discard the captured usage). Mutable
   *  by design — keeping it on the constructor would force every thrower
   *  to thread it through extra plumbing. */
  usage?: LlmUsage;
  constructor(query: string, usage?: LlmUsage) {
    super(`needs info: ${query}`);
    this.name = 'NeedInfoSignal';
    this.query = query;
    this.usage = usage;
  }
}

/** A role needs a HUMAN decision; the coordinator emits the question and ends
 *  the turn (the next turn replans fresh from current state). */
export class ClarifySignal extends Error {
  readonly question: string;
  /** Token usage consumed by the LLM call that produced this signal.
   *  Throwers SHOULD populate it before re-throwing — see NeedInfoSignal. */
  usage?: LlmUsage;
  constructor(question: string, usage?: LlmUsage) {
    super(`needs clarification: ${question}`);
    this.name = 'ClarifySignal';
    this.question = question;
    this.usage = usage;
  }
}
