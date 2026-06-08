import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryEmbedding } from '@mcp-abap-adt/llm-agent';
import {
  SessionRequestLogger,
  wrapEmbedder,
} from '@mcp-abap-adt/llm-agent-libs';

test('QueryEmbedding(text, wrappedEmbedder, options) logs one embedding entry', async () => {
  const logger = new SessionRequestLogger();
  logger.startRequest('r1');
  const stub = {
    embed: async () => ({
      vector: [1],
      usage: { promptTokens: 4, totalTokens: 4 },
    }),
  };
  const qe = new QueryEmbedding('hi', wrapEmbedder(stub), {
    trace: { traceId: 'r1' },
    requestLogger: logger,
  } as never);
  await qe.toVector();
  assert.equal(logger.getSummary('r1').byComponent.embedding?.totalTokens, 4);
});
