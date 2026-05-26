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
    let parsed: {
      objective?: string;
      rationale?: string;
      nodes?: Array<{
        id?: string;
        goal?: string;
        agent?: string;
        dependsOn?: string[];
        needsInput?: boolean;
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
    const nodes: PlanNode[] = parsed.nodes.map((n, i) => {
      if (typeof n.goal !== 'string' || n.goal.trim() === '') {
        throw new Error(`Planner node is missing a goal: ${JSON.stringify(n)}`);
      }
      return {
        id: n.id ?? `n${i + 1}`,
        goal: n.goal,
        agent: n.agent,
        dependsOn: n.dependsOn,
        needsInput: n.needsInput,
      };
    });
    return {
      nodes,
      objective: parsed.objective,
      rationale: parsed.rationale,
      createdAt: Date.now(),
    };
  }
}
