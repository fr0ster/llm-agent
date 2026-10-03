import { DecisionError } from '@mcp-abap-adt/llm-agent';

export function mapError(err: unknown): DecisionError {
  return new DecisionError(
    err instanceof Error ? err.message : String(err),
    'DECISION_ERROR',
  );
}
