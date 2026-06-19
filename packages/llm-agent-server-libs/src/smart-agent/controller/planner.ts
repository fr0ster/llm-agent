import type { CallOptions, LlmUsage } from '@mcp-abap-adt/llm-agent';
import {
  mintCreateStepIds,
  mintReplanStepIds,
  type PlanDecision,
} from './artifacts.js';
import {
  extractJsonObject,
  parseNextStep,
} from './controller-coordinator-handler.js';
import { appendHint } from './prompts.js';
import type { ISubagentClient } from './subagent-client.js';
import {
  type IControllerPlanner,
  MAX_REQUIRE_CHARS,
  MAX_REQUIRES,
  type NextStep,
  type PlannerKind,
  type PlannerNextInput,
  type SessionBundle,
  type Step,
  validateRequires,
} from './types.js';

// Built from the validation constants so the prompt cap can NEVER drift from what
// the parser enforces (no duplicated literals). Appended to EVERY planner/replan
// prompt as a HARD invariant so step instructions/requires are English (stable
// tool selection against the English-translated catalog) and the requires count is
// bounded.
export const ENGLISH_INSTRUCTIONS_RULE =
  ' Step `instructions` AND `requires` references MUST be written in English — ' +
  "always, regardless of the language of the user's request. This is a hard " +
  'contract: the executor selects tools by semantic match against an ' +
  'English-translated catalog, and the reviewer matches `requires` against stored ' +
  'artifacts — so non-English instructions/requires break both. ' +
  `List at MOST ${MAX_REQUIRES} \`requires\`, each a SHORT reference (a few words, ` +
  `≤ ${MAX_REQUIRE_CHARS} chars) — not pasted content. (The user-facing answer is ` +
  "composed separately in the user's language.)";

export const PLANNER_SYSTEM =
  'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
  'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
  'next step, {"kind":"done","result":...} when the goal is met, or ' +
  '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.\n' +
  'An executor carries out each step against the live target system using tools. ' +
  'Describe each step by INTENT — WHAT to fetch or do — in plain language. Do ' +
  'NOT choose, name, or assume a specific tool (no tool names in the step); the ' +
  'executor selects the right tool for the step. Any fact about the system MUST ' +
  'be obtained by planning a step that fetches it with a tool — do NOT answer ' +
  'from prior knowledge, and do NOT mark the goal "done" until the required data ' +
  'has actually been fetched (fetched results appear under Progress). Until then, ' +
  'return a concrete "next" fetch step. ' +
  'Keep each step MINIMAL and do NOT broaden the scope beyond what the goal asks, ' +
  'at the granularity it asks: a LIST/SHOW/find request is satisfied by the list ' +
  'itself — do NOT plan a step that fetches the full details of every listed item ' +
  'unless the goal explicitly asks for per-item details.' +
  ENGLISH_INSTRUCTIONS_RULE;

const RETRY_HINT =
  '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw ' +
  'JSON object — no prose, no explanation, no markdown code fences.';

/**
 * Controller-own skills recall hook (B4). Given the goal, returns a bounded,
 * pre-formatted "Relevant skills" block (or '' when there is nothing to inject).
 * Threaded host → ctx → factory → handler → planner. Absent OR returning '' →
 * the planner prompt is byte-identical to the agnostic path (measurement toggle).
 */
export type SkillsRecall = (
  goal: string,
  options?: CallOptions,
) => Promise<string>;

/** Append a non-empty recall block to a user message, preserving the agnostic
 *  message byte-for-byte when the block is empty. */
function withSkillsBlock(userContent: string, block: string): string {
  return block ? `${userContent}\n\n${block}` : userContent;
}

/** The planner's progress context. With a live board, render the AUTHORITATIVE
 *  structured board AND the plannerPrivate tail — the latter carries non-board
 *  deltas the planner still needs (clarify answers, legacy external-tool result).
 *  An empty board (decision-less IncrementalPlanner) → plannerPrivate alone,
 *  byte-identical to the legacy prompt. */
function progressBlock(bundle: SessionBundle, boardText?: string): string {
  return boardText && boardText.length > 0
    ? `${boardText}\n${bundle.plannerPrivate}`
    : bundle.plannerPrivate;
}

