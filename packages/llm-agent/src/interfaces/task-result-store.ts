import type { CallOptions, Result } from './types.js';

export type TaskResultOutcome = 'done' | 'stopped' | 'failed';

export interface TaskResultRef {
  collection: string;
  record: string;
  chars: number;
}

export interface TaskResultEntry {
  id: string;
  stepId?: string;
  worker: string;
  goal: string;
  result: 'report' | 'verdict';
  outcome: TaskResultOutcome;
  budgetExhausted?: boolean;
  verdict?: 'pass' | 'fail';
  summary: string;
  output: string;
}

export type TaskResultStoreError = {
  code: 'exists' | 'unavailable' | 'aborted';
  message: string;
};

export interface ITaskResultStore {
  /** Create once and resolve after the record is readable; identical retries return its ref, differing output returns exists. */
  put(
    entry: TaskResultEntry,
    options?: CallOptions,
  ): Promise<Result<TaskResultRef, TaskResultStoreError>>;
  /** Read the full stored output. */
  read(
    ref: TaskResultRef,
    options?: CallOptions,
  ): Promise<Result<string, TaskResultStoreError>>;
}
