import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  Message,
  DialoguePlan as Plan,
  PlannerMessage,
  PlannerRequestRecord,
} from '@mcp-abap-adt/llm-agent';
import type { TaskBoard } from './task-board.js';

export interface PlannerScope {
  beforeTool?(name: string): void;
  newRequest?(): void;
  ownTask?(id: string): void;
  board: TaskBoard;
  maxItemsPerStep?: number;
  taskSteps?: Map<string, string>;
  statusRead?(): void;
  recordAction?(action: string, started?: boolean): void;
  getPlan(): string | Plan | undefined;
  setPlan(
    plan: string | Plan,
    status?: Plan['status'],
    question?: string,
  ): void;
  getMessage?(id: string): PlannerMessage | undefined;
  getRequest?(id: string): PlannerRequestRecord | undefined;
  searchKnowledge?(
    query: string,
    collection?: string,
    k?: number,
  ): Promise<string>;
  history(): Message[];
}
const storage = new AsyncLocalStorage<PlannerScope>();
export function runInPlannerScope<T>(scope: PlannerScope, fn: () => T): T {
  return storage.run(scope, fn);
}
export function currentPlannerScope(): PlannerScope | undefined {
  return storage.getStore();
}
