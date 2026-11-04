import { randomUUID } from 'node:crypto';
import type { DialogueSignals } from './dialogue-signals.js';
import type { ISignalEmitter, ISignalSubscriber } from './signals.js';

/** Per-run addressing and optional retained finish capability, also passed to tools. */
export interface IDialogueTaskContext {
  /** Result kind supplied by the dialogue board; absent outside board workers. */
  readonly result?: 'report' | 'verdict';
  readonly taskId: string;
  readonly runId: string;
  readonly source: string;
  readonly signals: ISignalEmitter<DialogueSignals>;
  readFinish(): Readonly<DialogueSignals['dialogue.task.finish']> | undefined;
}

/**
 * Create once immediately before worker.run. A unique runId excludes both retained
 * finishes and late emissions from previous runs with the same source/taskId.
 * No retained-object baseline is needed: only this context's runId is accepted.
 * Emitters without last() preserve the ordinary LLM completion path.
 */
export function createDialogueTaskContext(
  signals: ISignalEmitter<DialogueSignals> &
    Partial<Pick<ISignalSubscriber<DialogueSignals>, 'last'>>,
  source: string,
  taskId: string,
): IDialogueTaskContext {
  const runId = randomUUID();
  return {
    signals,
    source,
    taskId,
    runId,
    readFinish() {
      const signal = signals.last?.('dialogue.task.finish', source, runId);
      if (
        !signal ||
        signal.source !== source ||
        signal.key !== runId ||
        signal.payload.taskId !== taskId ||
        signal.payload.runId !== runId
      )
        return undefined;
      return signal.payload;
    },
  };
}

/** Emit from a host tool using CallOptions.dialogueTask for its current run. */
export function finishDialogueTask(
  task: IDialogueTaskContext,
  output: string,
  tool?: string,
  summary?: string,
): void {
  task.signals.emit(
    'dialogue.task.finish',
    {
      taskId: task.taskId,
      runId: task.runId,
      output,
      ...(tool === undefined ? {} : { tool }),
      ...(summary === undefined ? {} : { summary }),
    },
    task.source,
    task.runId,
  );
}
