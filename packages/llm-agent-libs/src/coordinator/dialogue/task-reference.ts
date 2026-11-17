import type { TaskRecord } from '@mcp-abap-adt/llm-agent';
import { checkerVerdict } from './structured-plan.js';

/** Coordinator projection; full results remain on the board or in storage. */
export function taskNotice(task: TaskRecord): string {
  const parsed = task.checkerVerdict ?? checkerVerdict(task.output ?? '');
  const verdict =
    parsed && ('unusable' in parsed ? 'unusable' : parsed.verdict);
  const summary = task.summary ?? task.error ?? task.output ?? '';
  return `task ${task.id} (${task.worker}) ${task.state}; kind: ${task.result ?? 'report'}${verdict ? `; verdict: ${verdict}` : ''}; summary: ${summary}; chars: ${task.resultRef?.chars ?? task.output?.length ?? 0}; ${task.resultRef ? `result: ${task.resultRef.collection}/${task.resultRef.record}` : 'result: not stored'}; goal: ${task.goal}${task.error === undefined ? '' : `; error: ${task.error}`}${task.budgetExhausted ? `; worker hit the tool-call budget ${task.toolCalls ?? '?'}/${task.maxToolCalls ?? '?'}` : ''}`;
}
