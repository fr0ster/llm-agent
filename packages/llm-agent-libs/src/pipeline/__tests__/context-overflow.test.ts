import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  EMBEDDING_CONTEXT_EXCEEDED,
  type ISkill,
  type ISkillManager,
  McpError,
  MODEL_CONTEXT_EXCEEDED,
  RagError,
} from '@mcp-abap-adt/llm-agent';
import {
  makeDefaultDeps,
  makeMcpClient,
  makeRag,
  testCallOptions,
} from '../../testing/index.js';
import { DefaultPipeline } from '../default-pipeline.js';
import { PipelineExecutor } from '../executor.js';
import type { StageHandlerRegistry } from '../handlers/index.js';
import { pipelineToStream } from '../pipeline-to-stream.js';

const overflow = new RagError('Prompt too long', MODEL_CONTEXT_EXCEEDED);
const doc = { text: 'a skill', metadata: { id: 'skill:example' }, score: 1 };
const skill: ISkill = {
  name: 'example',
  description: 'Example',
  meta: { name: 'example', description: 'Example' },
  async getContent() {
    return { ok: true, value: 'instructions' };
  },
  async listResources() {
    return { ok: true, value: [] };
  },
  async readResource() {
    return { ok: true, value: '' };
  },
};
const skillManager: ISkillManager = {
  async listSkills() {
    return { ok: true, value: [skill] };
  },
  async matchSkills() {
    return { ok: true, value: [skill] };
  },
  async getSkill() {
    return { ok: true, value: skill };
  },
};

for (const phase of ['skill fallback', 'tool fallback', 'parallel retrieval']) {
  for (const ordinaryRejects of [false, true]) {
    test(`pipeline ${phase} prioritizes overflow over ordinary ${ordinaryRejects ? 'rejection' : 'result'}`, async () => {
      const ordinary = new McpError(
        'Store lookup unavailable',
        'MCP_NOT_CONNECTED',
      );
      const first = makeRag([]);
      const second = makeRag([]);
      let firstCalls = 0;
      let secondCalls = 0;
      const fallback = phase !== 'parallel retrieval';
      first.query = async () => {
        if (++firstCalls === 1 && fallback) return { ok: true, value: [] };
        if (ordinaryRejects) throw ordinary;
        return { ok: false, error: ordinary };
      };
      second.query = async () => {
        if (++secondCalls === 1 && fallback) return { ok: true, value: [] };
        await Promise.resolve();
        return { ok: false, error: overflow };
      };
      const tool = { name: 'read', description: '', inputSchema: {} };
      const { deps, llm } = makeDefaultDeps({
        ragStores: { first, second },
        mcpClients: [makeMcpClient([tool])],
      });
      const pipeline = new DefaultPipeline();
      pipeline.initialize({
        ...deps,
        skillManager: phase === 'skill fallback' ? skillManager : undefined,
      });
      const errors: Error[] = [];
      const result = await pipeline.execute(
        'work',
        [],
        testCallOptions(),
        (chunk) => {
          if (!chunk.ok) errors.push(chunk.error);
        },
      );
      assert.equal(result.error, overflow);
      if (phase === 'parallel retrieval')
        assert.deepEqual(
          errors,
          ordinaryRejects ? [ordinary, overflow] : [overflow],
        );
      assert.equal(llm.callCount, 0);
    });
  }
}

