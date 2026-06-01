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
import {
  makeAssembler,
  makeClassifier,
  makeDefaultDeps,
  makeLlm,
} from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';
import type { IStageHandler } from '../stage-handler.js';

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

// ---------------------------------------------------------------------------
// Integration: withStepperCoordinator only — regression guard for the dead-path
// bug where anyCoordinatorStage omitted the stepperCoordinator check, causing
// the pipeline to fall through to an unconditional tool-loop instead of emitting
// coordinator-activate + coordinator stages. The stub handler proves the
// registered handler IS invoked, not the tool-loop.
// ---------------------------------------------------------------------------

describe('DefaultPipeline withStepperCoordinator integration', () => {
  it('emits coordinator stages when only withStepperCoordinator is set', () => {
    const stub: IStageHandler = {
      async execute() {
        return true;
      },
    };
    const pipeline = new DefaultPipeline({ stepperCoordinator: stub });
    pipeline.initialize(buildDeps());
    const stages = getStages(pipeline);

    assert.ok(
      findStage(stages, 'coordinator-activate'),
      'coordinator-activate must be emitted when only stepperCoordinator is configured',
    );
    assert.equal(
      findStage(stages, 'coordinator')?.when,
      'coordinatorActive',
      'coordinator stage must carry when:coordinatorActive guard',
    );
    assert.equal(
      findStage(stages, 'tool-loop')?.when,
      '!coordinatorActive',
      'tool-loop must carry when:!coordinatorActive guard (not unconditional)',
    );
  });

  it('invokes the stepper stub handler and NOT the unconditional tool-loop', async () => {
    let stubInvoked = false;
    let toolLoopInvoked = false;

    // Stub stepper coordinator: records invocation, emits a stop chunk.
    const stub: IStageHandler = {
      async execute(ctx: unknown) {
        stubInvoked = true;
        // Yield a minimal stop chunk so the pipeline finishes cleanly.
        (ctx as { yield: (c: unknown) => void }).yield({
          ok: true,
          value: { content: 'stepper-output', finishReason: 'stop' },
        });
        return true;
      },
    };

    const llm = makeLlm([{ content: 'fallback', finishReason: 'stop' }]);
    const pipeline = new DefaultPipeline({ stepperCoordinator: stub });
    pipeline.initialize({
      mainLlm: llm,
      mcpClients: [],
      classifier: makeClassifier([{ type: 'action', text: 'do it' }]),
      assembler: makeAssembler(),
    });

    // Monkey-patch tool-loop handler to detect if it fires.
    const executor = (
      pipeline as unknown as {
        executor: { handlers: Map<string, IStageHandler> };
      }
    ).executor;
    const originalToolLoop = executor.handlers.get('tool-loop');
    executor.handlers.set('tool-loop', {
      async execute(...args: Parameters<IStageHandler['execute']>) {
        toolLoopInvoked = true;
        return originalToolLoop ? originalToolLoop.execute(...args) : true;
      },
    });

    const chunks: unknown[] = [];
    await pipeline.execute('hello', [], undefined, (chunk) =>
      chunks.push(chunk),
    );

    assert.equal(stubInvoked, true, 'stepper stub handler must be invoked');
    assert.equal(
      toolLoopInvoked,
      false,
      'unconditional tool-loop must NOT fire when stepperCoordinator is active',
    );
  });
});
