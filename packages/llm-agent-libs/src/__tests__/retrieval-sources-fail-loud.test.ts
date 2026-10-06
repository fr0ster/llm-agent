/**
 * Spec §10.5.4 R6–R8 — the non-pipeline retrieval paths fail loud:
 * - R6 the legacy orchestrator returns a failed store's error (never `[]`);
 * - R7 the builder's sub-agent retrieval source throws the store's RagError;
 * - R8 DefaultSubAgentContextBuilder lets a throwing source fail the build,
 *   and the coordinator reports COORDINATOR_STEP_FAILED carrying the code.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IPlanningStrategy,
  IQueryEmbedder,
  IRag,
  ISubAgent,
  Plan,
  PlanStep,
  RagResult,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { RagError, symmetricEmbedder } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder } from '../builder.js';
import { SubAgentDispatch } from '../coordinator/dispatch/subagent.js';
import type { PipelineContext } from '../pipeline/context.js';
import {
  CoordinatorHandler,
  type CoordinatorHandlerDeps,
} from '../pipeline/handlers/coordinator.js';
import {
  DefaultSubAgentContextBuilder,
  type SubAgentRetrievalSource,
} from '../subagent/default-context-builder.js';
import { makeDefaultDeps } from '../testing/index.js';
import type { ISpan } from '../tracer/types.js';

const circuitOpen = (): Result<RagResult[], RagError> => ({
  ok: false,
  error: new RagError('open', 'CIRCUIT_OPEN'),
});

function failingStore(): IRag & { queries: number } {
  const s = {
    queries: 0,
    async query() {
      s.queries++;
      return circuitOpen();
    },
    async healthCheck() {
      return { ok: true as const, value: undefined };
    },
    async getById() {
      return { ok: true as const, value: null };
    },
  };
  return s as unknown as IRag & { queries: number };
}

const embedder: IQueryEmbedder = symmetricEmbedder({
  async embed() {
    return { vector: [1, 0] };
  },
});

describe('R6 legacy orchestrator: a failed store fails the request', () => {
  it('SmartAgent.process (no pipeline) → ok:false with the store code naming it', async () => {
    const kb = failingStore();
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const agent = new SmartAgent(deps, { maxIterations: 3 });
    const r = await agent.process('what is alpha?');
    assert.equal(kb.queries, 1, 'the store was asked');
    assert.ok(!r.ok, 'the request answered without the store');
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
    assert.match(r.error.message, /store "kb" failed: open/);
  });
});

describe('R6 legacy orchestrator: a store whose query rejects fails the request', () => {
  it('SmartAgent.process (no pipeline) → ok:false with the RagError code naming the store', async () => {
    const kb = {
      async query() {
        throw new RagError('open', 'CIRCUIT_OPEN');
      },
      async healthCheck() {
        return { ok: true as const, value: undefined };
      },
    } as unknown as IRag;
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const agent = new SmartAgent(deps, { maxIterations: 3 });
    const r = await agent.process('what is alpha?');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'CIRCUIT_OPEN');
    assert.match(r.error.message, /store "kb" failed: open/);
  });

  it('a plain rejection → QUERY_ERROR naming the store', async () => {
    const kb = {
      async query() {
        throw new Error('socket closed');
      },
      async healthCheck() {
        return { ok: true as const, value: undefined };
      },
    } as unknown as IRag;
    const { deps } = makeDefaultDeps({ ragStores: { kb } });
    const r = await new SmartAgent(deps, { maxIterations: 3 }).process('q?');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'QUERY_ERROR');
    assert.match(r.error.message, /store "kb" failed: .*socket closed/);
  });
});

describe('R7 builder: the sub-agent retrieval source throws the store error', () => {
  it('a failed query rejects with the RagError (never [])', async () => {
    const builder = new SmartAgentBuilder() as unknown as {
      buildRetrievalSource(
        rag: IRag,
        e: IQueryEmbedder,
      ): SubAgentRetrievalSource | undefined;
    };
    const source = builder.buildRetrievalSource(failingStore(), embedder);
    assert.ok(source);
    await assert.rejects(source('q', 3), (e: unknown) => {
      assert.ok(e instanceof RagError);
      assert.equal(e.code, 'CIRCUIT_OPEN');
      return true;
    });
  });
});

const agent: ISubAgent = {
  name: 'leaf',
  capabilities: { contextPolicy: 'optional' },
  async run() {
    return { output: 'ran' };
  },
};

function throwingSource(): SubAgentRetrievalSource {
  return async () => {
    throw new RagError('open', 'CIRCUIT_OPEN');
  };
}

describe('R8 DefaultSubAgentContextBuilder: a throwing source fails the build', () => {
  for (const which of ['projectSource', 'toolSource'] as const) {
    it(`${which} throws → build rejects with that error`, async () => {
      const cb = new DefaultSubAgentContextBuilder({
        [which]: throwingSource(),
      });
      await assert.rejects(
        cb.build({
          task: 't',
          step: { id: 's1', goal: 't', status: 'pending' },
          agent,
          inputText: 't',
          sessionId: 's',
        }),
        (e: unknown) => e instanceof RagError && e.code === 'CIRCUIT_OPEN',
      );
    });
  }

  it('the coordinator fails the step: COORDINATOR_STEP_FAILED, message carrying the store code', async () => {
    let ran = 0;
    const leaf: ISubAgent = {
      ...agent,
      async run() {
        ran++;
        return { output: 'ran' };
      },
    };
    const planning: IPlanningStrategy = {
      name: 'fake',
      async buildInitialPlan() {
        return {
          steps: [
            { id: 's1', goal: 'g', agent: 'leaf', status: 'pending' },
          ] as PlanStep[],
          rationale: 'test',
          createdAt: 0,
          source: 'manual',
        } as Plan;
      },
      shouldReplan() {
        return false;
      },
      async rebuildPlan() {
        return { steps: [], rationale: '', createdAt: 0, source: 'manual' };
      },
    };
    const deps: CoordinatorHandlerDeps = {
      planning,
      dispatch: new SubAgentDispatch(
        new DefaultSubAgentContextBuilder({ toolSource: throwingSource() }),
      ),
      maxSteps: 5,
      maxRetriesPerStep: 0,
      failPolicy: 'abort',
    };
    const ctx = {
      inputText: 'top',
      sessionId: 's',
      assembledMessages: [],
      options: { signal: undefined },
      subAgents: new Map([['leaf', leaf]]),
      yield() {},
    } as unknown as PipelineContext;
    const ok = await new CoordinatorHandler(deps).execute(ctx, {}, {
      setAttribute() {},
      setStatus() {},
      addEvent() {},
      end() {},
    } as unknown as ISpan);
    assert.equal(ok, false);
    assert.equal(ctx.error?.code, 'COORDINATOR_STEP_FAILED');
    assert.match(ctx.error?.message ?? '', /CIRCUIT_OPEN/);
    assert.equal(ran, 0, 'the sub-agent did not run without its context');
  });
});