test('parallel stages forward an ordinary error before a later content chunk', async () => {
  const ordinary = new RagError('Aborted', 'ABORTED');
  const release = Promise.withResolvers<void>();
  const events: (Error | string)[] = [];
  const handlers: StageHandlerRegistry = new Map([
    [
      'classify',
      {
        async execute(ctx) {
          await Promise.resolve();
          ctx.error = ordinary;
          ctx.yield({ ok: false, error: ordinary });
          return false;
        },
      },
    ],
    [
      'translate',
      {
        async execute(ctx) {
          await release.promise;
          ctx.yield({ ok: true, value: { content: 'content' } });
          return true;
        },
      },
    ],
  ]);
  const pipeline = new DefaultPipeline({
    stepperCoordinator: {
      execute(ctx) {
        return new PipelineExecutor(handlers, ctx.tracer).executeStages(
          [
            {
              type: 'parallel',
              id: 'parallel',
              stages: [
                { type: 'classify', id: 'error' },
                { type: 'translate', id: 'content' },
              ],
            },
          ],
          ctx,
          ctx.tracer.startSpan('parallel-test'),
        );
      },
    },
  });
  pipeline.initialize(makeDefaultDeps().deps);
  const execution = pipeline.execute('work', [], testCallOptions(), (chunk) => {
    if (!chunk.ok) events.push(chunk.error);
    else if (chunk.value.content) events.push(chunk.value.content);
  });
  try {
    await setImmediate();
    assert.deepEqual(events, [ordinary]);
  } finally {
    release.resolve();
  }
  assert.equal((await execution).error, ordinary);
  assert.deepEqual(events, [ordinary, 'content']);
});

for (const operation of ['list', 'content']) {
  test(`pipeline propagates overflow from skill ${operation}`, async () => {
    const manager: ISkillManager = {
      ...skillManager,
      async listSkills() {
        if (operation === 'list') return { ok: false, error: overflow };
        return {
          ok: true,
          value: [
            {
              ...skill,
              async getContent() {
                return { ok: false, error: overflow };
              },
            },
          ],
        };
      },
    };
    const { deps, llm } = makeDefaultDeps({
      ragStores: { skills: makeRag([doc]) },
    });
    const pipeline = new DefaultPipeline();
    pipeline.initialize({ ...deps, skillManager: manager });
    const result = await pipeline.execute(
      'work',
      [],
      testCallOptions(),
      () => {},
    );
    assert.equal(result.error, overflow);
    assert.equal(llm.callCount, 0);
  });
}

test('pipeline reranking prioritizes a returned overflow over a sibling rejection', async () => {
  const { deps, llm } = makeDefaultDeps({
    ragStores: {
      first: makeRag([{ ...doc, text: 'ordinary' }]),
      second: makeRag([doc]),
    },
    reranker: {
      async rerank(_query, results) {
        if (results[0].text === 'ordinary')
          throw new Error('Reranker unavailable');
        return { ok: false, error: overflow };
      },
    },
  });
  const pipeline = new DefaultPipeline();
  pipeline.initialize(deps);
  const result = await pipeline.execute(
    'work',
    [],
    testCallOptions(),
    () => {},
  );
  assert.equal(result.error, overflow);
  assert.equal(llm.callCount, 0);
});

test('pipeline assembly preserves a wrapped context overflow', async () => {
  const { deps, llm } = makeDefaultDeps({
    assembler: {
      async assemble() {
        return {
          ok: false,
          error: Object.assign(new RagError('Assembly failed'), {
            cause: overflow,
          }),
        };
      },
    },
  });
  const pipeline = new DefaultPipeline();
  pipeline.initialize(deps);
  const result = await pipeline.execute(
    'work',
    [],
    testCallOptions(),
    () => {},
  );
  assert.equal(result.error, overflow);
  assert.equal(llm.callCount, 0);
});

test('pipeline tool selection surfaces a listing overflow beside a healthy client', async () => {
  const client = makeMcpClient([]);
  client.listTools = async () => ({ ok: false, error: overflow });
  const { deps, llm } = makeDefaultDeps({
    mcpClients: [
      makeMcpClient([{ name: 'read', description: '', inputSchema: {} }]),
      client,
    ],
  });
  const pipeline = new DefaultPipeline();
  pipeline.initialize(deps);
  const result = await pipeline.execute(
    'work',
    [],
    testCallOptions(),
    () => {},
  );
  assert.equal(result.error, overflow);
  assert.equal(llm.callCount, 0);
});

