import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ILlm, IQueryExpander } from '@mcp-abap-adt/llm-agent';
import {
  LlmError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder, unwrapBuilderResult } from '../builder.js';
import { buildAgentHealthSnapshot } from '../health/agent-health.js';
import {
  makeClassifier,
  makeLlm,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

for (const thrown of [false, true]) {
  const mode = thrown ? 'thrown' : 'returned';
  for (const terminal of [false, true]) {
    const error = new LlmError(
      'Probe failed',
      terminal ? MODEL_CONTEXT_EXCEEDED : 'CONFIG_ERROR',
    );
    test(`health chat probe preserves ${mode} ${error.code}`, async () => {
      let calls = 0;
      const llm: ILlm = {
        ...makeLlm([]),
        healthCheck: undefined,
        async chat() {
          calls++;
          if (thrown) throw error;
          return { ok: false, error };
        },
      };
      const snapshot = buildAgentHealthSnapshot(llm, {}, [], {});
      if (terminal) {
        await assert.rejects(snapshot, { code: MODEL_CONTEXT_EXCEEDED });
      } else {
        assert.equal((await snapshot).llm, false);
      }
      assert.equal(calls, 1);
    });

    test(`pipeline expand stage handles ${mode} ${error.code}`, async () => {
      let calls = 0;
      const llm: ILlm = {
        ...makeLlm([]),
        async chat() {
          calls++;
          if (thrown) throw error;
          return { ok: false, error };
        },
      };
      const expander: IQueryExpander = {
        async expand(query, options) {
          const result = await llm.chat(
            [{ role: 'user', content: query }],
            [],
            options,
          );
          if (result.ok) return { ok: true, value: result.value.content };
          return {
            ok: false,
            error: Object.assign(new RagError('Expansion failed'), {
              cause: result.error,
            }),
          };
        },
      };

      const queries: string[] = [];
      const rag = makeRag([]);
      const main = makeLlm([{ content: 'Finished' }]);
      const handle = unwrapBuilderResult(
        await new SmartAgentBuilder({ skipModelValidation: true })
          .withRagAccess(testRequestAccess)
          .withMainLlm(main)
          .withClassifier(
            makeClassifier([{ type: 'action', text: 'read reports' }]),
          )
          .withQueryExpander(expander)
          .withQueryExpansion(true)
          .setToolsRag({
            ...rag,
            async query(embedding, k, options) {
              queries.push(embedding.text);
              return rag.query(embedding, k, options);
            },
          })
          .build(),
      );
      try {
        const result = await handle.agent.process(
          'read reports',
          testCallOptions(),
        );
        assert.equal(calls, 1);
        if (terminal) {
          assert.ok(!result.ok);
          assert.equal(result.error.code, MODEL_CONTEXT_EXCEEDED);
          assert.deepEqual(queries, []);
          assert.equal(main.callCount, 0);
        } else if (!thrown) {
          assert.ok(result.ok);
          assert.deepEqual(queries, ['read reports']);
        } else {
          assert.deepEqual(queries, []);
          assert.equal(main.callCount, 0);
        }
      } finally {
        await handle.close();
      }
    });
  }
}
