import type {
  DagPlan,
  ILlm,
  IPlanner,
  LlmUsage,
  PlanNode,
  PlannerInput,
  PlannerResult,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';
import { renderAncestorContext } from './render-ancestor-context.js';

/**
 * Attach LLM usage to a thrown Error so the coordinator's runRole catch can
 * still bill the spend (HIGH/MEDIUM finding: parse-/shape-error paths went
 * through `throw new Error(...)` and the captured `res.usage` was lost — yet
 * the LLM call WAS made and tokens WERE spent). Plain Errors with a `usage`
 * property work in JS without subclassing; runRole reads it via a type cast.
 */
function withUsage(err: Error, usage: LlmUsage | undefined): Error {
  if (usage) (err as Error & { usage?: LlmUsage }).usage = usage;
  return err;
}

// Static planner instructions. The agent catalog and user prompt are NOT here —
// they are dynamic and go into the per-call `task` (see plan()).
export const PLANNER_SYSTEM = `You are a planner. Decompose the user request into a DAG of tasks.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids),"needsInput"(optional bool)}.
Use "dependsOn" to express order/data-flow; independent nodes run in parallel.

DECOMPOSITION COST. Each node spawns a fresh worker pipeline. Workers
DO NOT share fetched data, tools, or context across nodes — every node
pays the full classify + RAG + tool-loop overhead again, and any
source / configuration / table data already fetched by a previous
node will be re-fetched. Over-decomposition is the most common cause
of large token bills. Decompose ONLY when:
- nodes target DIFFERENT objects (e.g. compare program A vs program B),
- nodes can TRULY run in parallel for wall-clock speedup, or
- a later node depends on a fact ONLY discoverable by an earlier node.

For analysing a SINGLE object along multiple dimensions (e.g. "review
program X for security, performance, clean-core, maintainability") use
ONE node — the worker covers every dimension in one tool-loop.

Emit a plan-level "objective". Respond with ONLY one of:
{"objective":"...","nodes":[{"id":"n1","goal":"...","agent":"<worker name or omit>","dependsOn":[],"needsInput":false}]}
{"needInfo":"<query>"}  — if you need a reality fact before planning (e.g. which table exists)
{"clarify":"<question>"}  — if you need a human decision before planning (e.g. overwrite ok?)`;

/**
 * Parse a raw LLM content string into a `DagPlan`.
 * Throws `NeedInfoSignal`, `ClarifySignal`, or plain `Error` on bad input.
 * The optional `usage` argument is attached to thrown errors so callers can
 * still bill LLM spend even when parsing fails.
 */
export function parseDagPlan(content: string, usage?: LlmUsage): DagPlan {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match)
    throw withUsage(
      new Error(
        `Planner output did not contain a JSON object: ${content.slice(0, 200)}`,
      ),
      usage,
    );
  let parsed: {
    objective?: unknown;
    rationale?: unknown;
    needInfo?: unknown;
    clarify?: unknown;
    nodes?: Array<{
      id?: unknown;
      goal?: unknown;
      agent?: unknown;
      dependsOn?: unknown;
      needsInput?: unknown;
    }>;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw withUsage(
      new Error(
        `Planner output contained malformed JSON: ${match[0].slice(0, 200)}`,
      ),
      usage,
    );
  }
  if (typeof parsed.needInfo === 'string' && parsed.needInfo.trim()) {
    throw new NeedInfoSignal(parsed.needInfo, usage);
  }
  if (typeof parsed.clarify === 'string' && parsed.clarify.trim()) {
    throw new ClarifySignal(parsed.clarify, usage);
  }
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw withUsage(
      new Error(`Planner returned no nodes: ${match[0].slice(0, 200)}`),
      usage,
    );
  }
  if (parsed.objective !== undefined && typeof parsed.objective !== 'string') {
    throw withUsage(
      new Error(
        `Planner objective must be a string: ${JSON.stringify(parsed.objective)}`,
      ),
      usage,
    );
  }
  if (parsed.rationale !== undefined && typeof parsed.rationale !== 'string') {
    throw withUsage(
      new Error(
        `Planner rationale must be a string: ${JSON.stringify(parsed.rationale)}`,
      ),
      usage,
    );
  }
  const nodes: PlanNode[] = parsed.nodes.map((n, i) => {
    if (typeof n.goal !== 'string' || n.goal.trim() === '') {
      throw withUsage(
        new Error(`Planner node is missing a goal: ${JSON.stringify(n)}`),
        usage,
      );
    }
    if (n.id !== undefined && typeof n.id !== 'string') {
      throw withUsage(
        new Error(`Planner node has a non-string id: ${JSON.stringify(n)}`),
        usage,
      );
    }
    if (n.agent !== undefined && typeof n.agent !== 'string') {
      throw withUsage(
        new Error(`Planner node has a non-string agent: ${JSON.stringify(n)}`),
        usage,
      );
    }
    if (
      n.dependsOn !== undefined &&
      (!Array.isArray(n.dependsOn) ||
        n.dependsOn.some((d) => typeof d !== 'string'))
    ) {
      throw withUsage(
        new Error(
          `Planner node dependsOn must be an array of strings: ${JSON.stringify(n)}`,
        ),
        usage,
      );
    }
    if (n.needsInput !== undefined && typeof n.needsInput !== 'boolean') {
      throw withUsage(
        new Error(
          `Planner node needsInput must be a boolean: ${JSON.stringify(n)}`,
        ),
        usage,
      );
    }
    return {
      id: (n.id as string | undefined) ?? `n${i + 1}`,
      goal: n.goal,
      agent: n.agent as string | undefined,
      dependsOn: n.dependsOn as string[] | undefined,
      needsInput: n.needsInput as boolean | undefined,
    };
  });
  return {
    nodes,
    objective: parsed.objective as string | undefined,
    rationale: parsed.rationale as string | undefined,
    createdAt: Date.now(),
  };
}

