import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IKnowledgeRagHandle,
  KnowledgeEntry,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import {
  InMemoryKnowledgeBackend,
  SessionRequestLogger,
} from '@mcp-abap-adt/llm-agent-libs';
import {
  ControllerCoordinatorHandler,
  type ControllerHandlerDeps,
} from '../controller-coordinator-handler.js';
import type { ApprovedResult, IFinalizer } from '../finalizer.js';
import { readTerminal } from '../run-scope.js';
import { hydrateBundle } from '../session-bundle.js';
import type { ISubagentClient } from '../subagent-client.js';
import type { ControllerConfig, SubagentResult } from '../types.js';

/**
 * #264 — on a tool-level failure the finalizer composes from an EMPTY
 * approved-set and never receives the captured tool error, so a non-empty
 * finalizer answer silently DROPS the real error.
 *
 * Spun off from #243. The #243 dead-end (`control-failure → replan →
 * (no response)`) is fixed. Its Layer-2 guard (`commitTerminalSuccess` →
 * `capturedFailureText`) fires ONLY when the finalizer returns an EMPTY body —
 * which is exactly what every existing Symptom A/B test scripts
 * (`finalizer: ''`). A REAL LLM finalizer, handed no evidence, does not return
 * '' — it fills the void with a confident refusal ("no SAP connection / no
 * error message"), which is non-empty, so the guard never fires and the
 * captured `Class ZZ_QX9B7 not found` is discarded. That is the live defect the
 * in-memory suite misses.
 *
 * finalize() (controller-coordinator-handler.ts) calls
 * `deps.finalizer.finalize(goal, request, approved, opts)` with `approved` =
 * `collectApproved(rag, runId)` (empty for a failed step) and NEVER passes
 * `capturedFailureText(bundle)`. This test drives the exact Symptom A scenario
 * with a faithful finalizer (composes from `approved`; given none, still
 * returns a non-empty answer) and asserts the CORRECT behavior — the captured
 * tool error reaches the user — which is expected to FAIL on main.
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
    textOrMessages: 'read a class and report any error',
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
function scriptedClient(queue: SubagentResult[]): ISubagentClient {
  return {
    async send() {
      const next = queue.shift();
      if (!next) return { kind: 'content', content: '' };
      return next;
    },
  };
}

function stubRag(): IKnowledgeRagHandle & { written: KnowledgeEntry[] } {
  const written: KnowledgeEntry[] = [];
  return {
    written,
    query: async () => [],
    async list() {
      return [];
    },
    async write(entry) {
      written.push(entry);
    },
    fingerprint() {
      return 'stub';
    },
  };
}

const stubEmbedder = {
  embed: async () => ({ vector: [1, 0, 0] }),
} as never;

function baseConfig(): ControllerConfig {
  return {
    subagents: {} as never,
    targetState: { strategy: 'semantic-distance', distanceThreshold: 0.9 },
    sessionMemory: { collection: 'controller' },
    budgets: { maxSteps: 10, maxRetries: 2, maxRewinds: 3 },
  };
}

const toolCall = (
  name: string,
  args: Record<string, unknown>,
): SubagentResult => ({
  kind: 'tool_call',
  toolCalls: [{ id: 'c1', name, arguments: args }],
});

function surfacedContent(captured: Captured[]): string | undefined {
  const c = captured.find(
    (x): x is { ok: true; value: { content: string } } =>
      x.ok === true &&
      typeof (x.value as { content?: unknown }).content === 'string',
  );
  return c?.value.content;
}

/**
 * A faithful finalizer: it relays whatever evidence it is given. Given an empty
 * approved-set it still returns a NON-EMPTY answer (a real LLM never returns '')
 * that — crucially — does NOT mention the failure, mirroring the live
 * "no SAP connection / no error message" hallucination. Records the approved-set
 * it was handed so the test can show the root cause.
 */
function faithfulFinalizer(): IFinalizer & {
  approvedSeen: ReadonlyArray<readonly ApprovedResult[]>;
} {
  const approvedSeen: Array<readonly ApprovedResult[]> = [];
  return {
    get approvedSeen() {
      return approvedSeen;
    },
    async finalize(_goal, _request, approved) {
      approvedSeen.push(approved);
      const evidence = approved
        .map((a) => a.content)
        .join('\n')
        .trim();
      return evidence.length > 0
        ? evidence
        : 'I could not retrieve the class in this session; no SAP error message is available.';
    },
  };
}

