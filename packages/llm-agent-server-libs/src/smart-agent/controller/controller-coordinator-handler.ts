import {
  externalToolCallId,
  type IEmbedder,
  type IKnowledgeRagHandle,
  type IRequestLogger,
  type IStageHandler,
  type KnowledgeEntryMetadata,
  type LlmComponent,
  type LlmTool,
  type LlmToolCall,
  type LlmUsage,
  type Message,
  type ModelUsageEntry,
  type StreamToolCall,
} from '@mcp-abap-adt/llm-agent';
import {
  type KnowledgeBackend,
  type PipelineContext,
  summaryToUsage,
} from '@mcp-abap-adt/llm-agent-libs';
import { writeArtifact } from './memorizer.js';
import { resolveNeed } from './need-resolver.js';
import { hydrateBundle, persistBundle } from './session-bundle.js';
import type { ISubagentClient } from './subagent-client.js';
import { establishTargetState } from './target-state.js';
import type {
  ControllerConfig,
  NextStep,
  SessionBundle,
  Step,
} from './types.js';

// ---------------------------------------------------------------------------
// Debug logging — gated behind DEBUG_CONTROLLER (e.g. DEBUG_CONTROLLER=1).
// Surfaces the steps the planner delegates and per-role/total token usage to
// stderr, for tuning step granularity and watching token spend. Off by default.
// ---------------------------------------------------------------------------

function dlog(msg: string): void {
  if (process.env.DEBUG_CONTROLLER) console.error(`[controller] ${msg}`);
}

/** Flat usage triple + per-model breakdown — the canonical terminal-chunk shape. */
export type TerminalUsage = LlmUsage & {
  models?: Record<string, ModelUsageEntry>;
};

/**
 * Build a request-time `logUsage(role, usage)` that writes each subagent call
 * into the per-request `IRequestLogger` (the single aggregator), attributing the
 * role's configured model. The role is explicit at the call site, so the shared
 * planner/finalizer client is attributed correctly. `durationMs: 0` — the seam
 * carries no timing (matches the rag-query precedent).
 */
export function makeLogUsage(
  requestLogger: IRequestLogger,
  requestId: string | undefined,
  models: { evaluator: string; planner: string; executor: string },
): (role: string, u?: LlmUsage) => void {
  return (role, u) => {
    if (!u) return;
    const model =
      role === 'finalizer'
        ? models.planner
        : role === 'embedding'
          ? 'embedder'
          : ((models as Record<string, string>)[role] ?? 'unknown');
    requestLogger.logLlmCall({
      component: role as LlmComponent,
      model,
      promptTokens: u.promptTokens ?? 0,
      completionTokens: u.completionTokens ?? 0,
      totalTokens: u.totalTokens ?? 0,
      durationMs: 0,
      requestId,
    });
    dlog(
      `tokens ${role}: prompt=${u.promptTokens} completion=${u.completionTokens} total=${u.totalTokens}`,
    );
  };
}

// ---------------------------------------------------------------------------
// Dep-injection surface
// ---------------------------------------------------------------------------

