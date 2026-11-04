import type { TaskRecord } from '@mcp-abap-adt/llm-agent';
import { checkerVerdict } from './structured-plan.js';

/** Bound planner-visible text without changing retained task results. */
export function compactText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = ` [truncated, ${text.length} chars]`;
  return text.slice(0, Math.max(0, limit - marker.length)) + marker;
}

/** Bounded coordinator projection; full results remain on the board or in storage. */
export function taskNotice(task: TaskRecord): string {
  const parsed = task.checkerVerdict ?? checkerVerdict(task.output ?? '');
  const verdict =
    parsed && ('unusable' in parsed ? 'unusable' : parsed.verdict);
  const summary =
    task.summary ?? (task.error ?? task.output ?? '').replace(/\s+/g, ' ');
  return `task ${task.id} (${task.worker}) ${task.state}; kind: ${task.result ?? 'report'}${verdict ? `; verdict: ${verdict}` : ''}; summary: ${compactText(summary, 600)}; chars: ${task.resultRef?.chars ?? task.output?.length ?? 0}; ${task.resultRef ? `result: ${task.resultRef.collection}/${task.resultRef.record}` : 'result: not stored'}; goal: ${compactText(task.goal, 200)}${task.error === undefined ? '' : `; error: ${compactText(task.error, 600)}`}${task.budgetExhausted ? `; worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}` : ''}`;
}
