import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  IEmbedder,
  KnowledgeEntry,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  KnowledgeRag,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import { makeKnowledgeSemanticIndex } from '../../embedder-knowledge-index.js';
import { JsonlKnowledgeBackend } from '../../jsonl-knowledge-backend.js';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import { hydrateBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

/**
 * #243 REOPENED — reproduction of the LIVE control-failure → replan dead-end.
 *
 * `writeControlFailure` (controller-coordinator-handler.ts) writes a
 * `step-result` artifact with `content: ''`. On the live path the knowledge
 * backend is `JsonlKnowledgeBackend` wired with an embedder-backed semantic
 * index (`makeKnowledgeBackend` → `makeKnowledgeSemanticIndex(embedder)`,
 * see smart-server.ts `buildKnowledgeBackend`). A REAL embedder (e.g. SAP AI
 * Core) rejects empty text with an HTTP 400. This test wires that SAME
 * production chain — JsonlKnowledgeBackend + makeKnowledgeSemanticIndex +
 * an embedder fake that throws on empty/whitespace text — and drives the
 * exact control-failure → replan scenario used by
 * `controller-no-response.test.ts` "Symptom A". It asserts the CORRECT
 * behavior (a non-empty answer surfacing the captured tool error) which is
 * expected to FAIL on main.
 */

type Captured = Result<LlmStreamChunk, unknown>;

function fakeCtx(overrides: Partial<PipelineContext> = {}): {
  ctx: PipelineContext;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const requestLogger = new SessionRequestLogger();
  requestLogger.startRequest('sess-1');
  const ctx = {
    sessionId: 'sess-1',
    textOrMessages: 'do the thing',
    options: undefined,
    externalResults: undefined,
    requestLogger,
    yield: (c: Captured) => {
      captured.push(c);
    },
    ...overrides,
  } as unknown as PipelineContext;
  return { ctx, captured };
}

/** Subagent stub backed by a scripted queue; each send() shifts one result. */
function scriptedClient(queue: SubagentResult[]): ISubagentClient & {
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async send() {
      calls++;
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function baseConfig(
  over: Partial<ControllerConfig['budgets']> = {},
): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3, ...over },
  };
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

function surfacedContent(
  captured: ReturnType<typeof fakeCtx>['captured'],
): string | undefined {
  const c = captured.find(
    (x): x is { ok: true; value: { content: string } } =>
      x.ok === true &&
      typeof (x.value as { content?: unknown }).content === 'string',
  );
  return c?.value.content;
}

/** Embedder fake mirroring a REAL provider (e.g. SAP AI Core): rejects
 *  empty/whitespace text with an error resembling the live 400, embeds
 *  non-empty text fine. */
function makeEmptyRejectingEmbedder(): IEmbedder & { calls: KnowledgeEntry[] } {
  const calls: KnowledgeEntry[] = [];
  return {
    calls,
    async embed(text: string) {
      if (text.trim().length === 0) {
        throw new Error('400 Bad Request: The text content is empty');
      }
      return { vector: [1, 0, 0] };
    },
  };
}

describe('#243 REOPENED — control-failure write hits a real embedder-backed RAG', () => {
  let logDir: string;

  before(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'issue243-repro-'));
  });

  after(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it('Symptom A with a LIVE-shaped RAG (JsonlKnowledgeBackend + embedder-backed semantic index): control-failure(tool error) → replan → finalizer EMPTY must still surface the real tool error, never (no response)', async () => {
    const embedder = makeEmptyRejectingEmbedder();
    const semantic = makeKnowledgeSemanticIndex(embedder);
    const backend = new JsonlKnowledgeBackend(logDir, semantic);
    const rag = new KnowledgeRag(backend, 'sess-1');
    const mcpCalls: Array<{ name: string; args: unknown }> = [];

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([
        { kind: 'content', content: 'Goal: read a class, report errors' },
      ]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'read' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // replan → empty
        { kind: 'content', content: '' }, // finalizer → EMPTY (no progress)
      ]),
      executor: scriptedClient([toolCall('ReadClass', { name: 'ZZ_QX9B7' })]),
      backend,
      knowledgeRagFor: () => rag,
      embedder,
      callMcp: async (name, args) => {
        mcpCalls.push({ name, args });
        return { text: 'Class ZZ_QX9B7 not found', isError: true };
      },
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'ReadClass', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const { ctx, captured } = fakeCtx();

    let thrown: unknown;
    try {
      await new ControllerCoordinatorHandler(deps).execute(ctx, {}, undefined);
    } catch (e) {
      thrown = e;
    }

    // Diagnostic dump — captured in the phase-1 report regardless of outcome.
    // eslint-disable-next-line no-console
    console.log('captured chunks:', JSON.stringify(captured, null, 2));
    if (thrown) {
      // eslint-disable-next-line no-console
      console.log('execute() THREW:', thrown);
    }

    assert.equal(
      thrown,
      undefined,
      `execute() must not reject — the control-failure write must not crash the run (it did: ${String(
        thrown,
      )})`,
    );

    const body = surfacedContent(captured);
    assert.ok(
      body,
      'a body must have been surfaced (captured a content chunk)',
    );
    assert.notEqual(
      body.trim(),
      '',
      'never (no response) / GENERIC_NO_ANSWER — the empty-embed 400 must not swallow the captured tool error',
    );
    assert.match(
      body,
      /Class ZZ_QX9B7 not found/,
      `expected the captured tool error to surface; got: ${JSON.stringify(body)}`,
    );

    const bundle = await hydrateBundle(backend, 'sess-1');
    assert.ok(bundle.runId, 'a runId must have been minted');
  });
});
