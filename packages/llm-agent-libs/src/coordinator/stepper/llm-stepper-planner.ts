import type {
  DagPlan,
  IKnowledgeRagHandle,
  ILlm,
  IStepperPlanner,
  IToolsRagHandle,
  RunIdentity,
} from '@mcp-abap-adt/llm-agent';
import { parseDagPlan } from '../dag/llm-dag-planner.js';

export const STEPPER_PLANNER_SYSTEM = `You are a planner in a recursive Stepper hierarchy. Decompose the task into a SHALLOW DAG of steps.
RAG-FIRST: the "Known facts" section lists what is already in the shared knowledge store. If a fact you need is already there, DO NOT add a step to re-fetch it — use it. Only add a step to obtain information that is genuinely missing.
FETCH STEPS — NOT needInfo: Workers can read the live system by calling the tools listed in the "Available tools" section below. For ANY data a worker could fetch (program source, includes, table contents, object metadata, search results), emit a fetch STEP whose goal names the fetch — NEVER use needInfo for fetchable data.
DECOMPOSE TO CONCRETE LEAVES: if a task is achievable by ONE tool call, emit a single-step plan whose goal is that concrete leaf call — do NOT re-emit the parent's task verbatim (that causes infinite recursion). Each node spawns a fresh worker that does NOT share your context; over-decomposition multiplies cost.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids)}.
Respond with ONLY one of:
{"objective":"...","nodes":[...]}
{"needInfo":"<query>"}  — ONLY for a fact that NO listed tool can obtain (e.g. a human decision, or knowledge external to the system). If a listed tool below could get it, plan a step instead.
{"clarify":"<question>"}  — you need a human decision before planning`;

export class LlmStepperPlanner implements IStepperPlanner {
  readonly name = 'llm-stepper';
  readonly model?: string;

  constructor(private readonly llm: ILlm) {
    this.model = llm.model;
  }

  async plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<DagPlan> {
    const facts = await input.knowledgeRag.query(input.prompt, { k: 8 });
    const factBlock = facts.length
      ? `Known facts (already in the knowledge store):\n${facts.map((f) => `- [${f.metadata.artifactType}] ${truncate(f.content, 400)}`).join('\n')}\n\n`
      : 'Known facts: (none yet)\n\n';

    let toolsBlock = '';
    try {
      const tools = await input.toolsRag.query(input.prompt, 15);
      if (tools.length > 0) {
        toolsBlock =
          `Available tools (workers can call these to FETCH data):\n` +
          tools
            .map((t) => `- ${t.name}: ${truncate(t.description, 200)}`)
            .join('\n') +
          '\n\n';
      }
    } catch {
      // toolsRag unavailable — omit the section gracefully
    }

    const user = `${factBlock}${toolsBlock}Task: ${input.prompt}`;

    const res = await this.llm.chat(
      [
        { role: 'system', content: STEPPER_PLANNER_SYSTEM },
        { role: 'user', content: user },
      ] as never,
      [] as never,
      { signal: input.signal },
    );
    if (res.ok === false)
      throw new Error(
        `stepper planner: ${(res as { error?: { message?: string } }).error?.message ?? 'llm error'}`,
      );
    return parseDagPlan(
      (res as { ok: true; value: { content: string } }).value.content,
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
