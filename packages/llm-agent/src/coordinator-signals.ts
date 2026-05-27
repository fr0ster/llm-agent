/** A role (planner/reviewer) needs a REALITY fact; the coordinator routes the
 *  query to the state-oracle and re-invokes the role (autonomous, same turn). */
export class NeedInfoSignal extends Error {
  readonly query: string;
  constructor(query: string) {
    super(`needs info: ${query}`);
    this.name = 'NeedInfoSignal';
    this.query = query;
  }
}

/** A role needs a HUMAN decision; the coordinator emits the question and ends
 *  the turn (the next turn replans fresh from current state). */
export class ClarifySignal extends Error {
  readonly question: string;
  constructor(question: string) {
    super(`needs clarification: ${question}`);
    this.name = 'ClarifySignal';
    this.question = question;
  }
}

/**
 * Marker prefixed onto a coordinator-emitted clarification question. `Message`
 * exposes no metadata field, so the marker lives in the assistant content — but
 * it is zero-width (invisible): the user/API sees only the question. On the next
 * turn the coordinator reconstructs the clarification Q/A ONLY from the marked
 * tail turn. Zero-width: U+2063 INVISIBLE SEPARATOR x3.
 */
export const CLARIFY_MARKER = '⁣⁣⁣';