export class IncrementalPlanner implements IControllerPlanner {
  constructor(
    private readonly planner: ISubagentClient,
    /** Optional consumer domain hint appended to the agnostic planner prompt. */
    private readonly hint?: string,
    /** Optional controller-own skills recall hook (B4). */
    private readonly skillsRecall?: SkillsRecall,
  ) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, retrying, logUsage, options, boardText } = input;
    const block = this.skillsRecall
      ? await this.skillsRecall(bundle.goal, options)
      : '';
    const res = await this.planner.send([
      {
        role: 'system',
        content:
          appendHint(PLANNER_SYSTEM, this.hint) + (retrying ? RETRY_HINT : ''),
      },
      {
        role: 'user',
        content: withSkillsBlock(
          `Goal: ${bundle.goal}\nProgress:${progressBlock(bundle, boardText)}\nRequest: ${prompt}`,
          block,
        ),
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parseNextStep(res.content);
  }
}

export const CREATE_PLAN_SYSTEM =
  'You are the planner. Produce the COMPLETE, ordered plan that covers the ENTIRE ' +
  'goal NOW, as a SINGLE JSON object: {"plan":[{"name":...,"instructions":...}, ...]}. ' +
  'This is plan-once: there will be NO chance to add steps later (a replan happens ' +
  'only if a step FAILS), so the plan MUST already contain every step the goal ' +
  'needs from start to finish. Do NOT return a first-step-only or partial plan. ' +
  'Decompose the whole goal: if the request lists multiple actions (e.g. joined by ' +
  '"then"/"and"/"also"/"потім"/"і"/commas), emit ONE step per action — a ' +
  'multi-action request MUST yield multiple steps (never a single step that lumps ' +
  'them together). ' +
  'Each step is ONE concrete action an executor performs against the live target ' +
  'system using tools. Describe each step by INTENT — WHAT to fetch or do — in ' +
  'plain language. Do NOT choose, name, or assume a specific tool (no tool names ' +
  'in the step instructions); the executor selects the right tool for the step. ' +
  'Any fact about the system MUST be fetched ' +
  'with a tool — plan fetch steps; never answer from prior knowledge. ' +
  'Keep it MINIMAL: one step per distinct piece of information the goal asks for; ' +
  'do NOT add exploratory or enrichment steps (extra metadata, sample/preview ' +
  'rows, recursive expansion) the goal did not request. ' +
  'Do NOT BROADEN the scope: answer exactly what the request asks, at the ' +
  'granularity it asks. In particular, do NOT add a "for each item, fetch its ' +
  'details" step unless the request explicitly asks for per-item details — a ' +
  'request to LIST/SHOW/find items is satisfied by the list itself; fetching the ' +
  'full details of every listed item is scope creep. ' +
  'Do NOT add a final step ' +
  'that summarizes, formats, or answers the user — a separate finalizer composes ' +
  'the answer from the fetched results, so the last step must be the last ' +
  'data-fetch/action the goal needs. Output JSON only.' +
  ENGLISH_INSTRUCTIONS_RULE;

export const REPLAN_SYSTEM =
  'You are the planner. A step just FAILED. Given the goal, the progress so far ' +
  '(fetched results + the failure), produce a REVISED, MINIMAL plan for the ' +
  'REMAINING work as {"plan":[{"name":...,"instructions":...}, ...]}. Plan only ' +
  'the data-fetch/action steps still required; describe each step by INTENT — do ' +
  'NOT name or choose a specific tool, the executor selects it. Do NOT add a ' +
  'final summarize/' +
  'answer step (a separate finalizer composes the answer). If the goal is ' +
  'already satisfied despite the failure, return {"plan":[]}. Output JSON only.' +
  ENGLISH_INSTRUCTIONS_RULE;

export const EXTERNAL_RESULT_REPLAN_SYSTEM =
  'You are the planner. A NEW external tool result just arrived (see Progress) — ' +
  'this is NOT a failure. Given the goal and the progress (including the new ' +
  'result), produce a REVISED, MINIMAL plan for the REMAINING work as ' +
  '{"plan":[{"name":...,"instructions":...}, ...]}. Plan only the data-fetch/' +
  'action steps still required; describe each step by INTENT — do NOT name or ' +
  'choose a specific tool, the executor selects it. Do NOT add a final summarize/' +
  'answer step (a ' +
  'separate finalizer composes the answer). If the goal is already satisfied by ' +
  'the result, return {"plan":[]}. Output JSON only.' +
  ENGLISH_INSTRUCTIONS_RULE;

const FINALIZE_SYSTEM =
  'All planned steps are complete. Using the progress below (the fetched results), ' +
  'write the final answer to the user request. Plain text, no JSON.';

/** Parse {"plan":[{name,instructions},...]} from a (possibly fenced) reply.
 *  Returns null on format failure: no `plan` array, OR ANY entry missing a valid
 *  name/instructions (so a half-formed step is a retryable format error, not a
 *  silently-dropped step). An explicitly empty `{"plan":[]}` is VALID (= nothing
 *  left to do — used by replan to signal completion). */
function parsePlan(content: string): Step[] | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as { plan?: unknown };
    if (!Array.isArray(obj.plan)) return null;
    const steps: Step[] = [];
    for (const raw of obj.plan) {
      const s = raw as Partial<Step>;
      if (typeof s.name !== 'string' || typeof s.instructions !== 'string') {
        return null; // malformed step → format failure (handler retries)
      }
      const req = validateRequires((raw as { requires?: unknown }).requires);
      if (req === false) return null; // malformed requires → format failure → retry
      steps.push({
        name: s.name,
        instructions: s.instructions,
        ...(s.type ? { type: s.type } : {}),
        ...(req ? { requires: req } : {}),
      });
    }
    return steps;
  } catch {
    return null;
  }
}

