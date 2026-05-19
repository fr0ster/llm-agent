import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AutoActivation,
  ExplicitActivation,
  OneShotPlanning,
  SelfDispatch,
  SubAgentDispatch,
} from '../../coordinator/index.js';
import type { PipelineDeps } from '../../interfaces/pipeline.js';
import { makeDefaultDeps } from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';

// Mirrors helpers from sibling default-pipeline-* tests.
type Stage = { id: string; type: string };
type PipelineWithStages = { stages: Stage[] };

function buildDeps(overrides?: Partial<PipelineDeps>): PipelineDeps {
  const { deps: base } = makeDefaultDeps();
  return {
    mainLlm: base.mainLlm,
    mcpClients: base.mcpClients ?? [],
    ...overrides,
  };
}

function getStages(pipeline: DefaultPipeline): Stage[] {
  return (pipeline as unknown as PipelineWithStages).stages;
}

function findLooperType(stages: Stage[]): string | undefined {
  return stages.find((s) => s.type === 'coordinator' || s.type === 'tool-loop')
    ?.type;
}

describe('DefaultPipeline coordinator activation', () => {
  it('no coordinator config → keeps tool-loop', () => {
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps());
    assert.equal(findLooperType(getStages(pipeline)), 'tool-loop');
  });

  it('ExplicitActivation + SelfDispatch without subagents → swaps to coordinator', () => {
    // Reviewer scenario: registry-free SelfDispatch must reach the handler.
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SelfDispatch(deps.mainLlm),
        activation: new ExplicitActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    assert.equal(findLooperType(getStages(pipeline)), 'coordinator');
  });

  it('AutoActivation without subagents → stays on tool-loop (graceful fallback)', () => {
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SubAgentDispatch(),
        activation: new AutoActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    assert.equal(findLooperType(getStages(pipeline)), 'tool-loop');
  });

  it('AutoActivation with subagents in registry → swaps to coordinator', () => {
    const { deps } = makeDefaultDeps();
    const registry = new Map();
    registry.set('worker', {
      name: 'worker',
      description: 'does stuff',
      async run() {
        return { output: 'ok' };
      },
    });
    const pipeline = new DefaultPipeline({
      subAgents: registry,
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SubAgentDispatch(),
        activation: new AutoActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    assert.equal(findLooperType(getStages(pipeline)), 'coordinator');
  });

  it('coordinator config but missing planning/dispatch → tool-loop fallback', () => {
    const pipeline = new DefaultPipeline({
      coordinator: { activation: new ExplicitActivation() },
    });
    pipeline.initialize(buildDeps());
    assert.equal(findLooperType(getStages(pipeline)), 'tool-loop');
  });
});
