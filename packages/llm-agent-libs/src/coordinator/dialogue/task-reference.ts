import type { TaskRecord } from '@mcp-abap-adt/llm-agent';

/** Bound planner-visible text without changing retained task results. */
export function compactText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = ` [truncated, ${text.length} chars]`;
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

export function taskReference(task: TaskRecord): string {
  return `task ${task.id} (${task.worker}) ${task.state}; output length: ${task.output?.length ?? 0}; outcome: ${compactText((task.error ?? task.output ?? '').replace(/\s+/g, ' '), 400)}; use get_task to read output`;
}
