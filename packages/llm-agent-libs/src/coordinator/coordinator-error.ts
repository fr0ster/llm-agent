import { OrchestratorError, SmartAgentError } from '@mcp-abap-adt/llm-agent';

/** The coordinator codes a failing stepper component is reported under
 *  (spec §10.5.7): the handlers already map them to the consumer. */
export type CoordinatorFailureCode =
  | 'COORDINATOR_PLAN_FAILED'
  | 'COORDINATOR_STEP_FAILED';

/**
 * A component the coordinator depends on (a store, a classifier, an LLM)
 * failed: the step or the plan fails with the row's coordinator code
 * (spec §10.5.7 C1–C7). The component's own error — its class, its code and
 * its message — is kept in the message, and the error itself as `cause`.
 */
export function coordinatorError(
  where: string,
  err: unknown,
  code: CoordinatorFailureCode,
): OrchestratorError {
  const e = new OrchestratorError(`${where}: ${describeError(err)}`, code);
  e.cause = err;
  return e;
}

function describeError(err: unknown): string {
  if (err instanceof SmartAgentError)
    return `${err.name} ${err.code}: ${err.message}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
