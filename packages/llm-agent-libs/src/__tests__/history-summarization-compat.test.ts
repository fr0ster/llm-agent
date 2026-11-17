import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IContextAssembler, Message } from '@mcp-abap-adt/llm-agent';
import { SmartAgent } from '../agent.js';
import { SmartAgentBuilder, unwrapBuilderResult } from '../builder.js';
import { SessionManager } from '../session/session-manager.js';
import {
  makeDefaultDeps,
  makeLlm,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

for (const path of ['direct', 'builder'] as const) {
  for (const configured of [false, true]) {
    test(`${path}: deprecated summarization options are inert (configured=${configured})`, async () => {
      const history: Message[] = Array.from({ length: 24 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}: ${'x'.repeat(2_000)}`,
      }));
      const snapshot = structuredClone(history);
      const helper = makeLlm([{ content: 'must not be used' }]);
      const session = new SessionManager({ tokenBudget: 1 });
      session.addTokens(100);
      let assembled = 0;
      const assembler: IContextAssembler = {
        async assemble(_action, _retrieved, messages) {
          assembled++;
          assert.deepEqual(messages, snapshot);
          return { ok: true, value: history };
        },
      };
      const config = configured
        ? {
            historyAutoSummarizeLimit: 1,
            historySummaryPrompt: 'must not be used',
            sessionTokenBudget: 1,
          }
        : {};

      if (path === 'direct') {
        const { deps } = makeDefaultDeps({
          assembler,
          sessionManager: session,
        });
        deps.helperLlm = helper;
        const result = await new SmartAgent(deps, config).process(
          history,
          testCallOptions(),
        );
        assert.ok(result.ok);
      } else {
        const builder = new SmartAgentBuilder({
          skipModelValidation: true,
          agent: config,
          prompts: { historySummary: 'must not be used' },
        })
          .withRagAccess(testRequestAccess)
          .withMainLlm(makeLlm([{ content: 'done' }]))
          .withHelperLlm(helper)
          .withAssembler(assembler)
          .withSessionManager(session);
        assert.equal(builder.withHistorySummarization(1), builder);
        assert.equal(builder.withSessionTokenBudget(1), builder);
        const handle = unwrapBuilderResult(await builder.build());
        try {
          assert.equal(handle.ragStores.history, undefined);
          const result = await handle.agent.process(history, testCallOptions());
          assert.ok(result.ok);
        } finally {
          await handle.close();
        }
      }
      assert.equal(assembled, 1);
      assert.equal(helper.callCount, 0);
      assert.deepEqual(history, snapshot);
      assert.ok(session.isOverBudget(), 'usage accounting must not be reset');
    });
  }
}
