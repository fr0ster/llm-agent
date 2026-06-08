import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  IEmbedder,
  IEmbedderBatch,
  LlmCallEntry,
} from '@mcp-abap-adt/llm-agent';
import { isBatchEmbedder } from '@mcp-abap-adt/llm-agent';
import { wrapEmbedder } from '../usage-logging-embedder.js';

function makeLogger() {
  const entries: LlmCallEntry[] = [];
  return {
    entries,
    logLlmCall: (e: LlmCallEntry) => entries.push(e),
    logRagQuery() {},
    logToolCall() {},
    startRequest() {},
    endRequest() {},
    dropRequest() {},
    getSummary() {
      return {} as never;
    },
    reset() {},
  };
}
const opts = (logger: ReturnType<typeof makeLogger>) =>
  ({ trace: { traceId: 'r1' }, requestLogger: logger }) as never;

test('logs provider-reported usage verbatim', async () => {
  const logger = makeLogger();
  const inner: IEmbedder = {
    embed: async () => ({
      vector: [1],
      usage: { promptTokens: 5, totalTokens: 5 },
    }),
  };
  await wrapEmbedder(inner).embed('hi', opts(logger));
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].component, 'embedding');
  assert.equal(logger.entries[0].model, 'embedder');
  assert.equal(logger.entries[0].scope, 'request');
  assert.equal(logger.entries[0].totalTokens, 5);
  assert.notEqual(logger.entries[0].estimated, true);
});

test('estimates when provider returns no usage', async () => {
  const logger = makeLogger();
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  await wrapEmbedder(inner).embed('12345678', opts(logger)); // len 8 -> ceil(8/4)=2
  assert.equal(logger.entries[0].estimated, true);
  assert.equal(logger.entries[0].totalTokens, 2);
});

test('no requestLogger -> no log (startup vectorization)', async () => {
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  const r = await wrapEmbedder(inner).embed('hi', {
    trace: { traceId: 'r1' },
  } as never);
  assert.deepEqual(r.vector, [1]);
});

test('idempotent: re-wrapping returns the same instance', () => {
  const inner: IEmbedder = { embed: async () => ({ vector: [1] }) };
  const w = wrapEmbedder(inner);
  assert.equal(wrapEmbedder(w), w);
});

test('preserves IEmbedderBatch and logs summed batch usage', async () => {
  const logger = makeLogger();
  let batchCalls = 0;
  const inner: IEmbedderBatch = {
    embed: async () => ({
      vector: [1],
      usage: { promptTokens: 5, totalTokens: 5 },
    }),
    embedBatch: async (texts) => {
      batchCalls++;
      return texts.map(() => ({
        vector: [1],
        usage: { promptTokens: 3, totalTokens: 3 },
      }));
    },
  };
  const w = wrapEmbedder(inner);
  assert.equal(isBatchEmbedder(w), true);
  await (w as IEmbedderBatch).embedBatch(['a', 'b'], opts(logger));
  assert.equal(batchCalls, 1);
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].totalTokens, 6);
  assert.notEqual(logger.entries[0].estimated, true);
});

test('mixed batch (some measured, some not) is flagged estimated', async () => {
  const logger = makeLogger();
  const inner: IEmbedderBatch = {
    embed: async () => ({ vector: [1] }),
    embedBatch: async () => [
      { vector: [1], usage: { promptTokens: 3, totalTokens: 3 } }, // measured
      { vector: [1] }, // no usage → estimated
    ],
  };
  await (wrapEmbedder(inner) as IEmbedderBatch).embedBatch(
    ['aaaa', 'bbbbbbbb'], // ceil(8/4)=2 for the estimated one
    opts(logger),
  );
  assert.equal(logger.entries[0].estimated, true);
  assert.equal(logger.entries[0].totalTokens, 5); // 3 measured + 2 estimated
});
