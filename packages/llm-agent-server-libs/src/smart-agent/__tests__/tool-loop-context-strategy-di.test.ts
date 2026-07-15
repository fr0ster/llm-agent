/**
 * DI seam: the tool-loop context strategy factory. Proves the truth table for
 * the SmartServer (non-controller) channel:
 *   - NO injection  → non-controller pipelines receive a Window factory.
 *   - YES injection → non-controller pipelines receive the CONSUMER's factory.
 *   - the ctx seam (read by the controller) carries ONLY the consumer factory
 *     (undefined when not injected) — so the Window default never leaks into
 *     the controller's own default resolution.
 * Focused unit assertions on the private buildBaseBuilder channel; no HTTP I/O.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  ToolLoopContextStrategyFactory,
} from '@mcp-abap-adt/llm-agent';
import {
  SmartAgentBuilder,
  WindowContextStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerConfig } from '../smart-server.js';
import { SmartServer } from '../smart-server.js';

const MINIMAL_CFG = {
  llm: { main: { provider: 'openai', apiKey: 'x', model: 'gpt-4o' } },
} as unknown as SmartServerConfig;

const stubLlm: ILlm = {
  chat: async () =>
    ({ ok: true, value: { content: 'ok', toolCalls: [] } }) as never,
  streamChat: async function* () {},
  model: 'stub',
} as unknown as ILlm;

/**
 * Drive the private buildBaseBuilder and capture the factory it threads onto the
 * builder via withToolLoopContextStrategyFactory — this is exactly what the
 * non-controller (default/flat/linear/dag) pipelines receive via createAgentBuilder.
 */
async function captureBuilderFactory(
  server: SmartServer,
): Promise<ToolLoopContextStrategyFactory | undefined> {
  const orig = SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory;
  let captured: ToolLoopContextStrategyFactory | undefined;
  SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory = function (
    factory,
  ) {
    captured = factory;
    return orig.call(this, factory);
  } as typeof orig;
  try {
    await (
      server as unknown as {
        buildBaseBuilder: (parts: unknown) => Promise<SmartAgentBuilder>;
      }
    ).buildBaseBuilder({
      mainLlm: stubLlm,
      classifierLlm: stubLlm,
      fileLogger: { info() {}, warn() {}, error() {}, debug() {} },
      workerRegistry: new Map(),
      applyServerExtras: false,
    });
  } finally {
    SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory = orig;
  }
  return captured;
}

test('NO injection: non-controller path receives a Window factory (server default)', async () => {
  const server = new SmartServer(MINIMAL_CFG);
  const factory = await captureBuilderFactory(server);
  assert.ok(
    factory,
    'non-controller path must receive a factory (Window default)',
  );
  const strategy = factory?.({
    run: {} as never,
  });
  assert.ok(
    strategy instanceof WindowContextStrategy,
    'server default for non-controller pipelines must be Window',
  );
});

test('YES injection: non-controller path receives the CONSUMER factory (overrides Window)', async () => {
  const sentinel = { form: async () => [], record: async () => {} };
  const consumerFactory: ToolLoopContextStrategyFactory = () =>
    sentinel as never;
  const server = new SmartServer(MINIMAL_CFG, {
    toolLoopContextStrategyFactory: consumerFactory,
  });
  const factory = await captureBuilderFactory(server);
  assert.strictEqual(
    factory,
    consumerFactory,
    'injected factory must reach the non-controller builder verbatim',
  );
  assert.ok(
    !(factory?.({ run: {} as never }) instanceof WindowContextStrategy),
    'consumer strategy must NOT be Window',
  );
});

test('ctx seam carries ONLY the consumer factory (undefined when not injected) — no Window leak to controller', () => {
  const noInject = new SmartServer(MINIMAL_CFG);
  assert.equal(
    (
      noInject as unknown as {
        _toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
      }
    )._toolLoopContextStrategyFactory,
    undefined,
    'no injection → seam is undefined (controller resolves its own RagRecall default)',
  );

  const consumerFactory: ToolLoopContextStrategyFactory = () => ({}) as never;
  const injected = new SmartServer(MINIMAL_CFG, {
    toolLoopContextStrategyFactory: consumerFactory,
  });
  assert.strictEqual(
    (
      injected as unknown as {
        _toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
      }
    )._toolLoopContextStrategyFactory,
    consumerFactory,
    'injection → seam is the consumer factory (threaded onto ctx for the controller)',
  );
});