export interface ControllerHandlerDeps {
  evaluator: ISubagentClient;
  planner: ISubagentClient;
  executor: ISubagentClient;
  backend: KnowledgeBackend;
  knowledgeRagFor: (
    sessionId: string,
  ) => IKnowledgeRagHandle | Promise<IKnowledgeRagHandle>;
  /** Required only for distance-based target-state strategies
   *  (semantic-distance/auto); unused by consumer-confirm. */
  embedder?: IEmbedder;
  /** Executes an INTERNAL (MCP) tool and returns its textual result. */
  callMcp: (toolName: string, args: unknown) => Promise<string>;
  /**
   * Semantic tool selection over the vectorized MCP catalog (toolsRag): returns
   * the top-K tools relevant to `query`. This is how INTERNAL tools reach the
   * executor — relevant, bounded, NOT a full dump. MCP-less deployments wire a
   * stub returning `[]`.
   */
  selectTools: (query: string, k?: number) => Promise<readonly LlmTool[]>;
  /**
   * Optional override marking a tool as consumer-supplied (must round-trip to
   * the client). Production truth is the per-request `ctx.externalTools`; this
   * override is retained ONLY so unit tests can force external routing. The
   * effective predicate OR-combines both.
   */
  isExternalTool?: (toolName: string) => boolean;
  config: ControllerConfig;
  /** Resolved model id per subagent role, for usage attribution (finalizer uses
   *  the planner model). */
  models: { evaluator: string; planner: string; executor: string };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Controller coordinator boundary. Runs a deterministic loop delegating to
 * three opaque subagent roles (evaluator / planner / executor):
 *
 *   hydrate bundle → (resume if pending) → establish goal (evaluator) →
 *   LOOP[ planner.nextStep →
 *     done: finalize | rewind: bump+continue |
 *     next: executor.executeStep → route tool calls (internal MCP vs external
 *           round-trip) / retry on error / memorize content + advance ] →
 *   finalize / escalate.
 *
 * Suspend/resume is stateless: all state lives in the persisted SessionBundle
 * (KnowledgeBackend) + `ctx.externalResults`.
 *
 * Escalation mirrors StepperCoordinatorHandler: a ClarifySignal is NOT thrown
 * upward — it is surfaced to the consumer via `ctx.yield` (a content chunk with
 * the question, then a terminal `finishReason:'stop'` chunk), and `execute`
 * returns true. The pending marker is persisted first so a stateless resume can
 * pick up the human's answer.
 */
export class ControllerCoordinatorHandler implements IStageHandler {
  constructor(private readonly deps: ControllerHandlerDeps) {}

  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    _span: unknown,
  ): Promise<boolean> {
    const deps = this.deps;
    const sessionId = ctx.sessionId;
    const prompt = extractPrompt(ctx.textOrMessages);
    const rag = await deps.knowledgeRagFor(sessionId);
    const bundle = await hydrateBundle(deps.backend, sessionId);

    const meta = synthMeta(ctx, sessionId);

    // Token accounting: every subagent call is logged into the per-request
    // IRequestLogger (the single aggregator). The terminal chunk's usage is read
    // back from getSummary(traceId) — never a private accumulator — so it matches
    // /v1/usage and carries the per-model breakdown.
    const logUsage = makeLogUsage(ctx.requestLogger, meta.traceId, deps.models);
    const usageNow = (): TerminalUsage => {
      const s = ctx.requestLogger.getSummary(meta.traceId);
      return { ...summaryToUsage(s), models: s.byModel };
    };

    // Route external tools by the PER-REQUEST context (the client-supplied tools
    // for THIS request), OR-combined with the optional test-only override. The
    // build-time server ctx never carries external tools (they arrive per-request
    // via HTTP body.tools → ctx.externalTools), so this is the production truth.
    const externalNames = new Set((ctx.externalTools ?? []).map((t) => t.name));
    const isExternalTool = (name: string): boolean =>
      externalNames.has(name) || (deps.isExternalTool?.(name) ?? false);

    // -- Resume from a persisted pending marker -----------------------------
    if (bundle.pending?.kind === 'external-tool') {
      const { extId, toolName } = bundle.pending;
      const result = ctx.externalResults?.get(extId);
      if (result === undefined) {
        // No result yet → re-surface the same external tool call and suspend.
        this.surfaceToolCall(
          ctx,
          {
            id: extId,
            name: toolName,
            arguments: (bundle.pending.args ?? {}) as Record<string, unknown>,
          },
          usageNow(),
        );
        return true;
      }
      // Tool result arrived — record it and let the loop continue planning.
      await writeArtifact(rag, {
        ...meta,
        artifactType: 'mcp-result',
        toolName,
        task: bundle.pending.position,
        content: result,
      });
      bundle.plannerPrivate += `\n[external tool ${toolName} result] ${result}`;
      bundle.pending = undefined;
    } else if (bundle.pending?.kind === 'clarify') {
      // The incoming prompt is the human's answer to the clarify question.
      // For a goal-confirmation clarify (position 'goal'), commit the goal so we
      // do NOT re-enter the confirm loop (the empty-goal check below would
      // otherwise re-run the evaluator and clarify forever). A plain affirmation
      // ("yes"/"так") confirms the evaluator's PROPOSED target; anything else is
      // treated as a refinement and becomes the goal verbatim.
      if (bundle.pending.position === 'goal') {
        const answer = prompt.trim();
        const proposed = bundle.pending.proposedTarget;
        bundle.goal = proposed && isAffirmation(answer) ? proposed : answer;
      }
      bundle.plannerPrivate += `\n[clarify answer] ${prompt}`;
      bundle.pending = undefined;
    }

    // -- Establish the goal (evaluator) -------------------------------------
    if (!bundle.goal) {
      const outcome = await establishTargetState(
        { evaluator: deps.evaluator, embedder: deps.embedder },
        prompt,
        deps.config.targetState,
      );
      logUsage('evaluator', outcome.usage);
      if (outcome.kind === 'needs-confirmation') {
        // Persist the proposed target with the pending marker so a confirmation
        // on resume commits IT (not a bare "yes"). See the clarify-resume above.
        bundle.pending = {
          kind: 'clarify',
          question: outcome.question,
          position: 'goal',
          proposedTarget: outcome.proposedTarget,
        };
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceClarify(ctx, outcome.question, usageNow());
        return true;
      }
      bundle.goal = outcome.goal;
    }

    // -- Main loop ----------------------------------------------------------
    // Catalog of the tools relevant to THIS request, surfaced semantically from
    // the vectorized MCP catalog (toolsRag) — bounded and relevant, not a full
    // dump — so the planner plans tool-using steps instead of answering blind.
    const relevantForGoal = await deps.selectTools(
      `${bundle.goal}\n${prompt}`,
      TOOL_SELECT_K,
    );
    const toolCatalog = buildToolCatalog([
      ...relevantForGoal,
      ...(ctx.externalTools ?? []),
    ]);
    const cfg = deps.config.budgets;
    let planParseRetries = 0;
    while (bundle.budgets.stepsUsed < cfg.maxSteps) {
      const next = await this.planNext(
        bundle,
        prompt,
        toolCatalog,
        planParseRetries > 0,
        logUsage,
      );

      // Format failure (not valid NextStep JSON) → re-ask the planner with a
      // stern reminder, bounded by maxRetries. This does NOT touch rewindsUsed:
      // a malformed reply is a formatting problem, not a decision to backtrack.
      if (next === null) {
        planParseRetries++;
        if (planParseRetries > cfg.maxRetries) {
          return this.escalate(
            ctx,
            sessionId,
            bundle,
            'the planner did not return a valid decision — please rephrase or retry',
            usageNow(),
          );
        }
        continue;
      }
      planParseRetries = 0;

      if (next.kind === 'done') {
        bundle.pending = undefined;
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceFinal(ctx, next.result, usageNow());
        return true;
      }

      if (next.kind === 'rewind') {
        bundle.budgets.rewindsUsed++;
        if (bundle.budgets.rewindsUsed > cfg.maxRewinds) {
          return this.escalate(
            ctx,
            sessionId,
            bundle,
            'too many rewinds — please confirm how to proceed',
            usageNow(),
          );
        }
        bundle.plannerPrivate += `\n[rewind] ${next.reason}`;
        await persistBundle(deps.backend, sessionId, bundle);
        continue;
      }

      // next.kind === 'next' → execute the step.
      dlog(
        `delegate step "${next.step.name}"${next.step.type ? ` (${next.step.type})` : ''}: ${next.step.instructions}`,
      );
      const completed = await this.runStep(
        ctx,
        sessionId,
        bundle,
        rag,
        meta,
        next.step,
        isExternalTool,
        logUsage,
        usageNow,
      );
      if (completed === 'suspended') return true;
      // 'advanced' → loop continues to the next planner call.
    }

    // -- Budget exhausted ---------------------------------------------------
    return this.escalate(
      ctx,
      sessionId,
      bundle,
      'step budget exhausted — please confirm how to proceed',
      usageNow(),
    );
  }

