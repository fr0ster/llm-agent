import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ISubAgent,
  OnPartial,
  StreamChunk,
} from '@mcp-abap-adt/llm-agent';
import { AbortErrorStrategy } from '../abort-error-strategy.js';
import { DagPlanInterpreter } from '../dag-plan-interpreter.js';

test('interpreter wraps worker.run with nodeId-annotated onPartial and emits node-start/-end', async () => {
  const calls: StreamChunk[] = [];
  const op: OnPartial = (c) => calls.push(c);
  const worker: ISubAgent = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run(input) {
      input.onPartial?.({ kind: 'content', delta: 'X' });
      return { output: 'X' };
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    {
      inputText: 'x',
      workers: new Map([['w', worker]]),
      sessionId: 's',
      onPartial: op,
      errorStrategy: new AbortErrorStrategy(),
    },
  );
  assert.equal(res.ok, true);
  // Order: start(a) → content(a) → end(a)
  assert.deepEqual(calls, [
    { kind: 'node-start', nodeId: 'a', goal: 'ga' },
    { kind: 'content', nodeId: 'a', delta: 'X' },
    { kind: 'node-end', nodeId: 'a', ok: true },
  ]);
});

test('interpreter emits node-end with ok:false on worker failure', async () => {
  const calls: StreamChunk[] = [];
  const op: OnPartial = (c) => calls.push(c);
  const failWorker: ISubAgent = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      throw new Error('boom');
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    {
      inputText: 'x',
      workers: new Map([['w', failWorker]]),
      sessionId: 's',
      onPartial: op,
      errorStrategy: {
        async onNodeFailure() {
          return { action: 'abort' as const };
        },
      },
    },
  );
  assert.equal(res.ok, false);
  const end = calls.find((c) => c.kind === 'node-end');
  assert.ok(end && end.kind === 'node-end' && end.ok === false);
});

test('interpreter without onPartial runs silently (default)', async () => {
  const worker: ISubAgent = {
    name: 'w',
    description: 'd',
    capabilities: { contextPolicy: 'optional' },
    async run() {
      return { output: 'X' };
    },
  };
  const interp = new DagPlanInterpreter();
  const res = await interp.interpret(
    { objective: 'o', nodes: [{ id: 'a', goal: 'ga' }], createdAt: 0 },
    {
      inputText: 'x',
      workers: new Map([['w', worker]]),
      sessionId: 's',
      errorStrategy: new AbortErrorStrategy(),
    },
  );
  assert.equal(res.ok, true);
});
