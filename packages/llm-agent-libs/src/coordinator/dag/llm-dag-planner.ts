import type {
  ILlm,
  IPlanner,
  PlanNode,
  PlannerInput,
  PlannerResult,
} from '@mcp-abap-adt/llm-agent';
import { ClarifySignal, NeedInfoSignal } from '@mcp-abap-adt/llm-agent';
import { DirectLlmSubAgent } from '../../subagent/direct-llm-subagent.js';
import { renderAncestorContext } from './render-ancestor-context.js';

// Static planner instructions. The agent catalog and user prompt are NOT here —
// they are dynamic and go into the per-call `task` (see plan()).
const PLANNER_SYSTEM = `You are a planner. Decompose the user request into a DAG of tasks.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids),"needsInput"(optional bool)}.
Use "dependsOn" to express order/data-flow; independent nodes run in parallel.
If the request needs no decomposition, emit a SINGLE node.
Emit a plan-level "objective". Respond with ONLY one of:
{"objective":"...","nodes":[{"id":"n1","goal":"...","agent":"<worker name or omit>","dependsOn":[],"needsInput":false}]}
{"needInfo":"<query>"}  — if you need a reality fact before planning (e.g. which table exists)
{"clarify":"<question>"}  — if you need a human decision before planning (e.g. overwrite ok?)`;

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
    const content = res.output;

    const match = content.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Planner output did not contain a JSON object: ${content.slice(0, 200)}`,
      );
    // Field values come straight from untrusted JSON, so they are typed as
    // `unknown` and validated below before being narrowed to PlanNode.
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
      throw new Error(
        `Planner output contained malformed JSON: ${match[0].slice(0, 200)}`,
      );
    }
    if (typeof parsed.needInfo === 'string' && parsed.needInfo.trim()) {
      // Forward LLM usage on the signal path so the coordinator can attribute
      // planner spend even when the role short-circuits with a signal (HIGH
      // finding: signal paths previously discarded the captured `res.usage`).
      throw new NeedInfoSignal(parsed.needInfo, res.usage);
    }
    if (typeof parsed.clarify === 'string' && parsed.clarify.trim()) {
      throw new ClarifySignal(parsed.clarify, res.usage);
    }
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error(`Planner returned no nodes: ${match[0].slice(0, 200)}`);
    }
    if (
      parsed.objective !== undefined &&
      typeof parsed.objective !== 'string'
    ) {
      throw new Error(
        `Planner objective must be a string: ${JSON.stringify(parsed.objective)}`,
      );
    }
    if (
      parsed.rationale !== undefined &&
      typeof parsed.rationale !== 'string'
    ) {
      throw new Error(
        `Planner rationale must be a string: ${JSON.stringify(parsed.rationale)}`,
      );
    }
    const nodes: PlanNode[] = parsed.nodes.map((n, i) => {
      if (typeof n.goal !== 'string' || n.goal.trim() === '') {
        throw new Error(`Planner node is missing a goal: ${JSON.stringify(n)}`);
      }
      if (n.id !== undefined && typeof n.id !== 'string') {
        throw new Error(
          `Planner node has a non-string id: ${JSON.stringify(n)}`,
        );
      }
      if (n.agent !== undefined && typeof n.agent !== 'string') {
        throw new Error(
          `Planner node has a non-string agent: ${JSON.stringify(n)}`,
        );
      }
      if (
        n.dependsOn !== undefined &&
        (!Array.isArray(n.dependsOn) ||
          n.dependsOn.some((d) => typeof d !== 'string'))
      ) {
        throw new Error(
          `Planner node dependsOn must be an array of strings: ${JSON.stringify(n)}`,
        );
      }
      if (n.needsInput !== undefined && typeof n.needsInput !== 'boolean') {
        throw new Error(
          `Planner node needsInput must be a boolean: ${JSON.stringify(n)}`,
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
      plan: {
        nodes,
        objective: parsed.objective as string | undefined,
        rationale: parsed.rationale as string | undefined,
        createdAt: Date.now(),
      },
      // Forward the underlying ILlm.chat usage on the WRAPPER (not on the
      // plan itself) so the coordinator can attribute planner-LLM spend to
      // the session/request logger without polluting the plan domain type
      // (which the reviewer serializes via JSON.stringify into its prompt).
      usage: res.usage,
    };
  }
}
