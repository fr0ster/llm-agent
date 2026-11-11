import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IRag, IReranker } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder, unwrapBuilderResult } from '../builder.js';
import { RerankedRetrieval } from '../retrieval/reranked-retrieval.js';
import {
  makeCapturingTracer,
  makeClassifier,
  makeLlm,
  makeRag,
  testCallOptions,
  testRequestAccess,
} from '../testing/index.js';

for (const configured of [false, true]) {
  for (const enabled of [undefined, false, true]) {
    for (const strategy of [false, true]) {
      test(`query expansion: configured=${configured}, enabled=${enabled}, strategy=${strategy}`, async () => {
        const original = 'знайди замовлення клієнтів';
        const translated = 'find customer orders';
        const expanded = `${translated} sales purchases`;
        const queries: string[] = [];
        const judgments: string[] = [];
        const expansions: string[] = [];
        const tracer = makeCapturingTracer();
        const base = makeRag([
          { text: 'orders', score: 1, metadata: { id: 'orders' } },
        ]);
        const rag: IRag = {
          ...base,
          query: async (query, k, options) => {
            queries.push(query.text);
            return base.query(query, k, options);
          },
        };
        const reranker: IReranker = {
          rerank: async (query, results) => {
            judgments.push(query);
            return { ok: true, value: results };
          },
        };
        const builder = new SmartAgentBuilder({ skipModelValidation: true })
          .withRagAccess(testRequestAccess)
          .withMainLlm(makeLlm([{ content: 'ok' }]))
          .withHelperLlm(makeLlm([{ content: translated }]))
          .withClassifier(makeClassifier([{ type: 'action', text: original }]))
          .withTracer(tracer)
          .withReranker(reranker)
          .setToolsRag(rag)
          .addRagCollection({
            name: 'docs',
            rag,
            meta: { displayName: 'Docs', scope: 'global' },
          });
        if (enabled !== undefined) builder.withQueryExpansion(enabled);
        if (configured) {
          builder.withQueryExpander({
            expand: async (query) => {
              expansions.push(query);
              return { ok: true, value: expanded };
            },
          });
        }
        if (strategy) {
          builder.withRetrievalStrategy(
            'tools',
            new RerankedRetrieval(reranker),
          );
          builder.withRetrievalStrategy(
            'docs',
            new RerankedRetrieval(reranker),
          );
        }
        const handle = unwrapBuilderResult(await builder.build());
        try {
          const result = await handle.agent.process(
            original,
            testCallOptions(),
          );
          assert.equal(result.ok, true);
          const expands = configured && enabled === true;
          assert.deepEqual(expansions, expands ? [translated] : []);
          assert.ok(queries.length >= 2);
          assert.ok(
            queries.every(
              (query) => query === (expands ? expanded : translated),
            ),
          );
          assert.ok(judgments.length >= 2);
          assert.ok(judgments.every((query) => query === translated));
          assert.ok(
            tracer.spans.some(
              (span) =>
                span.name === 'pipeline.translate' &&
                span.attributes.translated === true,
            ),
          );
          assert.equal(
            tracer.spans.some((span) => span.name === 'pipeline.expand'),
            expands,
          );
        } finally {
          await handle.close();
        }
      });
    }
  }
}
