import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RagResult } from '@mcp-abap-adt/llm-agent';
import {
  makeMetadataRag,
  ownedTestStores,
  testCallOptions,
  testRequestAccess,
} from '../../../testing/index.js';
import { ScoreThresholdToolSelection } from '../../tool-selection/index.js';
import { RagToolRetriever } from '../rag-tool-retriever.js';

const candidates = ['drop', 'keep'].map((name) => ({
  name,
  description: name,
  inputSchema: {},
}));
const request = { text: 'enriched query', candidates };
const records: RagResult[] = [
  { text: 'relevant', metadata: { id: 'tool:keep' }, score: 0.9 },
  { text: 'irrelevant', metadata: { id: 'tool:drop' }, score: 0.1 },
  { text: 'fact', metadata: { id: 'fact:other' }, score: 1 },
];

test('reuses staged results and applies the legacy strategy before matching names', async () => {
  const store = makeMetadataRag();
  const retriever = new RagToolRetriever({
    ragStores: ownedTestStores({ tools: store }),
    toolSelectionStrategy: new ScoreThresholdToolSelection(0.5),
  });
  const result = await retriever.retrieve({
    ...request,
    ragResults: { tools: records },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.names, ['keep']);
  assert.deepEqual(store.queryCalls, []);
});

test('queries all configured stores at the same k and logs fallback diagnostics', async () => {
  const tools = makeMetadataRag(records);
  const domain = makeMetadataRag();
  const ragResults: Record<string, RagResult[]> = {};
  const steps: Array<{ name: string; data: object }> = [];
  const retriever = new RagToolRetriever({
    ragAccess: testRequestAccess,
    ragStores: ownedTestStores({ tools, domain }),
    k: 7,
  });
  const result = await retriever.retrieve(
    { ...request, ragResults },
    testCallOptions({
      sessionLogger: {
        logStep(name, data) {
          if (data && typeof data === 'object') steps.push({ name, data });
        },
      },
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.names, ['drop', 'keep']);
  for (const store of [tools, domain]) {
    assert.deepEqual(store.queryCalls, [{ text: request.text, k: 7 }]);
  }
  assert.equal(ragResults.tools.length, 3);
  assert.deepEqual(steps, [
    {
      name: 'tool_select_rag_fallback',
      data: {
        reason: 'RAG retrieval was skipped, querying stores for tool discovery',
        query: request.text,
        k: 7,
        resultCount: 3,
        results: records.map((record) => ({
          id: record.metadata.id,
          score: record.score,
          text: record.text,
        })),
      },
    },
  ]);
});

test('hard mode offers the candidates when there are no RAG tool matches', async () => {
  const retriever = new RagToolRetriever({
    ragStores: {},
    hardMode: true,
  });
  const result = await retriever.retrieve({
    ...request,
    candidates: [candidates[1]],
    ragResults: { facts: [records[2]] },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.names, ['keep']);
});