describe('#264 — tool-error failure drops the captured error when the finalizer answer is non-empty', () => {
  it('a non-empty finalizer answer must still surface the captured tool error (currently dropped)', async () => {
    const rag = stubRag();
    const backend = new InMemoryKnowledgeBackend();
    const finalizer = faithfulFinalizer();

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([
        { kind: 'content', content: 'Goal: read a class, report errors' },
      ]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'read the class' }],
          }),
        },
        // control-failure(tool error) → replan → empty plan → done → finalize.
        { kind: 'content', content: JSON.stringify({ plan: [] }) },
      ]),
      executor: scriptedClient([toolCall('ReadClass', { name: 'ZZ_QX9B7' })]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({
        text: 'Class ZZ_QX9B7 not found',
        isError: true,
      }),
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'ReadClass', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      finalizer,
      models: {
        evaluator: 'm-eval',
        planner: 'm-plan',
        executor: 'm-exec',
        finalizer: 'm-final',
      },
    };

    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);

    // The #243 dead-end is already fixed: a body is always surfaced, never empty.
    assert.ok(body, 'a body must have been surfaced');
    assert.notEqual(body.trim(), '', 'never (no response)');

    // #264: the tool WAS called and returned a real error; the user asked for it.
    // It must reach the user — regardless of whether the fix feeds the captured
    // error into the finalizer's evidence or the planner routes it via `error`.
    assert.match(
      body,
      /Class ZZ_QX9B7 not found/,
      `#264: the captured tool error must reach the user, but it was dropped. ` +
        `Delivered body: ${JSON.stringify(body)}. ` +
        `The finalizer was handed this approved-set (empty ⇒ it never saw the error): ` +
        `${JSON.stringify(finalizer.approvedSeen)}`,
    );

    // Hardening: the captured error is surfaced DIRECTLY — the finalizer, which
    // would compose from nothing and fabricate a "no error" answer, is never
    // invoked (no evidence to compose from ⇒ short-circuit before it runs).
    assert.equal(
      finalizer.approvedSeen.length,
      0,
      'the finalizer must not be invoked when the captured error is surfaced directly',
    );

    // The run ends on a durable ERROR terminal carrying the captured text (so a
    // resume/replay returns the same real error, never a success hallucination).
    const bundle = await hydrateBundle(backend, 'sess-1');
    const term = await readTerminal(
      backend,
      'sess-1',
      // biome-ignore lint/style/noNonNullAssertion: runId set after execute
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'error');
    assert.match(
      (term as { error?: string } | undefined)?.error ?? '',
      /Class ZZ_QX9B7 not found/,
    );
  });

  it('CONTRAST (passes today): the ONLY reason the existing Symptom A test is green is the finalizer returning empty — the same run with a non-empty answer is the gap above', async () => {
    // Same wiring, but the finalizer returns EMPTY (as every existing Symptom A/B
    // test scripts). Then the #243 Layer-2 guard fires and the captured tool
    // error surfaces via commitTerminalSuccess → capturedFailureText. This makes
    // the coverage gap explicit: empty answer ⇒ error surfaces; non-empty answer
    // (the live case) ⇒ error dropped.
    const rag = stubRag();
    const backend = new InMemoryKnowledgeBackend();

    const deps: ControllerHandlerDeps = {
      evaluator: scriptedClient([
        { kind: 'content', content: 'Goal: read a class, report errors' },
      ]),
      planner: scriptedClient([
        {
          kind: 'content',
          content: JSON.stringify({
            plan: [{ name: 's1', instructions: 'read the class' }],
          }),
        },
        { kind: 'content', content: JSON.stringify({ plan: [] }) }, // replan → empty
        { kind: 'content', content: '' }, // legacy finalize answer → EMPTY
      ]),
      executor: scriptedClient([toolCall('ReadClass', { name: 'ZZ_QX9B7' })]),
      backend,
      knowledgeRagFor: () => rag,
      embedder: stubEmbedder,
      callMcp: async () => ({
        text: 'Class ZZ_QX9B7 not found',
        isError: true,
      }),
      selectTools: async (): Promise<LlmTool[]> => [
        { name: 'ReadClass', description: '', inputSchema: {} },
      ],
      isExternalTool: () => false,
      config: baseConfig(),
      // No finalizer → legacy done.result path; the empty answer trips the guard.
      models: { evaluator: 'm-eval', planner: 'm-plan', executor: 'm-exec' },
    };

    const { ctx, captured } = fakeCtx();
    await new ControllerCoordinatorHandler(deps).execute(ctx, {}, undefined);

    const body = surfacedContent(captured);
    assert.ok(body);
    assert.match(
      body,
      /Class ZZ_QX9B7 not found/,
      'empty finalizer answer ⇒ the #243 guard surfaces the captured error',
    );

    const bundle = await hydrateBundle(backend, 'sess-1');
    const term = await readTerminal(
      backend,
      'sess-1',
      // biome-ignore lint/style/noNonNullAssertion: runId set after execute
      bundle.runId!,
      new Date().toISOString(),
    );
    assert.equal(term?.kind, 'error');
  });
});