/**
 * Role adapter: owns a constrained `DirectLlmSubAgent` and turns its string
 * output into a typed `DagPlan`. (Slice 2: planner now flows through the one
 * ISubAgent path instead of calling ILlm directly.)
 */
export class LlmDagPlanner implements IPlanner {
  readonly name = 'llm-dag';
  /** Best-effort model identifier from the underlying ILlm (for logger
   *  attribution). May be undefined for ILlm impls that do not expose one. */
  readonly model?: string;
  private readonly agent: DirectLlmSubAgent;

  constructor(llm: ILlm) {
    this.model = llm.model;
    this.agent = new DirectLlmSubAgent('planner', llm, {
      systemPrompt: PLANNER_SYSTEM,
      contextPolicy: 'optional',
    });
  }

  async plan(input: PlannerInput): Promise<PlannerResult> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const contextPrefix: string[] = [];
    if (input.ancestorContext) {
      const rendered = renderAncestorContext(input.ancestorContext);
      if (rendered) contextPrefix.push(rendered);
    }
    if (input.reviewerFeedback) {
      contextPrefix.push(`Reviewer feedback: ${input.reviewerFeedback}`);
    }
    const prefix =
      contextPrefix.length > 0 ? `${contextPrefix.join('\n\n')}\n\n` : '';
    const task = `${prefix}Available workers:\n${catalog || '(none)'}\n\n${input.prompt}`;

    const res = await this.agent.run({
      task,
      sessionId: input.sessionId,
      signal: input.signal,
    });

    // parseDagPlan throws NeedInfoSignal / ClarifySignal / parse errors,
    // forwarding res.usage so the coordinator can attribute planner-LLM spend
    // even when the role short-circuits.
    const plan = parseDagPlan(res.output, res.usage);
    return {
      plan,
      // Forward the underlying ILlm.chat usage on the WRAPPER (not on the
      // plan itself) so the coordinator can attribute planner-LLM spend to
      // the session/request logger without polluting the plan domain type
      // (which the reviewer serializes via JSON.stringify into its prompt).
      usage: res.usage,
    };
  }
}
