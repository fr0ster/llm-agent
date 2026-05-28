import type {
  DagPlan,
  ExecutionFailureInput,
  ExecutionReviewDecision,
  ILlm,
  IReviewStrategy,
  ReviewInput,
  ReviewVerdict,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';
import { renderAncestorContext } from './render-ancestor-context.js';

// Static critic instructions. The user prompt, plan and catalog are dynamic and
// go into the per-call `task` (see review()).
const REVIEWER_SYSTEM = `You are a plan reviewer. Given the user request, the available workers, and a proposed DAG plan, decide whether the plan can fulfil the request with those workers.
Respond with ONLY a JSON object:
{"pass": true}  — the plan is adequate
{"pass": false, "feedback": "<what is wrong or what must be clarified>"}  — otherwise
{"needInfo":"<query>"}  — if you need a reality fact to assess the plan (e.g. does table X exist?)
{"clarify":"<question>"}  — if you need a human decision before reviewing (e.g. overwrite ok?)`;

const EXECUTION_REVIEW_SYSTEM = `You are a recovery reviewer. A step of a DAG plan FAILED during execution. You are given the objective, the current plan, the execution trace (what already ran and its output — this reflects the CURRENT system state), the failed step id, and the error.
Decide recovery and respond with ONLY a JSON object:
{"action":"abort"}  — if recovery is not possible
{"action":"revise","plan":{"nodes":[{"id":"...","goal":"...","agent":"<worker or omit>","dependsOn":[],"needsInput":false}],"objective":"..."}}  — a NEW plan for the REMAINING objective.
{"needInfo":"<query>"}  — if you need a reality fact before deciding recovery
{"clarify":"<question>"}  — if you need a human decision before deciding recovery
The revised plan MUST treat the current state as the starting point: do not redo work already done (per the trace); if an artifact already exists, modify it instead of recreating it (idempotent/adaptive).`;

/**
 * Role adapter: owns a constrained `DirectLlmSubAgent` critic and turns its
 * string output into a typed `ReviewVerdict`.
 */
export class LlmReviewStrategy implements IReviewStrategy {
  readonly name = 'llm-review';
  /** Best-effort model identifier from the underlying ILlm (for logger
   *  attribution). May be undefined for ILlm impls that do not expose one. */
  readonly model?: string;
  private readonly agent: DirectLlmSubAgent;
  private readonly executionAgent: DirectLlmSubAgent;

  constructor(llm: ILlm) {
    this.model = llm.model;
    this.agent = new DirectLlmSubAgent('reviewer', llm, {
      systemPrompt: REVIEWER_SYSTEM,
      contextPolicy: 'optional',
    });
    this.executionAgent = new DirectLlmSubAgent('recovery-reviewer', llm, {
      systemPrompt: EXECUTION_REVIEW_SYSTEM,
      contextPolicy: 'optional',
    });
  }

  async review(input: ReviewInput): Promise<ReviewVerdict> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const contextPrefix = input.ancestorContext
      ? `${renderAncestorContext(input.ancestorContext)}\n\n`
      : '';
    const task = `${contextPrefix}User request:\n${input.prompt}\n\nAvailable workers:\n${
      catalog || '(none)'
    }\n\nProposed plan (JSON):\n${JSON.stringify(input.plan)}`;

    const res = await this.agent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
    });

    const match = res.output.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Reviewer output did not contain a JSON object: ${res.output.slice(0, 200)}`,
      );
    let parsed: {
      pass?: unknown;
      feedback?: unknown;
      needInfo?: unknown;
      clarify?: unknown;
    };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Reviewer output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (typeof parsed.needInfo === 'string' && parsed.needInfo.trim()) {
      throw new NeedInfoSignal(parsed.needInfo);
    }
    if (typeof parsed.clarify === 'string' && parsed.clarify.trim()) {
      throw new ClarifySignal(parsed.clarify);
    }
    if (typeof parsed.pass !== 'boolean') {
      throw new Error(
        `Reviewer verdict must have a boolean 'pass': ${match[0].slice(0, 200)}`,
      );
    }
    if (parsed.pass === false) {
      if (
        typeof parsed.feedback !== 'string' ||
        parsed.feedback.trim() === ''
      ) {
        throw new Error(
          `Reviewer rejection must include a non-empty 'feedback' string: ${match[0].slice(0, 200)}`,
        );
      }
      return { pass: false, feedback: parsed.feedback, usage: res.usage };
    }
    return { pass: true, usage: res.usage };
  }

  async reviewExecutionFailure(
    input: ExecutionFailureInput,
  ): Promise<ExecutionReviewDecision> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const traceText = input.trace
      .map((r) => `- ${r.nodeId} [${r.status}]: ${r.output || r.error || ''}`)
      .join('\n');
    const contextPrefix = input.ancestorContext
      ? `${renderAncestorContext(input.ancestorContext)}\n\n`
      : '';
    const task = `${contextPrefix}Objective: ${input.objective ?? '(none)'}\n\nAvailable workers:\n${
      catalog || '(none)'
    }\n\nCurrent plan (JSON):\n${JSON.stringify(input.plan)}\n\nExecution trace (current state):\n${
      traceText || '(nothing completed)'
    }\n\nFailed step: ${input.failedNodeId}\nError: ${input.error}`;

    const res = await this.executionAgent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
    });

    const match = res.output.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Recovery reviewer output did not contain a JSON object: ${res.output.slice(0, 200)}`,
      );
    let parsed: {
      action?: unknown;
      plan?: unknown;
      needInfo?: unknown;
      clarify?: unknown;
    };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Recovery reviewer output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (typeof parsed.needInfo === 'string' && parsed.needInfo.trim()) {
      throw new NeedInfoSignal(parsed.needInfo);
    }
    if (typeof parsed.clarify === 'string' && parsed.clarify.trim()) {
      throw new ClarifySignal(parsed.clarify);
    }
    if (parsed.action === 'abort') return { action: 'abort', usage: res.usage };
    if (parsed.action !== 'revise') {
      throw new Error(
        `Recovery reviewer action must be 'abort' | 'revise': ${match[0].slice(0, 200)}`,
      );
    }
    const plan = parsed.plan as { nodes?: unknown } | undefined;
    if (
      !plan ||
      !Array.isArray(plan.nodes) ||
      plan.nodes.length === 0 ||
      plan.nodes.some(
        (n) =>
          typeof (n as { id?: unknown }).id !== 'string' ||
          typeof (n as { goal?: unknown }).goal !== 'string' ||
          ((n as { goal?: string }).goal ?? '').trim() === '',
      )
    ) {
      throw new Error(
        `Recovery reviewer revise plan must have non-empty nodes with string id+goal: ${match[0].slice(0, 200)}`,
      );
    }
    return { action: 'revise', revisedPlan: plan as DagPlan, usage: res.usage };
  }
}
