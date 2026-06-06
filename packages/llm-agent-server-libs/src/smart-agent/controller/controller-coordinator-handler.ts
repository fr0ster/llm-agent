import {
  ClarifySignal,
  externalToolCallId,
  type IEmbedder,
  type IKnowledgeRagHandle,
  type IStageHandler,
  type KnowledgeEntryMetadata,
  type LlmToolCall,
  type Message,
  type StreamToolCall,
} from '@mcp-abap-adt/llm-agent';
import type {
  KnowledgeBackend,
  PipelineContext,
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
  embedder: IEmbedder;
  /** Executes an INTERNAL (MCP) tool and returns its textual result. */
  callMcp: (toolName: string, args: unknown) => Promise<string>;
  /**
   * Optional override marking a tool as consumer-supplied (must round-trip to
   * the client). Production truth is the per-request `ctx.externalTools`; this
   * override is retained ONLY so unit tests can force external routing. The
   * effective predicate OR-combines both.
   */
  isExternalTool?: (toolName: string) => boolean;
  config: ControllerConfig;
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
        this.surfaceToolCall(ctx, {
          id: extId,
          name: toolName,
          arguments: (bundle.pending.args ?? {}) as Record<string, unknown>,
        });
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
      bundle.plannerPrivate += `\n[clarify answer] ${prompt}`;
      bundle.pending = undefined;
    }

    // -- Establish the goal (evaluator) -------------------------------------
    if (!bundle.goal) {
      try {
        bundle.goal = await establishTargetState(
          { evaluator: deps.evaluator, embedder: deps.embedder },
          prompt,
          deps.config.targetState,
        );
      } catch (err) {
        if (err instanceof ClarifySignal) {
          bundle.pending = {
            kind: 'clarify',
            question: err.question,
            position: 'goal',
          };
          await persistBundle(deps.backend, sessionId, bundle);
          this.surfaceClarify(ctx, err.question);
          return true;
        }
        throw err;
      }
    }

    // -- Main loop ----------------------------------------------------------
    const cfg = deps.config.budgets;
    while (bundle.budgets.stepsUsed < cfg.maxSteps) {
      const next = await this.planNext(bundle, prompt);

      if (next.kind === 'done') {
        bundle.pending = undefined;
        await persistBundle(deps.backend, sessionId, bundle);
        this.surfaceFinal(ctx, next.result);
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
          );
        }
        bundle.plannerPrivate += `\n[rewind] ${next.reason}`;
        await persistBundle(deps.backend, sessionId, bundle);
        continue;
      }

      // next.kind === 'next' → execute the step.
      const completed = await this.runStep(
        ctx,
        sessionId,
        bundle,
        rag,
        meta,
        next.step,
        isExternalTool,
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
    );
  }

  // -- Planner ------------------------------------------------------------

  private async planNext(
    bundle: SessionBundle,
    prompt: string,
  ): Promise<NextStep> {
    const res = await this.deps.planner.send([
      {
        role: 'system',
        content:
          'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
          'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
          'next step, {"kind":"done","result":...} when the goal is met, or ' +
          '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.',
      },
      {
        role: 'user',
        content: `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}`,
      },
    ]);
    if (res.kind !== 'content') {
      // The planner emitted a tool call or error instead of a decision — treat
      // as a rewind so the loop replans rather than crashing.
      return { kind: 'rewind', reason: 'planner produced no decision' };
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
  ): Promise<'advanced' | 'suspended'> {
    const deps = this.deps;
    const cfg = deps.config.budgets;
    const maxToolCalls = cfg.maxToolCalls ?? 10;
    let toolCalls = 0;
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are the executor. Carry out the step. Emit a tool call when you ' +
          'need a tool, otherwise return the step result as content.',
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

    let retries = 0;

    // Inner loop handles tool routing / error retries until the executor
    // produces content for this step (or the step suspends on an external tool).
    while (true) {
      const res = await deps.executor.send(messages);

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
        this.surfaceToolCall(ctx, { id: extId, name, arguments: args });
        return 'suspended';
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
      messages.push({
        role: 'user',
        content: `Tool ${name} returned: ${result}`,
      });
    }
  }

  // -- Escalation & surfacing (mirror StepperCoordinatorHandler) ----------

  private async escalate(
    ctx: PipelineContext,
    sessionId: string,
    bundle: SessionBundle,
    question: string,
  ): Promise<boolean> {
    bundle.pending = { kind: 'clarify', question, position: 'loop' };
    await persistBundle(this.deps.backend, sessionId, bundle);
    this.surfaceClarify(ctx, question);
    return true;
  }

  private surfaceClarify(ctx: PipelineContext, question: string): void {
    ctx.yield({
      ok: true,
      value: { content: `To proceed, please provide: ${question}` },
    });
    ctx.yield({ ok: true, value: { content: '', finishReason: 'stop' } });
  }

  private surfaceFinal(ctx: PipelineContext, content: string): void {
    ctx.yield({ ok: true, value: { content, finishReason: 'stop' } });
  }

  private surfaceToolCall(ctx: PipelineContext, call: LlmToolCall): void {
    ctx.yield({
      ok: true,
      value: { content: '', toolCalls: [call], finishReason: 'tool_calls' },
    });
  }
}

// ---------------------------------------------------------------------------
// Episodic recall tuning
// ---------------------------------------------------------------------------

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
function parseNextStep(content: string): NextStep {
  try {
    const obj = JSON.parse(content) as Partial<NextStep>;
    if (obj.kind === 'done' && typeof obj.result === 'string')
      return { kind: 'done', result: obj.result };
    if (obj.kind === 'rewind' && typeof obj.reason === 'string')
      return { kind: 'rewind', reason: obj.reason };
    if (obj.kind === 'next' && obj.step && typeof obj.step.name === 'string')
      return { kind: 'next', step: obj.step };
  } catch {
    // fall through
  }
  return { kind: 'rewind', reason: 'unparsable planner output' };
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
