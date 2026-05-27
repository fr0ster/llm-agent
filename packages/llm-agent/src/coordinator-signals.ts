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
