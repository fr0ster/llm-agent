import type {
  AdaptiveStep,
  ControllerPlanInput,
  IAdaptiveController,
  ILlm,
  LlmUsage,
} from '@mcp-abap-adt/llm-agent';
import { HISTORY_MESSAGE_LIMIT } from './compose-step-input.js';
import { lastObject, parsePlan, parseVerdict } from './parse-plan.js';

/** Planning instructions shared by the default adaptive controller. */
export const ADAPTIVE_CONTROLLER_SYSTEM: string = `You control a sequential adaptive plan. Size the plan to the request.
For small talk or anything needing no worker, return a single answer with text.
For simple requests, use one work step plus answer. Only complex/declarative tasks need spec.
For complex tasks, place checks with verdict branches, fix steps, revise and ask where useful.
Write every text meant for the user (answer text, ask question) in the language of the request.
Respond with JSON only: {"spec"?:{"objective":"...","scope"?:"...","constraints"?:["..."],"deliverable"?:"...","raw"?:"original request"},"steps":[...]}.
Here ? marks an optional field; omit it in real JSON. Step shapes (use exactly these field names):
work: {"id":"...","kind":"work","goal":"...","worker":"registered name","context"?:{...},"maxRuns"?:1}
check: {"id":"...","kind":"check","goal":"...","worker":"registered name or self","targets":["step id"],"context"?:{...},"onPass":"target","onFail":"target","onPartial"?:"target","maxRuns"?:3}
ask: {"id":"...","kind":"ask","question":"..."}
revise: {"id":"...","kind":"revise","reason":"...","maxRuns"?:1}
answer: {"id":"...","kind":"answer","from"?:"step id","text"?:"literal answer"}
Answer requires exactly one of from or text. Set from to the step whose output IS the final answer.
All ids must be unique. next and end are reserved: never use them as ids.
Check branches target next (following step), end (stop), or a step id (jump, including backwards).
Without onPartial, partial follows onFail. Without an answer, ending produces a stop report.
Only check branches jump; all other steps proceed sequentially. ask ends the turn with its question.
Use worker:"self" only for controller-run checks judged by reading; use a registered worker for tool-based checks.
Each check reviews targets and returns pass/fail/partial with a reason. A fix receives the branching check's reason.
maxRuns is an integer 1..5 for work/check/revise; defaults: work/revise 1, check 3; ask/answer run once.
Give every revisited work step a sufficient maxRuns. Bounded check branches enable fix/recheck loops.
The controller selects each work/check input with context: {"spec"?:true,"history"?:"none|last-turn|all","results"?:["step id"],"note"?:"extra instruction"}.
context.spec includes the spec by default; false omits it. history selects conversation (default all, bounded).
results selects needed step outputs; checks also receive targets. note adds a step-specific instruction.
The request and goal always reach the worker. Select only context needed for that step.
revise replaces only the remaining steps using the plan and results; executed ids cannot be reused.
ask is for missing information. After it, the next request is planned in dialogue with the user.
When previousRun exists, inspect its request, plan, results, verdicts, outcome and stopReason.
With the user's new request, decide whether to continue, adjust or start over; do not blindly resume.
Simple one-work-step example (executor must be registered):
{"steps":[{"id":"exec","kind":"work","goal":"Explain this object","worker":"executor"},{"id":"answer","kind":"answer","from":"exec"}]}
Create/check/fix/recheck example (executor must be registered):
{"spec":{"objective":"Create a correct draft"},"steps":[{"id":"create","kind":"work","goal":"Create draft","worker":"executor"},{"id":"check","kind":"check","goal":"Review draft","worker":"self","targets":["create"],"onPass":"answer","onFail":"fix"},{"id":"fix","kind":"work","goal":"Fix draft using review","worker":"executor","context":{"results":["create","check"]},"maxRuns":3},{"id":"recheck","kind":"check","goal":"Review fixed draft","worker":"self","targets":["fix"],"onPass":"fixedAnswer","onFail":"fix","maxRuns":3},{"id":"fixedAnswer","kind":"answer","from":"fix"},{"id":"answer","kind":"answer","from":"create"}]}`;

