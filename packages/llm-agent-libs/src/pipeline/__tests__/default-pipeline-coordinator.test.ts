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
type Stage = { id: string; type: string; when?: string };
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

function findStage(stages: Stage[], type: string): Stage | undefined {
  return stages.find((s) => s.type === type);
}

describe('DefaultPipeline coordinator stage wiring', () => {
  it('no coordinator config → only tool-loop, no coordinator stages', () => {
    const pipeline = new DefaultPipeline();
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    assert.ok(findStage(stages, 'tool-loop'), 'tool-loop must be present');
    assert.equal(findStage(stages, 'tool-loop')?.when, undefined);
    assert.equal(findStage(stages, 'coordinator'), undefined);
    assert.equal(findStage(stages, 'coordinator-activate'), undefined);
  });

  it('coordinator configured → coordinator-activate + both stages with when predicates', () => {
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SelfDispatch(deps.mainLlm),
        activation: new ExplicitActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    assert.ok(
      findStage(stages, 'coordinator-activate'),
      'coordinator-activate stage must be wired in',
    );
    assert.equal(findStage(stages, 'coordinator')?.when, 'coordinatorActive');
    assert.equal(findStage(stages, 'tool-loop')?.when, '!coordinatorActive');
  });

  it('AutoActivation honours runtime ctx.coordinatorActive (gating via when)', () => {
    // The activation strategy now runs at runtime via coordinator-activate
    // stage, not at build time. Build-time only checks that the runtime
    // wiring is in place.
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SubAgentDispatch(),
        activation: new AutoActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    assert.ok(findStage(stages, 'coordinator-activate'));
    assert.equal(findStage(stages, 'coordinator')?.when, 'coordinatorActive');
    assert.equal(findStage(stages, 'tool-loop')?.when, '!coordinatorActive');
  });

  it('coordinator config but missing planning/dispatch → no coordinator wiring', () => {
    const pipeline = new DefaultPipeline({
      coordinator: { activation: new ExplicitActivation() },
    });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    assert.equal(findStage(stages, 'coordinator-activate'), undefined);
    assert.equal(findStage(stages, 'coordinator'), undefined);
    assert.equal(findStage(stages, 'tool-loop')?.when, undefined);
  });

  it('coordinator config without activation → defaults to ExplicitActivation, handler is registered', () => {
    // Reviewer scenario: direct DefaultPipeline construction with planning +
    // dispatch but no activation. Must NOT result in an unknown
    // coordinator-activate stage at runtime.
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SelfDispatch(deps.mainLlm),
        // activation: intentionally omitted
      },
    });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    assert.ok(
      findStage(stages, 'coordinator-activate'),
      'coordinator-activate must be in the stage list',
    );
    // Sanity: the underlying handler registry must include the
    // coordinator-activate handler. We verify indirectly by inspecting
    // the executor's known stage types.
    const executor = (
      pipeline as unknown as { executor: { handlers: Map<string, unknown> } }
    ).executor;
    assert.ok(
      executor.handlers.has('coordinator-activate'),
      'coordinator-activate handler must be registered when coordinator is configured',
    );
  });

  it('stage ordering: coordinator-activate runs after skill-select, before coordinator/tool-loop', () => {
    const { deps } = makeDefaultDeps();
    const pipeline = new DefaultPipeline({
      coordinator: {
        planning: new OneShotPlanning(deps.mainLlm),
        dispatch: new SubAgentDispatch(),
        activation: new ExplicitActivation(),
      },
    });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);
    const skillSelectIdx = stages.findIndex((s) => s.id === 'skill-select');
    const activateIdx = stages.findIndex(
      (s) => s.id === 'coordinator-activate',
    );
    const coordIdx = stages.findIndex((s) => s.id === 'coordinator');
    const toolLoopIdx = stages.findIndex((s) => s.id === 'tool-loop');
    assert.ok(skillSelectIdx >= 0);
    assert.ok(
      activateIdx > skillSelectIdx,
      'coordinator-activate must run AFTER skill-select so it can read selectedSkills',
    );
    assert.ok(coordIdx > activateIdx, 'coordinator after coordinator-activate');
    assert.ok(
      toolLoopIdx > activateIdx,
      'tool-loop after coordinator-activate',
    );
  });
});
