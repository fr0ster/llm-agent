import { AsyncLocalStorage } from 'node:async_hooks';
import type { Message } from '@mcp-abap-adt/llm-agent';
import type { TaskBoard } from './task-board.js';

export interface PlannerScope {
  board: TaskBoard;
  recordAction?(action: string, started?: boolean): void;
  getPlan(): string | undefined;
  setPlan(plan: string): void;
  history(): Message[];
}
const storage = new AsyncLocalStorage<PlannerScope>();
export function runInPlannerScope<T>(scope: PlannerScope, fn: () => T): T {
  return storage.run(scope, fn);
}
export function currentPlannerScope(): PlannerScope | undefined {
  return storage.getStore();
}
