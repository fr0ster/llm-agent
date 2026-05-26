import type {
  DagPlan,
  ILlm,
  IPlanner,
  PlanNode,
  PlannerInput,
} from '@mcp-abap-adt/llm-agent';

/**
 * MVP exception (slice 1): calls the ILlm directly rather than wrapping a
 * supervised planner ISubAgent. The IPlanner interface is the stable seam;
 * moving onto the ISubAgent supervision path is deferred to the slice that
 * introduces supervision/restart.
 */
export class LlmDagPlanner implements IPlanner {
  readonly name = 'llm-dag';
  constructor(private readonly llm: ILlm) {}

  async plan(input: PlannerInput): Promise<DagPlan> {
    const catalog = input.agents
      .map((a) => `- ${a.name}: ${a.description ?? '(no description)'}`)
      .join('\n');
    const system = `You are a planner. Decompose the user request into a DAG of tasks.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids),"needsInput"(optional bool)}.
Use "dependsOn" to express order/data-flow; independent nodes run in parallel.
If the request needs no decomposition, emit a SINGLE node.
Emit a plan-level "objective". Respond with ONLY:
{"objective":"...","nodes":[{"id":"n1","goal":"...","agent":"<worker name or omit>","dependsOn":[],"needsInput":false}]}

Available workers:
${catalog || '(none)'}`;

    const res = await this.llm.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      [],
      { signal: input.signal, sessionId: input.sessionId },
    );
    if (!res.ok) throw res.error;

    const match = res.value.content.match(/\{[\s\S]*\}/);
    if (!match)
      throw new Error(
        `Planner output did not contain a JSON object: ${res.value.content.slice(0, 200)}`,
      );
    // Field values come straight from untrusted JSON, so they are typed as
    // `unknown` and validated below before being narrowed to PlanNode.
    let parsed: {
      objective?: unknown;
      rationale?: unknown;
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
    if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
      throw new Error(`Planner returned no nodes: ${match[0].slice(0, 200)}`);
    }
    // Plan-level fields also come from untrusted JSON — reject non-string values
    // rather than leaking them into the typed DagPlan.
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
      // Reject malformed field types up front — the interpreter relies on these
      // matching the exported PlanNode shape (otherwise they surface as opaque
      // TypeErrors mid-dispatch).
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
      nodes,
      objective: parsed.objective as string | undefined,
      rationale: parsed.rationale as string | undefined,
      createdAt: Date.now(),
    };
  }
}
