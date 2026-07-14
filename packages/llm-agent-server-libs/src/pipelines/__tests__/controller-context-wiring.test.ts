import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  ToolLoopContextStrategyFactory,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { RagRecallContextStrategy } from '@mcp-abap-adt/llm-agent-libs';
import { ControllerFactory } from '../../factories/controller-factory.js';
import { ControllerPipelinePlugin } from '../controller.js';
import { fakeControllerServerCtx } from './fixtures.js';

// The RagRecall factory is constructed inside ControllerPipelinePlugin.build and
// handed to the ControllerFactory (→ handler) as `deps.toolLoopContextStrategyFactory`.
// Spy on ControllerFactory.prototype.build to capture it (the shared ESM class ref
// is the same instance the plugin news up).
async function buildAndCaptureFactory(
  ctxOverride?: Partial<
    import('../server-context.js').IControllerServerPipelineContext
  >,
): Promise<ToolLoopContextStrategyFactory> {
  const orig = ControllerFactory.prototype.build;
  let captured: ToolLoopContextStrategyFactory | undefined;
  ControllerFactory.prototype.build = async function (cfg, deps, kind) {
    captured = (
      deps as {
        toolLoopContextStrategyFactory?: ToolLoopContextStrategyFactory;
      }
    ).toolLoopContextStrategyFactory;
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
      'controller did not inject a toolLoopContextStrategyFactory into ControllerFactory deps',
    );
  }
  return captured;
}

const META: KnowledgeEntryMetadata = {
  traceId: 't',
  turnId: 't',
  stepperId: 'controller',
  task: 'controller',
  artifactType: 'step-result',
  createdAt: 'now',
};

function aRound(resultBody: string): ToolRound {
  return {
    assistant: {
      role: 'assistant',
      content: null,
      tool_calls: [],
    } as unknown as ToolRound['assistant'],
    results: [
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: resultBody,
      } as unknown as ToolRound['results'][number],
    ],
    meta: [{ identityKey: 'tool:args', isError: false }],
  };
}

describe('controller context wiring — RagRecall factory', () => {
  it('injects a RagRecallContextStrategy whose record writes an mcp-result artifact with a roundId', async () => {
    const factory = await buildAndCaptureFactory();
    const writes: Array<{ content: string; metadata: KnowledgeEntryMetadata }> =
      [];
    const spyRag = {
      write: async (entry: {
        content: string;
        metadata: KnowledgeEntryMetadata;
      }) => {
        writes.push(entry);
      },
      query: async () => [] as KnowledgeEntry[],
    } as unknown as IKnowledgeRagHandle;

    const strategy = factory({
      run: { rag: spyRag, runId: 'run-x', meta: META, stepName: 'step-1' },
    });
    assert.ok(strategy instanceof RagRecallContextStrategy);

    const round = aRound('RESULT-BODY');
    await strategy.record(round);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].metadata.artifactType, 'mcp-result');
    assert.equal(writes[0].metadata.task, 'step-1');
    assert.equal(writes[0].metadata.runId, 'run-x');
    assert.equal(writes[0].metadata.identityKey, 'tool:args');
    // roundId is minted by the strategy before record() and MUST be its own field.
    assert.ok(writes[0].metadata.roundId);
    assert.equal(writes[0].metadata.roundId, round.roundId);
    assert.match(writes[0].content, /RESULT-BODY/);
  });

  it('recall (via form) runs runScopedRecall over [mcp-result] excluding the last roundId', async () => {
    const factory = await buildAndCaptureFactory();
    const queries: Array<{
      text: string;
      opts: { k?: number; filter?: { runId?: string; artifactType?: unknown } };
    }> = [];
    let recordedRoundId = '';
    const spyRag = {
      write: async () => {},
      query: async (
        text: string,
        opts: {
          k?: number;
          filter?: { runId?: string; artifactType?: unknown };
        },
      ) => {
        queries.push({ text, opts });
        return [
          {
            content: 'EXCLUDED',
            metadata: {
              ...META,
              artifactType: 'mcp-result',
              roundId: recordedRoundId,
              identityKey: 'k1',
            },
          },
          {
            content: 'KEPT',
            metadata: {
              ...META,
              artifactType: 'mcp-result',
              roundId: 'other-round',
              identityKey: 'k2',
            },
          },
        ] as unknown as KnowledgeEntry[];
      },
    } as unknown as IKnowledgeRagHandle;

    const strategy = factory({
      run: { rag: spyRag, runId: 'run-y', meta: META, stepName: 's' },
    });
    const round = aRound('TAIL-BODY');
    await strategy.record(round);
    recordedRoundId = round.roundId as string;

    const msgs = await strategy.form({ prefix: [], queryText: 'find X' });

    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0].opts.filter?.artifactType, ['mcp-result']);
    assert.equal(queries[0].opts.filter?.runId, 'run-y');

    const block = msgs.map((m) => String(m.content ?? '')).join('\n');
    assert.match(block, /KEPT/);
    assert.doesNotMatch(block, /EXCLUDED/);
    // the raw tail (last round) is still injected verbatim
    assert.match(block, /TAIL-BODY/);
  });
});

describe('controller context wiring — consumer override (DI seam)', () => {
  it('with NO ctx.toolLoopContextStrategyFactory the controller uses its RagRecall default', async () => {
    const factory = await buildAndCaptureFactory();
    const spyRag = {
      write: async () => {},
      query: async () => [] as KnowledgeEntry[],
    } as unknown as IKnowledgeRagHandle;
    const strategy = factory({
      run: { rag: spyRag, runId: 'r', meta: META, stepName: 's' },
    });
    assert.ok(
      strategy instanceof RagRecallContextStrategy,
      'default controller strategy must be RagRecall',
    );
  });

  it('honors a consumer-injected ctx.toolLoopContextStrategyFactory (overrides RagRecall)', async () => {
    // Sentinel strategy produced by the consumer's factory. It is NOT a
    // RagRecallContextStrategy, so if the controller wins with its own default
    // the identity assertion below fails.
    const sentinel = { form: async () => [], record: async () => {} };
    let injectedCalled = false;
    const consumerFactory: ToolLoopContextStrategyFactory = () => {
      injectedCalled = true;
      return sentinel as never;
    };

    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory: consumerFactory,
    });

    // The factory the controller handed to ControllerFactory must be the
    // consumer's, verbatim — not the controller's RagRecall factory.
    assert.strictEqual(
      factory,
      consumerFactory,
      'controller must thread the consumer-injected factory, not its own RagRecall',
    );
    const spyRag = {
      write: async () => {},
      query: async () => [] as KnowledgeEntry[],
    } as unknown as IKnowledgeRagHandle;
    const strategy = factory({
      run: { rag: spyRag, runId: 'r', meta: META, stepName: 's' },
    });
    assert.equal(injectedCalled, true, 'consumer factory must be invoked');
    assert.strictEqual(strategy, sentinel);
    assert.ok(
      !(strategy instanceof RagRecallContextStrategy),
      'consumer strategy must NOT be RagRecall',
    );
  });
});