for (const throws of [false, true]) {
  test(`pipeline surfaces one typed stage failure (throws=${throws})`, async () => {
    const cause = new Error('Stage offline');
    const pipeline = new DefaultPipeline({
      stepperCoordinator: {
        async execute() {
          if (throws) throw cause;
          return false;
        },
      },
    });
    const { deps, llm } = makeDefaultDeps();
    pipeline.initialize(deps);
    const chunks = await Array.fromAsync(
      pipelineToStream(pipeline, 'work', [], testCallOptions()),
    );
    const failures = chunks.filter((chunk) => !chunk.ok);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.error.code, 'PIPELINE_STAGE_FAILED');
    if (throws) assert.equal(failures[0]?.error.cause, cause);
    else assert.match(failures[0]?.error.message ?? '', /coordinator/);
    assert.equal(llm.callCount, 0);
  });
}

test('pipeline reports ABORTED when the pre-aborted signal has a coded reason', async () => {
  const pipeline = new DefaultPipeline();
  const { deps, llm } = makeDefaultDeps();
  pipeline.initialize(deps);
  const signal = AbortSignal.abort(
    new RagError('Cancelled', MODEL_CONTEXT_EXCEEDED),
  );
  const chunks = await Array.fromAsync(
    pipelineToStream(pipeline, 'work', [], testCallOptions({ signal })),
  );
  const failures = chunks.filter((chunk) => !chunk.ok);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.error.code, 'ABORTED');
  assert.equal(failures[0]?.error.message, 'Cancelled');
  assert.equal(llm.callCount, 0);
});

for (const outcome of [
  'throw',
  'throw the abort reason',
  'return false',
  'return false with an error',
]) {
  test(`pipeline reports ABORTED when an aborted stage will ${outcome}`, async () => {
    const abort = new AbortController();
    const pipeline = new DefaultPipeline({
      stepperCoordinator: {
        async execute(ctx) {
          abort.abort(
            new RagError(
              'Cancelled',
              outcome === 'throw the abort reason'
                ? MODEL_CONTEXT_EXCEEDED
                : 'CONFIG_ERROR',
            ),
          );
          if (outcome === 'throw') throw new Error('Stage offline');
          if (outcome === 'throw the abort reason')
            abort.signal.throwIfAborted();
          if (outcome === 'return false with an error')
            ctx.error = new RagError('Stage offline', 'LLM_HTTP_ERROR');
          return false;
        },
      },
    });
    const { deps, llm } = makeDefaultDeps();
    pipeline.initialize(deps);
    const chunks = await Array.fromAsync(
      pipelineToStream(
        pipeline,
        'work',
        [],
        testCallOptions({ signal: abort.signal }),
      ),
    );
    const failures = chunks.filter((chunk) => !chunk.ok);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.error.code, 'ABORTED');
    assert.equal(llm.callCount, 0);
  });
}

for (const code of [MODEL_CONTEXT_EXCEEDED, EMBEDDING_CONTEXT_EXCEEDED]) {
  for (const throws of [false, true]) {
    test(`pipeline prioritizes ${code} over abort (throws=${throws})`, async () => {
      const abort = new AbortController();
      const failure = new RagError('Input exceeds context', code);
      const pipeline = new DefaultPipeline({
        stepperCoordinator: {
          async execute(ctx) {
            abort.abort(new RagError('Cancelled', 'CONFIG_ERROR'));
            if (throws) throw new Error('Stage failed', { cause: failure });
            ctx.error = new RagError('Stage failed', 'QUERY_ERROR', {
              cause: failure,
            });
            return false;
          },
        },
      });
      pipeline.initialize(makeDefaultDeps().deps);
      const chunks = await Array.fromAsync(
        pipelineToStream(
          pipeline,
          'work',
          [],
          testCallOptions({ signal: abort.signal }),
        ),
      );
      assert.deepEqual(
        chunks.filter((chunk) => !chunk.ok),
        [{ ok: false, error: failure }],
      );
    });
  }
}
