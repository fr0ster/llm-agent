import type { LlmUsage } from '@mcp-abap-adt/llm-agent';
import {
  extractJsonObject,
  parseNextStep,
} from './controller-coordinator-handler.js';
import type { ISubagentClient } from './subagent-client.js';
import type {
  IControllerPlanner,
  NextStep,
  PlannerKind,
  PlannerNextInput,
  SessionBundle,
  Step,
} from './types.js';

const PLANNER_SYSTEM =
  'You are the planner. Given the goal and progress, return a SINGLE JSON ' +
  'object: {"kind":"next","step":{"name":...,"instructions":...}} to take the ' +
  'next step, {"kind":"done","result":...} when the goal is met, or ' +
  '{"kind":"rewind","reason":...} to discard the current path. Output JSON only.\n' +
  'An executor carries out each step against the LIVE SAP system using the ' +
  'tools listed below. Any fact about the system MUST be obtained by planning a ' +
  'step that fetches it with a tool — do NOT answer from prior knowledge, and do ' +
  'NOT mark the goal "done" until the required data has actually been fetched ' +
  '(fetched results appear under Progress). Until then, return a concrete ' +
  '"next" fetch step.';

const RETRY_HINT =
  '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw ' +
  'JSON object — no prose, no explanation, no markdown code fences.';

export class IncrementalPlanner implements IControllerPlanner {
  constructor(private readonly planner: ISubagentClient) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const { bundle, prompt, toolCatalog, retrying, logUsage } = input;
    const res = await this.planner.send([
      {
        role: 'system',
        content: PLANNER_SYSTEM + (retrying ? RETRY_HINT : ''),
      },
      {
        role: 'user',
        content:
          `Goal: ${bundle.goal}\nProgress:${bundle.plannerPrivate}\nRequest: ${prompt}\n` +
          `Available tools (the executor picks the exact one):\n${toolCatalog}`,
      },
    ]);
    logUsage?.('planner', res.usage);
    if (res.kind !== 'content') return null;
    return parseNextStep(res.content);
  }
}

const CREATE_PLAN_SYSTEM =
  'You are the planner. Produce a COMPLETE, ordered plan to achieve the goal as ' +
  'a SINGLE JSON object: {"plan":[{"name":...,"instructions":...}, ...]}. Each ' +
  'step is one concrete action an executor performs against the LIVE SAP system ' +
  'using the available tools. Any fact about the system MUST be fetched with a ' +
  'tool — plan fetch steps; never answer from prior knowledge. Output JSON only.';

const REPLAN_SYSTEM =
  'You are the planner. A step just FAILED. Given the goal, the progress so far ' +
  '(fetched results + the failure), produce a REVISED plan for the REMAINING work ' +
  'as {"plan":[{"name":...,"instructions":...}, ...]}. If the goal is already ' +
  'satisfied despite the failure, return {"plan":[]}. Output JSON only.';

const EXTERNAL_RESULT_REPLAN_SYSTEM =
  'You are the planner. A NEW external tool result just arrived (see Progress) — ' +
  'this is NOT a failure. Given the goal and the progress (including the new ' +
  'result), produce a REVISED plan for the REMAINING work as ' +
  '{"plan":[{"name":...,"instructions":...}, ...]}. If the goal is already ' +
  'satisfied by the result, return {"plan":[]}. Output JSON only.';

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
      steps.push({
        name: s.name,
        instructions: s.instructions,
        ...(s.type ? { type: s.type } : {}),
      });
    }
    return steps;
  } catch {
    return null;
  }
}

export class AdaptivePlanner implements IControllerPlanner {
  // No budget field: replans are bounded by the loop's maxSteps (a failed step
  // bumps stepsUsed in runStep). Replan-specific budgeting is the deferred
  // "limits as a selectable strategy" work.
  constructor(private readonly planner: ISubagentClient) {}

