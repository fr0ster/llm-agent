import type { DialogueSignals } from './dialogue-signals.js';
import type { ISignalEmitter, ISignalSubscriber } from './signals.js';

/** Per-run addressing and optional retained finish capability, also passed to tools. */
export interface IDialogueTaskContext {
  readonly taskId: string;
  readonly source: string;
  readonly signals: ISignalEmitter<DialogueSignals>;
  readFinish(): Readonly<DialogueSignals['dialogue.task.finish']> | undefined;
}

/**
 * Create once immediately before worker.run. The retained object present at entry
 * is excluded by identity, even when a new emission has the same millisecond.
 * Retention returns immutable signal objects; each emission creates a new object.
 * Emitters without last() preserve the ordinary LLM completion path.
 */
export function createDialogueTaskContext(
  signals: ISignalEmitter<DialogueSignals> &
    Partial<Pick<ISignalSubscriber<DialogueSignals>, 'last'>>,
  source: string,
  taskId: string,
): IDialogueTaskContext {
  const initial = signals.last?.('dialogue.task.finish', source, taskId);
  return {
    signals,
    source,
    taskId,
    readFinish() {
      const signal = signals.last?.('dialogue.task.finish', source, taskId);
      if (
        !signal ||
        signal === initial ||
        signal.source !== source ||
        signal.key !== taskId ||
        signal.payload.taskId !== taskId
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
): void {
  task.signals.emit(
    'dialogue.task.finish',
    { taskId: task.taskId, output, ...(tool === undefined ? {} : { tool }) },
    task.source,
    task.taskId,
  );
}
