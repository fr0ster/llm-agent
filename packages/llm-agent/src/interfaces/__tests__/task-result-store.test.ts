import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSignalBus } from '../../../../llm-signals/src/index.js';
import { createDialogueTaskContext, finishDialogueTask } from '../../index.js';
import type { DialogueSignals } from '../dialogue-signals.js';

test('finish payload carries summary', () => {
  const bus = createSignalBus<DialogueSignals>();
  const task = createDialogueTaskContext(bus, 's', 't');
  finishDialogueTask(task, 'R', 'submit_report', 'S');
  assert.deepEqual(task.readFinish(), {
    taskId: 't',
    runId: task.runId,
    output: 'R',
    tool: 'submit_report',
    summary: 'S',
  });
});
