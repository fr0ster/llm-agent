import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DagPlan,
  IInterpreter,
  InterpretResult,
  IPlanner,
} from '@mcp-abap-adt/llm-agent';
import { CoordinatorHandler } from '../coordinator.js';
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

  it('registers the linear CoordinatorHandler when only coordinator is set', () => {
    const reg = buildDefaultHandlerRegistry({
      coordinator: {
        planning: {
          name: 'p',
          buildInitialPlan: async () => ({
            steps: [],
            createdAt: 0,
            source: 'manual',
          }),
          shouldReplan: () => false,
          rebuildPlan: async () => ({
            steps: [],
            createdAt: 0,
            source: 'manual',
          }),
        } as unknown as import('@mcp-abap-adt/llm-agent').IPlanningStrategy,
        dispatch: {
          name: 'd',
          dispatch: async () => ({
            stepId: 's',
            output: '',
            ok: true,
            durationMs: 0,
          }),
        } as unknown as import('@mcp-abap-adt/llm-agent').IDispatchStrategy,
        maxSteps: 5,
        maxRetriesPerStep: 0,
        failPolicy: 'abort',
      },
      coordinatorActivation: { name: 'explicit', shouldActivate: () => true },
    });
    assert.ok(reg.get('coordinator') instanceof CoordinatorHandler);
  });

  it('DAG takes precedence when both coordinator and dagCoordinator are set', () => {
    const planner = {
      name: 'p',
      plan: async () => ({ nodes: [{ id: 'n', goal: 'g' }], createdAt: 0 }),
    } as IPlanner;
    const interpreter = {
      name: 'i',
      interpret: async () => ({ nodeResults: {}, ok: true, output: 'x' }),
    } as IInterpreter<DagPlan, InterpretResult>;
    const reg = buildDefaultHandlerRegistry({
      coordinator: {
        planning: {
          name: 'p',
          buildInitialPlan: async () => ({
            steps: [],
            createdAt: 0,
            source: 'manual',
          }),
          shouldReplan: () => false,
          rebuildPlan: async () => ({
            steps: [],
            createdAt: 0,
            source: 'manual',
          }),
        } as unknown as import('@mcp-abap-adt/llm-agent').IPlanningStrategy,
        dispatch: {
          name: 'd',
          dispatch: async () => ({
            stepId: 's',
            output: '',
            ok: true,
            durationMs: 0,
          }),
        } as unknown as import('@mcp-abap-adt/llm-agent').IDispatchStrategy,
        maxSteps: 5,
        maxRetriesPerStep: 0,
        failPolicy: 'abort',
      },
      dagCoordinator: { planner, interpreter, workers: new Map() },
      coordinatorActivation: { name: 'explicit', shouldActivate: () => true },
    });
    assert.ok(reg.get('coordinator') instanceof DagCoordinatorHandler);
  });
});
