import type { UsageRecord } from '@mcp-abap-adt/llm-agent';
export const COLUMNS =
  'id, schema_version, at, kind, session_id, user_id, turn_id, task_id, role, destination, outcome, record_json';
export function recordValues(r: UsageRecord): (string | number | null)[] {
  return [
    r.id,
    r.schema,
    r.at,
    r.kind,
    r.context.sessionId ?? null,
    r.context.userId ?? null,
    r.context.turnId ?? null,
    r.context.taskId ?? null,
    r.context.role ?? null,
    r.context.destination ?? null,
    r.outcome,
    JSON.stringify(r),
  ];
}
