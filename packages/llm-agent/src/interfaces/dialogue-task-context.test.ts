import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSignalBus } from '../../../llm-signals/src/index.js';
import type { DialogueSignals } from './dialogue-signals.js';
import {
  createDialogueTaskContext,
  finishDialogueTask,
} from './dialogue-task-context.js';

test('run identity excludes retained and late finishes from an old context', () => {
  const bus = createSignalBus<DialogueSignals>();
  const old = createDialogueTaskContext(bus, 'session', 'task');
  finishDialogueTask(old, 'retained');
  const current = createDialogueTaskContext(bus, 'session', 'task');
  assert.notEqual(current.runId, old.runId);
  assert.equal(current.readFinish(), undefined);
  finishDialogueTask(old, 'late');
  assert.equal(current.readFinish(), undefined);
  finishDialogueTask(current, '', 'submit');
  finishDialogueTask(old, 'late after current');
  assert.deepEqual(current.readFinish(), {
    taskId: 'task',
    runId: current.runId,
    output: '',
    tool: 'submit',
  });
});

test('finish still requires matching source, key and task id', () => {
  const bus = createSignalBus<DialogueSignals>();
  const current = createDialogueTaskContext(bus, 'session', 'task');
  const payload = { taskId: 'task', runId: current.runId, output: 'finish' };
  bus.emit('dialogue.task.finish', payload, 'other', current.runId);
  bus.emit('dialogue.task.finish', payload, 'session', 'other');
  assert.equal(current.readFinish(), undefined);
  bus.emit(
    'dialogue.task.finish',
    { ...payload, taskId: 'other' },
    'session',
    current.runId,
  );
  assert.equal(current.readFinish(), undefined);
});
