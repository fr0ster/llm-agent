import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ILlm,
  ToolLoopContextStrategyFactory,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import {
  LegacyAccumulateContextStrategy,
  SmartAgentBuilder,
  WindowContextStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import type { SmartServerConfig } from '../smart-server.js';
import { constructionSeams } from './construction-seams.js';
import { TestSmartServer as SmartServer } from './rag-identity-fixture.js';

const MINIMAL_CFG: Partial<SmartServerConfig> = {
  llm: { main: { provider: 'openai', model: 'test-model' } },
};
const stubLlm: ILlm = {
  chat: async () => ({
    ok: true,
    value: { content: 'ok', finishReason: 'stop' },
  }),
  streamChat: async function* () {},
  model: 'stub',
};

// Every non-controller server/YAML pipeline obtains its builder through this seam.
async function captureBuilderFactory(
  server: SmartServer,
): Promise<ToolLoopContextStrategyFactory> {
  const orig = SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory;
  let captured: ToolLoopContextStrategyFactory | undefined;
  SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory = function (
    factory,
  ) {
    captured = factory;
    return orig.call(this, factory);
  };
  try {
    await server['buildBaseBuilder']({
      mainLlm: stubLlm,
      classifierLlm: stubLlm,
      fileLogger: { log() {} },
      workerRegistry: new Map(),
      applyServerExtras: false,
    });
  } finally {
    SmartAgentBuilder.prototype.withToolLoopContextStrategyFactory = orig;
  }
  assert.ok(captured, 'server must explicitly supply its full-history default');
  return captured;
}

test('server/YAML default retains six complete tool rounds in order', async () => {
  const server = new SmartServer(MINIMAL_CFG, constructionSeams);
  const factory = await captureBuilderFactory(server);
  const strategy = factory({});
  assert.ok(strategy instanceof LegacyAccumulateContextStrategy);
  const rounds: ToolRound[] = Array.from({ length: 6 }, (_, index) => ({
    assistant: {
      role: 'assistant',
      content: `ASSISTANT-${index}`,
      tool_calls: [
        {
          id: `call-${index}`,
          type: 'function',
          function: { name: 'Work', arguments: JSON.stringify({ index }) },
        },
      ],
    },
    results: [
      {
        role: 'tool',
        tool_call_id: `call-${index}`,
        content: `RESULT-${index}`,
      },
    ],
  }));
  for (const round of rounds) await strategy.record(round);
  assert.deepEqual(
    await strategy.form({ prefix: [] }),
    rounds.flatMap((round) => [round.assistant, ...round.results]),
  );
});

test('server threads a consumer-selected lossy window to the builder verbatim', async () => {
  const consumerFactory: ToolLoopContextStrategyFactory = () =>
    new WindowContextStrategy({ keepLastRounds: 1 });
  const server = new SmartServer(MINIMAL_CFG, {
    ...constructionSeams,
    toolLoopContextStrategyFactory: consumerFactory,
  });
  assert.equal(await captureBuilderFactory(server), consumerFactory);
});

test('controller context seam carries only the explicit consumer selection', () => {
  const noInject = new SmartServer(MINIMAL_CFG, constructionSeams);
  assert.equal(noInject['_toolLoopContextStrategyFactory'], undefined);
  const consumerFactory: ToolLoopContextStrategyFactory = () =>
    new WindowContextStrategy({ keepLastRounds: 1 });
  const injected = new SmartServer(MINIMAL_CFG, {
    ...constructionSeams,
    toolLoopContextStrategyFactory: consumerFactory,
  });
  assert.equal(injected['_toolLoopContextStrategyFactory'], consumerFactory);
});
