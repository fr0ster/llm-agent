import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  KnowledgeEntryMetadata,
  KnowledgeFilter,
  ToolLoopContextStrategyFactory,
  ToolRound,
} from '@mcp-abap-adt/llm-agent';
import { toModelToolMessage } from '@mcp-abap-adt/llm-agent';
import {
  LegacyAccumulateContextStrategy,
  RagRecallContextStrategy,
} from '@mcp-abap-adt/llm-agent-libs';
import { ControllerFactory } from '../../factories/controller-factory.js';
import {
  buildRecallBlock,
  RECALL_MAX_CHARS_MCP,
} from '../../smart-agent/controller/recall.js';
import { createControllerRagRecallContextStrategyFactory } from '../controller.js';
import { controllerPlugin, fakeControllerServerCtx } from './fixtures.js';

// The selected factory is constructed inside ControllerPipelinePlugin.build and
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
    captured = deps.toolLoopContextStrategyFactory;
    return orig.call(this, cfg, deps, kind);
  };
  try {
    const inst = await controllerPlugin().build({
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
    },
    results: [
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: resultBody,
      },
    ],
    meta: [{ identityKey: 'tool:args', isError: false }],
  };
}

describe('controller context wiring — RagRecall factory', () => {
  it('injects a RagRecallContextStrategy whose record writes an mcp-result artifact with a roundId', async () => {
    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory:
        createControllerRagRecallContextStrategyFactory({
          maxSteps: 20,
          maxRetries: 3,
          maxRewinds: 3,
        }),
    });
    const writes: Array<{ content: string; metadata: KnowledgeEntryMetadata }> =
      [];
    const spyRag: IKnowledgeRagHandle = {
      write: async (entry: {
        content: string;
        metadata: KnowledgeEntryMetadata;
      }) => {
        writes.push(entry);
      },
      query: async () => [],
      list: async () => [],
      fingerprint: () => 'test',
    };

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

  it('recall matches buildRecallBlock byte for byte without toolTrust', async () => {
    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory:
        createControllerRagRecallContextStrategyFactory({
          maxSteps: 20,
          maxRetries: 3,
          maxRewinds: 3,
        }),
    });
    const cases = [
      [['a'.repeat(1000), 'b'.repeat(1000)]],
      [['a'.repeat(1000)], ['b'.repeat(1000)], ['c']],
      [
        ['', 'a', ''],
        ['b', '', 'c'],
      ],
      [[], [''], ['', '']],
      [['a'.repeat(1999), 'b']],
      [['a'.repeat(2000)], ['b']],
      [['a'.repeat(2001)], ['b']],
      [],
    ];
    for (const rounds of cases) {
      const hits: KnowledgeEntry[] = rounds.map((contents, index) => ({
        content: contents.join('\n'),
        metadata: {
          ...META,
          artifactType: 'mcp-result',
          roundId: `prior-${index}`,
          identityKey: `prior-${index}`,
          toolResults: contents.map((content, toolIndex) => ({
            toolName: `T${toolIndex}`,
            content,
          })),
        },
      }));
      const strategy = factory({
        run: {
          rag: {
            write: async () => {},
            query: async () => hits,
            list: async () => [],
            fingerprint: () => 'regression',
          } satisfies IKnowledgeRagHandle,
          runId: 'regression',
          meta: META,
          stepName: 's',
        },
      });
      await strategy.record(aRound('TAIL'));
      const messages = await strategy.form({ prefix: [] });
      const expected = buildRecallBlock(hits, RECALL_MAX_CHARS_MCP);
      assert.equal(
        messages.find((message) => message.role === 'user')?.content,
        expected,
      );
      if (rounds === cases[0]) {
        assert.equal(
          expected,
          `Relevant prior context:\n${'a'.repeat(1000)}\n${'b'.repeat(999)}`,
        );
        const toolTrust = (name: string) => ({
          source: `system:${name}`,
          trust: 4.5,
        });
        const trusted = await strategy.form({ prefix: [], toolTrust });
        const projected = ['a'.repeat(1000), 'b'.repeat(999)].map(
          (content, index) =>
            toModelToolMessage(
              { role: 'tool', content },
              toolTrust,
              `T${index}`,
            ).content,
        );
        assert.equal(
          trusted[0].content,
          `Relevant prior context:\n${projected.join('\n')}`,
        );
        assert.equal(String(trusted[0].content).match(/\[source:/g)?.length, 2);
      }
    }
  });

  it('record stamps the mcp-result artifact with writeOrdinal from round.ordinal (latest-fetch dedup)', async () => {
    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory:
        createControllerRagRecallContextStrategyFactory({
          maxSteps: 20,
          maxRetries: 3,
          maxRewinds: 3,
        }),
    });
    const writes: Array<{ content: string; metadata: KnowledgeEntryMetadata }> =
      [];
    const spyRag: IKnowledgeRagHandle = {
      write: async (entry: {
        content: string;
        metadata: KnowledgeEntryMetadata;
      }) => {
        writes.push(entry);
      },
      query: async () => [],
      list: async () => [],
      fingerprint: () => 'test',
    };

    const strategy = factory({
      run: { rag: spyRag, runId: 'run-o', meta: META, stepName: 'step-o' },
    });

    // The handler stamps a monotonic per-write ordinal onto the round; the record
    // closure MUST carry it to metadata.writeOrdinal so isBetterMcp can tie-break a
    // same-identityKey / same-createdAt re-fetch to the LATEST write (not a stale one).
    const round = { ...aRound('BODY'), ordinal: 7 };
    await strategy.record(round);

    assert.equal(writes.length, 1);
    assert.equal(
      writes[0].metadata.writeOrdinal,
      7,
      'writeOrdinal must be stamped from round.ordinal',
    );
  });

  it('recall (via form) runs runScopedRecall over [mcp-result] excluding the last roundId', async () => {
    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory:
        createControllerRagRecallContextStrategyFactory({
          maxSteps: 20,
          maxRetries: 3,
          maxRewinds: 3,
        }),
    });
    const queries: Array<{
      text: string;
      opts: { k?: number; filter?: KnowledgeFilter };
    }> = [];
    let recordedRoundId = '';
    const spyRag: IKnowledgeRagHandle = {
      write: async () => {},
      query: async (text, opts) => {
        queries.push({ text, opts: opts ?? {} });
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
        ];
      },
      list: async () => [],
      fingerprint: () => 'test',
    };

    const strategy = factory({
      run: { rag: spyRag, runId: 'run-y', meta: META, stepName: 's' },
    });
    const round = aRound('TAIL-BODY');
    await strategy.record(round);
    assert.ok(round.roundId);
    recordedRoundId = round.roundId;

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
  it('with NO ctx.toolLoopContextStrategyFactory the controller preserves all six full rounds by default', async () => {
    const factory = await buildAndCaptureFactory();
    const spyRag: IKnowledgeRagHandle = {
      write: async () => {},
      query: async () => [],
      list: async () => [],
      fingerprint: () => 'test',
    };
    const strategy = factory({
      run: { rag: spyRag, runId: 'r', meta: META, stepName: 's' },
    });
    assert.ok(
      strategy instanceof LegacyAccumulateContextStrategy,
      'default controller strategy must preserve full history',
    );
    const rounds: ToolRound[] = Array.from({ length: 6 }, (_, index) => ({
      assistant: {
        role: 'assistant',
        content: `ASSISTANT-${index + 1}`,
        tool_calls: [
          {
            id: `call-${index + 1}`,
            type: 'function',
            function: {
              name: 'Work',
              arguments: JSON.stringify({ round: index + 1 }),
            },
          },
        ],
      },
      results: [
        {
          role: 'tool',
          tool_call_id: `call-${index + 1}`,
          content: `RESULT-${index + 1}`,
        },
      ],
    }));
    for (const round of rounds) await strategy.record(round);
    assert.deepEqual(
      await strategy.form({ prefix: [{ role: 'user', content: 'go' }] }),
      [
        { role: 'user', content: 'go' },
        ...rounds.flatMap((round) => [round.assistant, ...round.results]),
      ],
    );
  });

  it('honors a consumer-injected ctx.toolLoopContextStrategyFactory (overrides full history)', async () => {
    // The identity assertion proves that the consumer factory takes precedence
    // over the full-history default.
    const sentinel = {
      form: async () => [],
      record: async () => {},
      snapshot: () => ({ version: 1 }),
      restore: () => {},
    };
    let injectedCalled = false;
    const consumerFactory: ToolLoopContextStrategyFactory = () => {
      injectedCalled = true;
      return sentinel;
    };

    const factory = await buildAndCaptureFactory({
      toolLoopContextStrategyFactory: consumerFactory,
    });

    // The factory the controller handed to ControllerFactory must be the
    // consumer's, verbatim — not the controller's RagRecall factory.
    assert.strictEqual(
      factory,
      consumerFactory,
      'controller must thread the consumer-injected factory',
    );
    const spyRag: IKnowledgeRagHandle = {
      write: async () => {},
      query: async () => [],
      list: async () => [],
      fingerprint: () => 'test',
    };
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
