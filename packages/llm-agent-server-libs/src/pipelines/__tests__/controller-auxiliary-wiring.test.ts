import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DefaultAuxiliaryMcpTools } from '@mcp-abap-adt/llm-agent-mcp';
import { ControllerFactory } from '../../factories/controller-factory.js';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeControllerServerCtx } from './fixtures.js';

// Reuse the ControllerFactoryDeps-capturing harness from
// controller-step-control-wiring.test.ts (same dir): build the controller
// pipeline with a ctx override and capture the deps passed to the handler.
type CapturedDeps = {
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<{ text: string; isError: boolean }>;
  selectTools: (
    query: string,
    k?: number,
  ) => Promise<ReadonlyArray<{ name: string }>>;
};

async function buildAndCaptureControllerDeps(
  ctxOverride?: Partial<
    import('../server-context.js').IControllerServerPipelineContext
  >,
): Promise<CapturedDeps> {
  const orig = ControllerFactory.prototype.build;
  let captured: CapturedDeps | undefined;
  ControllerFactory.prototype.build = async function (cfg, deps, kind) {
    const d = deps as Record<string, unknown>;
    captured = {
      callMcp: d.callMcp as CapturedDeps['callMcp'],
      selectTools: d.selectTools as CapturedDeps['selectTools'],
    };
    return orig.call(this, cfg, deps, kind);
  } as typeof orig;
  try {
    const plugin = new ControllerPipelinePlugin();
    const cfg = plugin.parseConfig({
      subagents: {
        evaluator: { provider: 'openai' },
        planner: { provider: 'openai' },
        executor: { provider: 'openai' },
      },
    });
    const inst = await plugin.build(cfg, {
      ...fakeControllerServerCtx(),
      ...ctxOverride,
    });
    await inst.close();
  } finally {
    ControllerFactory.prototype.build = orig;
  }
  if (!captured) {
    throw new Error(
      'controller did not call ControllerFactory.build — spy never fired',
    );
  }
  return captured;
}

test('controller default: callMcp is aux-first and selectTools includes wait', async () => {
  const deps = await buildAndCaptureControllerDeps({
    /* no auxiliaryMcpTools */
  });
  // wait is offered even with no domain tools:
  const tools = await deps.selectTools('review then activate then verify', 8);
  assert.ok(tools.some((t) => t.name === 'wait'));
  // calling wait goes through the aux branch and returns its text (not "Tool not found"):
  const out = await deps.callMcp('wait', { seconds: 0 });
  assert.equal(out.text, 'Waited 0s');
  assert.equal(out.isError, false);
});

test('controller consumer override beats the default wait', async () => {
  const custom = new DefaultAuxiliaryMcpTools([]); // empty → restores prior surface
  const deps = await buildAndCaptureControllerDeps({
    auxiliaryMcpTools: custom,
  });
  const tools = await deps.selectTools('x', 8);
  assert.ok(!tools.some((t) => t.name === 'wait'));
});