/** Queue a plan decision for the controller to persist (§A boundary: the planner
 *  CONSTRUCTS the decision; the controller does the durable write). */
function recordDecision(bundle: SessionBundle, decision: PlanDecision): void {
  if (!bundle.pendingPlanDecisions) bundle.pendingPlanDecisions = [];
  bundle.pendingPlanDecisions.push(decision);
}

export class AdaptivePlanner implements IControllerPlanner {
  // No budget field: replans are bounded by the loop's maxSteps (a failed step
  // bumps stepsUsed in runStep). Replan-specific budgeting is the deferred
  // "limits as a selectable strategy" work.
  constructor(
    private readonly planner: ISubagentClient,
    /** Optional consumer domain hint appended to every agnostic planner/
     *  create-plan/replan/finalize prompt this planner emits. */
    private readonly hint?: string,
    /** Optional controller-own skills recall hook (B4). Queried before each
     *  create-plan/replan; its block is injected into the user message. */
    private readonly skillsRecall?: SkillsRecall,
  ) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const {
      bundle,
      prompt,
      lastOutcome,
      resumedExternal,
      retrying,
      logUsage,
      options,
      boardText,
    } = input;

    // 1. No plan yet → create it.
    if (!bundle.plan) {
      const plan = await this.callPlan(
        CREATE_PLAN_SYSTEM,
        bundle,
        prompt,
        retrying,
        logUsage,
        [],
        options,
        boardText,
      );
      // An EMPTY plan from createPlan is invalid: it would skip straight to the
      // finalizer and answer WITHOUT fetching the required data. Treat it as a
      // format failure → handler re-asks (bounded by maxRetries). (An empty plan
      // is only valid on REPLAN, where it means "remaining work is done".)
      if (plan === null || plan.length === 0) return null;
      const minted = mintCreateStepIds(plan, bundle.runId ?? '');
      bundle.plan = minted;
      bundle.planCursor = 0;
      recordDecision(bundle, {
        kind: 'create',
        runId: bundle.runId ?? '',
        steps: minted,
      });
      return this.stepAtCursor(bundle, prompt, logUsage, boardText);
    }

    // 2. Previous step failed, OR an external-tool result just arrived → replan
    //    the remainder from the cursor. The planner reads plannerPrivate (which
    //    now holds the failure/external result), so the revised plan incorporates
    //    it — no reliance on the executor seeing it. Use the matching prompt: an
    //    external result is NOT a failure, so it gets its own framing.
    if (
      lastOutcome === 'failed' ||
      lastOutcome === 'partial' ||
      resumedExternal
    ) {
      const system = resumedExternal
        ? EXTERNAL_RESULT_REPLAN_SYSTEM
        : REPLAN_SYSTEM;
      const cursor = bundle.planCursor ?? 0;
      // Steps before the cursor already ran successfully — pass them so the replan
      // plans only the remaining work and never repeats a completed step.
      const completed = bundle.plan.slice(0, cursor);
      const rest = await this.callPlan(
        system,
        bundle,
        prompt,
        retrying,
        logUsage,
        completed,
        options,
        boardText,
      );
      if (rest === null) return null;
      const anchor = bundle.plan[cursor]?.stepId ?? '';
      const mintedRest = mintReplanStepIds(rest, bundle.runId ?? '', anchor);
      bundle.plan = [...bundle.plan.slice(0, cursor), ...mintedRest];
      recordDecision(bundle, {
        kind: 'replan',
        runId: bundle.runId ?? '',
        anchor,
        steps: mintedRest,
      });
      // The failure has now been consumed into the revised plan. Clear the durable
      // failure marker BEFORE the (possible) finalize below, so that: a crash after
      // this replan does NOT replan again on resume, and a finalizer error after an
      // empty replan retries only the finalizer (not another replan).
      bundle.lastOutcome = undefined;
      return this.stepAtCursor(bundle, prompt, logUsage, boardText);
    }

