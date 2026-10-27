import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskEvent } from './dialogue.js';
import type { DialogueSignals } from './dialogue-signals.js';
import { DIALOGUE_SIGNALS_VERSION } from './dialogue-signals.js';

function eventKind(event: TaskEvent): string {
  switch (event.kind) {
    case 'started':
    case 'done':
    case 'failed':
    case 'stopped':
    case 'long_running':
      return event.kind;
    default:
      return event.kind satisfies never;
  }
}
test('long-running events extend the task event contract without changing running state', () => {
  const event: TaskEvent = {
    kind: 'long_running',
    task: {
      id: 't1',
      worker: 'executor',
      goal: 'job',
      state: 'running',
      createdAt: 0,
    },
  };
  assert.equal(eventKind(event), 'long_running');
  assert.equal(event.task.state, 'running');
});
test('dialogue.wait is an additive catalog v1 signal with optional tool counts', () => {
  const wait: DialogueSignals['dialogue.wait'] = {
    tasks: [
      {
        id: 't1',
        worker: 'executor',
        goal: 'job',
        state: 'running',
        elapsedMs: 30_000,
        toolCalls: 12,
        maxToolCalls: 40,
      },
      {
        id: 't2',
        worker: 'executor',
        goal: 'queued job',
        state: 'queued',
        elapsedMs: 15_000,
      },
    ],
  };
  assert.equal(DIALOGUE_SIGNALS_VERSION, 1);
  assert.equal(wait.tasks[0].toolCalls, 12);
  assert.equal(wait.tasks[1].toolCalls, undefined);
});