  // -- Planner ------------------------------------------------------------

  private async planNext(
    bundle: SessionBundle,
    prompt: string,
    toolCatalog: string,
    retrying = false,
    logUsage?: (role: string, u?: LlmUsage) => void,
  ): Promise<NextStep | null> {
    const res = await this.deps.planner.send([
      {
        role: 'system',
        content:
          'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
          'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
          'next step, {"kind":"done","result":...} when the goal is met, or ' +
          '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.\n' +
          'An executor carries out each step against the LIVE SAP system using the ' +
          'tools listed below. Any fact about the system MUST be obtained by planning a ' +
          'step that fetches it with a tool — do NOT answer from prior knowledge, and do ' +
          'NOT mark the goal "done" until the required data has actually been fetched ' +
          '(fetched results appear under Progress). Until then, return a concrete ' +
          '"next" fetch step.' +
          (retrying
            ? '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY ' +
              'the raw JSON object — no prose, no explanation, no markdown code fences.'
            : ''),
      },
      {
        role: 'user',
        content:
          `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}\n` +
          `Available tools (the executor picks the exact one):\n${toolCatalog}`,
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') {
      // The planner emitted a tool call or error instead of a decision → a
      // FORMAT failure (null), so the loop re-asks rather than burning a rewind.
      return null;
    }
    return parseNextStep(res.content);
  }

  // -- Step execution -----------------------------------------------------

  /** Returns 'advanced' (step done, continue loop) or 'suspended' (external
   *  round-trip surfaced — caller must return true). */
  private async runStep(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    rag: IKnowledgeRagHandle,
    meta: KnowledgeEntryMetadata,
    step: Step,
    isExternalTool: (name: string) => boolean,
    logUsage?: (role: string, u?: LlmUsage) => void,
    usageNow?: () => TerminalUsage,
  ): Promise<'advanced' | 'suspended'> {
    const deps = this.deps;
    const cfg = deps.config.budgets;
    const maxToolCalls = cfg.maxToolCalls ?? 10;
    let toolCalls = 0;
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are the executor. You have tools that read the LIVE SAP system. ' +
          'You MUST obtain any fact about the system (table structure, package ' +
          'contents, dumps, source, etc.) by CALLING the appropriate tool — never ' +
          'answer such facts from prior knowledge or memory. Emit a tool call when ' +
          'you need data; only return the step result as content once you have the ' +
          'tool results.',
      },
      {
        role: 'user',
        content: `Goal: ${bundle.goal}\nStep: ${step.name}\nInstructions: ${step.instructions}`,
      },
    ];

    // Episodic recall: pull prior artifacts relevant to this step from
    // session-memory and inject them as context. The session-memory rag shares
    // the bundle backend, so restrict to artifact types (excludes the
    // 'controller-bundle' infrastructure record). Bounded by k and length.
    const recallText = step.instructions || step.name;
    const recalled = await resolveNeed(rag, recallText, RECALL_K, {
      artifactType: RECALL_ARTIFACT_TYPES,
    });
    const recallBlock = buildRecallBlock(recalled);
    if (recallBlock) {
      messages.push({ role: 'user', content: recallBlock });
    }

    // Tools offered to the executor = the INTERNAL (MCP) tools semantically
    // relevant to THIS step (top-K from toolsRag) PLUS the per-request external
    // (consumer-supplied) tools. The executor decides which to call; internal
    // calls route through `callMcp`, external calls round-trip via `isExternalTool`.
    const relevant = await deps.selectTools(
      step.instructions || step.name,
      TOOL_SELECT_K,
    );
    const offeredTools: LlmTool[] = [...relevant, ...(ctx.externalTools ?? [])];
    // The executor may ONLY call a tool that was offered to it: an internal tool
    // selected for this step, or a per-request external tool. Any other name
    // (hallucinated / stale / not in the top-K) is rejected — never executed —
    // so the semantic exposure boundary actually bounds what runs.
    const offeredInternalNames = new Set(relevant.map((t) => t.name));

    let retries = 0;

    // Inner loop handles tool routing / error retries until the executor
    // produces content for this step (or the step suspends on an external tool).
    while (true) {
      const res = await deps.executor.send(messages, offeredTools);
      logUsage?.('executor', res.usage);

      if (res.kind === 'content') {
        await writeArtifact(rag, {
          ...meta,
          artifactType: 'step-result',
          task: step.name,
          content: res.content,
        });
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name}] ${res.content}`;
        await persistBundle(deps.backend, sessionId, bundle);
        return 'advanced';
      }

      if (res.kind === 'error') {
        retries++;
        if (retries <= cfg.maxRetries) {
          messages.push({
            role: 'user',
            content: `The previous attempt failed: ${res.error}. Retry the step.`,
          });
          continue;
        }
        // Retries exhausted — feed the error back as the step result so the
        // planner can replan on the next iteration.
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} failed] ${res.error}`;
        await persistBundle(deps.backend, sessionId, bundle);
        return 'advanced';
      }