function withUsage(error: Error, usage?: LlmUsage): Error {
  if (usage) (error as Error & { usage?: LlmUsage }).usage = usage;
  return error;
}

/** An ILlm-backed planner and reviewer; execution and fallback stay with callers. */
export class LlmAdaptiveController implements IAdaptiveController {
  readonly name = 'llm-adaptive';
  readonly model?: string;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: ILlm,
    opts?: { systemPrompt?: string },
  ) {
    this.model = llm.model;
    this.systemPrompt = opts?.systemPrompt ?? ADAPTIVE_CONTROLLER_SYSTEM;
  }

  private async chat(system: string, content: string, signal?: AbortSignal) {
    const result = await this.llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
      undefined,
      { signal },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async plan(input: ControllerPlanInput) {
    const history = input.history
      .slice(-HISTORY_MESSAGE_LIMIT)
      .map((message) => ({
        role: message.role,
        content: message.content?.slice(0, 1000) ?? null,
      }));
    const previousRun = input.previousRun && {
      request: input.previousRun.request,
      plan: input.previousRun.plan,
      outcome: input.previousRun.outcome,
      stopReason: input.previousRun.stopReason,
      steps: input.previousRun.steps.map((record) => ({
        id: record.stepId,
        kind: record.kind,
        status: record.status,
        verdict: record.verdict,
        output: record.output.slice(0, 500),
      })),
    };
    const response = await this.chat(
      this.systemPrompt,
      [
        `Workers:\n${input.workers.map((worker) => `${worker.name}: ${worker.description ?? ''}`).join('\n')}`,
        `Conversation:\n${JSON.stringify(history)}`,
        `Previous run:\n${JSON.stringify(previousRun ?? null)}`,
        `Current request:\n${input.request}`,
      ].join('\n\n'),
      input.signal,
    );
    const parsed = parsePlan(response.content, {
      workers: input.workers.map((worker) => worker.name),
    });
    if (!parsed.ok) throw withUsage(new Error(parsed.error), response.usage);
    return { plan: parsed.value, usage: response.usage };
  }

  async check(input: Parameters<IAdaptiveController['check']>[0]) {
    const { signal, ...context } = input;
    const response = await this.chat(
      'Judge the target records against the request, spec and check goal. Return JSON only: {"verdict":"pass|fail|partial","reason":"..."}.',
      JSON.stringify(context),
      signal,
    );
    const verdict = parseVerdict(response.content);
    if (!verdict)
      throw withUsage(new Error('Unparsable verdict'), response.usage);
    return { verdict, usage: response.usage };
  }

  async revise(input: Parameters<IAdaptiveController['revise']>[0]) {
    const { signal, ...context } = input;
    const response = await this.chat(
      `${this.systemPrompt}\nFor this call return {"steps":[...]} with steps for the remainder only. Do not reuse executed ids in records or the current revise step's id. References may use retained step ids.`,
      JSON.stringify(context),
      signal,
    );
    let parsed: unknown;
    try {
      parsed = lastObject(response.content);
    } catch (error) {
      throw withUsage(
        error instanceof Error ? error : new Error(String(error)),
        response.usage,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('steps' in parsed) ||
      !Array.isArray(parsed.steps)
    ) {
      throw withUsage(
        new Error('Revision requires a steps array'),
        response.usage,
      );
    }
    // The interpreter validates workers, references, and taken ids before execution.
    return { steps: parsed.steps as AdaptiveStep[], usage: response.usage };
  }

  async report(input: Parameters<IAdaptiveController['report']>[0]) {
    const { signal, ...context } = input;
    const response = await this.chat(
      "Report in plain text in the request's language: what was done, what was not, and why the run stopped. Ground claims in the records; do not present unfinished work as complete.",
      JSON.stringify(context),
      signal,
    );
    return { text: response.content, usage: response.usage };
  }
}
