import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IMcpClient,
  IRunExecutionControl,
  IStepExecutionControl,
} from '@mcp-abap-adt/llm-agent';
import { ControllerFactory } from '../../factories/controller-factory.js';
import { DefaultStepExecutionControl } from '../../smart-agent/controller/default-step-execution-control.js';
import { NoopRunExecutionControl } from '../../smart-agent/controller/noop-run-execution-control.js';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeControllerServerCtx } from './fixtures.js';

// Spy on ControllerFactory.prototype.build to capture the handler deps injected
// by ControllerPipelinePlugin.build — mirrors controller-context-wiring.test.ts.
type CapturedHandlerDeps = {
  stepExecutionControl: unknown;
  runExecutionControl: unknown;
  callMcp: (
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

async function buildAndCaptureDeps(
  ctxOverride?: Partial<
    import('../server-context.js').IControllerServerPipelineContext
  >,
): Promise<CapturedHandlerDeps> {
  const orig = ControllerFactory.prototype.build;
  let captured: CapturedHandlerDeps | undefined;
  ControllerFactory.prototype.build = async function (cfg, deps, kind) {
    const d = deps as Record<string, unknown>;
    captured = {
      stepExecutionControl: d['stepExecutionControl'],
      runExecutionControl: d['runExecutionControl'],
      callMcp: d['callMcp'] as CapturedHandlerDeps['callMcp'],
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

// ── Minimal sentinel implementations ──────────────────────────────────────────
function sentinelStepControl(): IStepExecutionControl {
  return {
    beginStep: () => ({
      signal: new AbortController().signal,
      shouldContinueRound: () => ({ continue: true as const }),
      canExecuteTool: () => ({ continue: true as const }),
      dispose: () => {},
    }),
  };
}

function sentinelRunControl(): IRunExecutionControl {
  return {
    beginRun: () => ({
      signal: new AbortController().signal,
      shouldContinue: () => ({ continue: true as const }),
      dispose: () => {},
    }),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('controller step-control wiring — defaults (no injection)', () => {
  it('passes a DefaultStepExecutionControl to the handler when ctx.stepExecutionControl is absent', async () => {
    const deps = await buildAndCaptureDeps();
    assert.ok(
      deps.stepExecutionControl instanceof DefaultStepExecutionControl,
      `expected DefaultStepExecutionControl, got ${String(deps.stepExecutionControl)}`,
    );
  });

  it('passes a NoopRunExecutionControl to the handler when ctx.runExecutionControl is absent', async () => {
    const deps = await buildAndCaptureDeps();
    assert.ok(
      deps.runExecutionControl instanceof NoopRunExecutionControl,
      `expected NoopRunExecutionControl, got ${String(deps.runExecutionControl)}`,
    );
  });
});

describe('controller step-control wiring — consumer override (DI seam)', () => {
  it('threads consumer-injected ctx.stepExecutionControl verbatim into handler deps', async () => {
    const custom = sentinelStepControl();
    const deps = await buildAndCaptureDeps({ stepExecutionControl: custom });
    assert.strictEqual(
      deps.stepExecutionControl,
      custom,
      'handler must receive the consumer-injected stepExecutionControl, not the default',
    );
  });

  it('threads consumer-injected ctx.runExecutionControl verbatim into handler deps', async () => {
    const customRun = sentinelRunControl();
    const deps = await buildAndCaptureDeps({ runExecutionControl: customRun });
    assert.strictEqual(
      deps.runExecutionControl,
      customRun,
      'handler must receive the consumer-injected runExecutionControl, not the default',
    );
  });

  it('with NO injection the handler does NOT receive the consumer sentinel (sanity guard)', async () => {
    const sentinel = sentinelStepControl();
    const deps = await buildAndCaptureDeps(); // no override
    assert.notStrictEqual(
      deps.stepExecutionControl,
      sentinel,
      'without injection the handler must NOT receive the sentinel',
    );
  });
});

describe('controller step-control wiring — callMcp signal forwarding', () => {
  it('callMcp in ControllerFactoryDeps forwards the AbortSignal through buildMcpBridge to the MCP client', async () => {
    // The callMcp in ControllerFactoryDeps is controller.ts's
    //   `(name, args, signal) => mcpBridge(name, args, signal)`
    // (after the fix). Before the fix it was `(name, args) => mcpBridge(name, args)`,
    // dropping the signal. We verify the signal reaches the MCP client by injecting
    // a fake client whose callTool captures opts.signal.

    const callToolSignals: Array<AbortSignal | undefined> = [];
    const fakeMcpClient: IMcpClient = {
      listTools: async () => ({
        ok: true,
        value: [{ name: 'test-tool', description: '', inputSchema: {} }],
      }),
      callTool: async (_name, _args, opts) => {
        callToolSignals.push(opts?.signal);
        return { ok: true, value: { content: [{ type: 'text', text: 'ok' }] } };
      },
    };

    const sig = AbortSignal.timeout(60_000); // a real signal we can identify by ref

    // Inject a fake MCP client so mcpBridge can route the call (and capture signal).
    const deps = await buildAndCaptureDeps({ mcpClients: [fakeMcpClient] });

    // deps.callMcp = controller.ts's `(name, args, signal) => mcpBridge(name, args, signal)`.
    // Calling it routes through buildMcpBridge → fakeMcpClient.callTool.
    await deps.callMcp('test-tool', {}, sig);

    assert.equal(
      callToolSignals.length,
      1,
      'MCP client callTool must be reached',
    );
    assert.strictEqual(
      callToolSignals[0],
      sig,
      'signal must be forwarded to the MCP client (not dropped)',
    );
  });
});