  async next(input: PlannerNextInput): Promise<NextStep | null> {
    const {
      bundle,
      prompt,
      toolCatalog,
      lastOutcome,
      resumedExternal,
      retrying,
      logUsage,
    } = input;

    // 1. No plan yet → create it.
    if (!bundle.plan) {
      const plan = await this.callPlan(
        CREATE_PLAN_SYSTEM,
        bundle,
        prompt,
        toolCatalog,
        retrying,
        logUsage,
      );
      if (plan === null) return null; // format failure → handler retries
      bundle.plan = plan;
      bundle.planCursor = 0;
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 2. Previous step failed, OR an external-tool result just arrived → replan
    //    the remainder from the cursor. The planner reads plannerPrivate (which
    //    now holds the failure/external result), so the revised plan incorporates
    //    it — no reliance on the executor seeing it. Use the matching prompt: an
    //    external result is NOT a failure, so it gets its own framing.
    if (lastOutcome === 'failed' || resumedExternal) {
      const system = resumedExternal
        ? EXTERNAL_RESULT_REPLAN_SYSTEM
        : REPLAN_SYSTEM;
      const rest = await this.callPlan(
        system,
        bundle,
        prompt,
        toolCatalog,
        retrying,
        logUsage,
      );
      if (rest === null) return null;
      const cursor = bundle.planCursor ?? 0;
      bundle.plan = [...bundle.plan.slice(0, cursor), ...rest];
      return this.stepAtCursor(bundle, prompt, logUsage);
    }

    // 3. Otherwise emit the step at the cursor (or finalize). The cursor is
    //    advanced by commit() AFTER a step succeeds — NOT here — so the advance
    //    is persisted together with the step result (see Task 4), and a resume
    //    with lastOutcome=undefined continues from the next uncompleted step
    //    instead of repeating the last one.
    return this.stepAtCursor(bundle, prompt, logUsage);
  }

  /** Commit the just-finished step's outcome so the advance is persisted with it.
   *  On success the cursor moves to the next step; a failure leaves the cursor so
   *  the next next() can replan from it. (No LLM call — pure bookkeeping.) */
  commit(bundle: SessionBundle, outcome: 'advanced' | 'failed'): void {
    if (outcome === 'advanced') {
      bundle.planCursor = (bundle.planCursor ?? 0) + 1;
    }
  }

  /** Return the step at the cursor, or finalize → done when the plan is exhausted. */
  private async stepAtCursor(
    bundle: SessionBundle,
    prompt: string,
    logUsage?: (role: string, u?: LlmUsage) => void,
  ): Promise<NextStep> {
    const plan = bundle.plan ?? [];
    const cursor = bundle.planCursor ?? 0;
    if (cursor >= plan.length) {
      const res = await this.planner.send([
        { role: 'system', content: FINALIZE_SYSTEM },
        {
          role: 'user',
          content: `Goal: ${bundle.goal}\nRequest: ${prompt}\nProgress:${bundle.plannerPrivate}`,
        },
      ]);
      logUsage?.('finalizer', res.usage);
      return {
        kind: 'done',
        result: res.kind === 'content' ? res.content : 'completed',
      };
    }
    return { kind: 'next', step: plan[cursor] };
  }

  private async callPlan(
    system: string,
    bundle: SessionBundle,
    prompt: string,
    toolCatalog: string,
    retrying: boolean,
    logUsage?: (role: string, u?: LlmUsage) => void,
  ): Promise<Step[] | null> {
    const res = await this.planner.send([
      {
        role: 'system',
        content:
          system +
          (retrying
            ? '\nIMPORTANT: your previous reply was NOT valid JSON. Reply with ONLY the raw JSON object.'
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
    if (res.kind !== 'content') return null;
    return parsePlan(res.content);
  }
}

export function makePlanner(
  kind: PlannerKind,
  planner: ISubagentClient,
): IControllerPlanner {
  return kind === 'adaptive'
    ? new AdaptivePlanner(planner)
    : new IncrementalPlanner(planner);
}
