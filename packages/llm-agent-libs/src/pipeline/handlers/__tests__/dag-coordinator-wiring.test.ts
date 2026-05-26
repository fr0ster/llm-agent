import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
} from '@mcp-abap-adt/llm-agent';
import { DagCoordinatorHandler } from '../dag-coordinator.js';
import { buildDefaultHandlerRegistry } from '../index.js';

describe('handler registry — DAG coordinator', () => {
  it('registers DagCoordinatorHandler under the coordinator stage when dagCoordinator is set', () => {
    const planner = {
      name: 'p',
      plan: async () => ({ nodes: [{ id: 'n', goal: 'g' }], createdAt: 0 }),
    } as IPlanner;
    const interpreter = {
      name: 'i',
      interpret: async () => ({ nodeResults: {}, ok: true, output: 'x' }),
    } as IInterpreter<DagPlan, InterpretResult>;
    const reg = buildDefaultHandlerRegistry({
      dagCoordinator: { planner, interpreter, workers: new Map() },
      coordinatorActivation: { name: 'explicit', shouldActivate: () => true },
    });
    assert.ok(reg.get('coordinator') instanceof DagCoordinatorHandler);
  });
});