      // res.kind === 'tool_call' → route the FIRST tool call.
      const firstCall = res.toolCalls[0];
      if (firstCall === undefined) {
        // Empty tool-call array → treat as an executor error (retry/replan).
        retries++;
        if (retries <= cfg.maxRetries) {
          messages.push({
            role: 'user',
            content:
              'The previous attempt produced an empty tool call. Retry the step.',
          });
          continue;
        }
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} failed] empty tool call`;
        await persistBundle(deps.backend, sessionId, bundle);
        return 'advanced';
      }
      const call = toLlmToolCall(firstCall);
      const name = call.name;
      const args = call.arguments;

      if (isExternalTool(name)) {
        const extId = externalToolCallId(name, args);
        bundle.pending = {
          kind: 'external-tool',
          extId,
          toolName: name,
          args,
          position: step.name,
        };
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceToolCall(ctx, { id: extId, name, arguments: args }, usageNow?.());
        return 'suspended';
      }

      // The executor may only call a tool that was OFFERED to it this step. A
      // name that is neither external nor in the internal top-K (hallucinated /
      // stale / out-of-scope) is rejected — NOT executed — and fed back as a
      // tool-not-available error so the executor retries with an offered tool.
      if (!offeredInternalNames.has(name)) {
        retries++;
        if (retries <= cfg.maxRetries) {
          messages.push({
            role: 'user',
            content: `Tool "${name}" is not available for this step. Use only the tools provided to you.`,
          });
          continue;
        }
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} failed] requested unavailable tool ${name}`;
        await persistBundle(deps.backend, sessionId, bundle);
        return 'advanced';
      }

      // Internal MCP tool — bound the inner loop so a stuck executor cannot
      // spin forever issuing unbounded callMcp iterations.
      toolCalls++;
      if (toolCalls > maxToolCalls) {
        bundle.budgets.stepsUsed++;
        bundle.plannerPrivate += `\n[step ${step.name} aborted] tool-call budget exhausted`;
        await persistBundle(deps.backend, sessionId, bundle);
        return 'advanced';
      }

      // Execute locally, memorize, re-send to the executor.
      const result = await deps.callMcp(name, args);
      await writeArtifact(rag, {
        ...meta,
        artifactType: 'mcp-result',
        toolName: name,
        task: step.name,
        content: result,
      });
      // Feed the result back as a coherent assistant→tool turn (OpenAI protocol)
      // so the executor LLM continues from its own tool call rather than seeing a
      // bare user message. The assistant message carries the tool_call it made;
      // the tool message carries the result keyed by the same id.
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: call.id,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // -- Escalation & surfacing (mirror StepperCoordinatorHandler) ----------

  private async escalate(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    question: string,
    usage?: TerminalUsage,
  ): Promise<boolean> {
    bundle.pending = { kind: 'clarify', question, position: 'loop' };
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceClarify(ctx, question, usage);
    return true;
  }

  private surfaceClarify(
    ctx: PipelineContext,
    question: string,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: { content: `To proceed, please provide: ${question}` },
    });
    ctx.yield({
      ok: true,
      value: { content: '', finishReason: 'stop', ...(usage ? { usage } : {}) },
    });
  }

  private surfaceFinal(
    ctx: PipelineContext,
    content: string,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: { content, finishReason: 'stop', ...(usage ? { usage } : {}) },
    });
  }

  private surfaceToolCall(
    ctx: PipelineContext,
    call: LlmToolCall,
    usage?: TerminalUsage,
  ): void {
    ctx.yield({
      ok: true,
      value: {
        content: '',
        toolCalls: [call],
        finishReason: 'tool_calls',
        ...(usage ? { usage } : {}),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Episodic recall tuning
// ---------------------------------------------------------------------------

/** Bare confirmations that, on a goal clarify, commit the evaluator's proposed
 *  target rather than the literal answer. Anything else = a refinement. */
const AFFIRMATIONS = new Set([
  'yes',
  'y',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'correct',
  'sure',
  'yep',
  'yeah',
  'так',
  'ок',
  'окей',
  'підтверджую',
  'вірно',
  'да',
  '+',
]);

/** True when the answer is a pure confirmation (short affirmative token). */
function isAffirmation(answer: string): boolean {
  const t = answer
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '');
  return AFFIRMATIONS.has(t);
}

/** Top-K tools surfaced from toolsRag per planner/step query. */
const TOOL_SELECT_K = 20;

/** Max characters of the tool catalog handed to the planner (safety bound; with
 *  top-K selection the relevant tools fit well under this). */
const TOOL_CATALOG_MAX_CHARS = 4000;

/** A bounded "name: description" list of the tools the executor can call,
 *  handed to the planner so it plans tool-using fetch steps. */
function buildToolCatalog(tools: LlmTool[]): string {
  if (tools.length === 0) return '(no tools available)';
  const lines: string[] = [];
  let total = 0;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    const desc = (t.description ?? '').split('\n')[0].slice(0, 100);
    const line = `- ${t.name}: ${desc}`;
    if (total + line.length + 1 > TOOL_CATALOG_MAX_CHARS) {
      lines.push(`… (+${tools.length - i} more tools)`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

/** Top-k recalled artifacts injected into the executor context per step. */
const RECALL_K = 5;
/** Artifact types eligible for recall (excludes the 'controller-bundle' record
 *  that shares the same backend). */
const RECALL_ARTIFACT_TYPES = ['step-result', 'mcp-result'] as const;
/** Hard cap on the total injected recall length (chars). */
const RECALL_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Build a bounded "Relevant prior context" block from recalled artifacts, or
 *  undefined when there is nothing to inject. */
function buildRecallBlock(
  hits: readonly { content: string }[],
): string | undefined {
  if (hits.length === 0) return undefined;
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const c = h.content ?? '';
    if (c.length === 0) continue;
    if (used + c.length > RECALL_MAX_CHARS) {
      parts.push(c.slice(0, RECALL_MAX_CHARS - used));
      break;
    }
    parts.push(c);
    used += c.length;
  }
  if (parts.length === 0) return undefined;
  return `Relevant prior context:\n${parts.join('\n')}`;
}

/** Extract the user prompt from the request's textOrMessages. */
function extractPrompt(textOrMessages: string | Message[]): string {
  if (typeof textOrMessages === 'string') return textOrMessages;
  for (let i = textOrMessages.length - 1; i >= 0; i--) {
    if (textOrMessages[i].role === 'user')
      return textOrMessages[i].content ?? '';
  }
  return '';
}

/** Parse a planner content string into a NextStep, defensively. */
/** Parse the planner's reply into a NextStep, tolerating ```json fences and
 *  surrounding prose. Returns null when no valid decision can be extracted — the
 *  caller treats that as a FORMAT error (re-ask the planner), NOT a rewind, so a
 *  badly-formatted reply never silently burns the rewind budget. */
function parseNextStep(content: string): NextStep | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as Partial<NextStep>;
    if (obj.kind === 'done' && typeof obj.result === 'string')
      return { kind: 'done', result: obj.result };
    if (obj.kind === 'rewind' && typeof obj.reason === 'string')
      return { kind: 'rewind', reason: obj.reason };
    if (obj.kind === 'next' && obj.step && typeof obj.step.name === 'string')
      return { kind: 'next', step: obj.step };
  } catch {
    // fall through
  }
  return null;
}

/** Extract the first balanced JSON object from a planner reply, ignoring ```json
 *  fences and prose around it. String-aware (braces inside strings don't count).
 *  Returns null if no balanced object is present. */
function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/** Normalize a StreamToolCall (full or delta) into an LlmToolCall. */
function toLlmToolCall(c: StreamToolCall): LlmToolCall {
  if (
    'arguments' in c &&
    typeof c.arguments === 'object' &&
    c.arguments !== null
  ) {
    // Full LlmToolCall: arguments is already a parsed object.
    return {
      id: ('id' in c && c.id) || 'call',
      name: ('name' in c && c.name) || '',
      arguments: c.arguments as Record<string, unknown>,
    };
  }
  // Delta: arguments is a (possibly partial) JSON string.
  let args: Record<string, unknown> = {};
  const raw = 'arguments' in c ? c.arguments : undefined;
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      args = {};
    }
  }
  return {
    id: ('id' in c && c.id) || 'call',
    name: ('name' in c && c.name) || '',
    arguments: args,
  };
}

/** Synthesize the strict KnowledgeEntryMetadata for controller artifacts. */
function synthMeta(
  ctx: PipelineContext,
  sessionId: string,
): KnowledgeEntryMetadata {
  const traceId = ctx.options?.trace?.traceId ?? sessionId;
  return {
    traceId,
    turnId: traceId,
    stepperId: 'controller',
    task: 'controller',
    artifactType: 'step-result',
    createdAt: new Date().toISOString(),
  };
}