    // 3. Otherwise emit the step at the cursor (or finalize). The cursor is
    //    advanced by commit() AFTER a step succeeds — NOT here — so the advance
    //    is persisted together with the step result (see Task 4), and a resume
    //    with lastOutcome=undefined continues from the next uncompleted step
    //    instead of repeating the last one.
    return this.stepAtCursor(bundle, prompt, logUsage, boardText);
  }

  /** Commit the just-finished step's outcome so the advance is persisted with it.
   *  On success the cursor moves to the next step; a failure leaves the cursor so
   *  the next next() can replan from it. (No LLM call — pure bookkeeping.) */
  commit(
    bundle: SessionBundle,
    outcome: 'advanced' | 'failed' | 'partial',
  ): void {
    // 'advanced' and 'partial' both advance the cursor: the accepted part of a
    // partial is committed and must not be re-run (the remainder is replanned at
    // the next cursor). 'failed' leaves the cursor for next()'s replan.
    if (outcome === 'advanced' || outcome === 'partial') {
      bundle.planCursor = (bundle.planCursor ?? 0) + 1;
    }
  }

  /** Return the step at the cursor, or finalize → done when the plan is exhausted.
   *  Returns null when the finalizer call fails (error / unexpected tool_call) so
   *  the handler retries it (bounded by maxRetries) instead of emitting a fake
   *  "completed" answer. */
  private async stepAtCursor(
    bundle: SessionBundle,
    prompt: string,
    logUsage?: (role: string, u?: LlmUsage) => void,
    boardText?: string,
  ): Promise<NextStep | null> {
    const plan = bundle.plan ?? [];
    const cursor = bundle.planCursor ?? 0;
    if (cursor >= plan.length) {
      const res = await this.planner.send([
        { role: 'system', content: appendHint(FINALIZE_SYSTEM, this.hint) },
        {
          role: 'user',
          content: `Goal: ${bundle.goal}\nRequest: ${prompt}\nProgress:${progressBlock(bundle, boardText)}`,
        },
      ]);
      logUsage?.('finalizer', res.usage);
      // Finalizer must produce content; an error or tool_call is NOT a successful
      // answer → null so the handler re-asks rather than faking "completed".
      if (res.kind !== 'content') return null;
      return { kind: 'done', result: res.content };
    }
    return { kind: 'next', step: plan[cursor] };
  }

  private async callPlan(
    system: string,
    bundle: SessionBundle,
    prompt: string,
    retrying: boolean,
    logUsage?: (role: string, u?: LlmUsage) => void,
    completed: Step[] = [],
    options?: CallOptions,
    boardText?: string,
  ): Promise<Step[] | null> {
    // On replan, the planner MUST know which steps already ran (their results are
    // in Progress / the step-result collection) so it plans ONLY the remaining
    // work and never re-executes a completed step.
    const completedBlock = completed.length
      ? `\nALREADY-EXECUTED steps — their results are in Progress above; do NOT plan or repeat these, plan only what is still missing:\n${completed.map((s) => `- ${s.name}`).join('\n')}`
      : '';
    // Recall the configured controller skill group BEFORE the LLM call and inject
    // its bounded block. When the hook is absent OR returns '' the user message is
    // byte-identical to the agnostic prompt (the measurement toggle).
    const skillsBlock = this.skillsRecall
      ? await this.skillsRecall(bundle.goal, options)
      : '';
    const res = await this.planner.send([
      {
        role: 'system',
        content:
          appendHint(system, this.hint) +
          (retrying
            ? '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw JSON object.'
            : ''),
      },
      {
        role: 'user',
        content: withSkillsBlock(
          `Goal: ${bundle.goal}\nProgress:${progressBlock(bundle, boardText)}${completedBlock}\nRequest: ${prompt}`,
          skillsBlock,
        ),
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parsePlan(res.content);
  }
}

export function makePlanner(
  kind: PlannerKind,
  planner: ISubagentClient,
  hint?: string,
  skillsRecall?: SkillsRecall,
): IControllerPlanner {
  return kind === 'adaptive'
    ? new AdaptivePlanner(planner, hint, skillsRecall)
    : new IncrementalPlanner(planner, hint, skillsRecall);
}
