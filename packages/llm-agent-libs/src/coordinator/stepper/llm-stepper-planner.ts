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
DECOMPOSE TO CONCRETE LEAVES: if a task is achievable by ONE tool call, emit a single-step plan whose goal is that concrete leaf call — do NOT re-emit the parent's task verbatim (that causes infinite recursion). Each node spawns a fresh worker that does NOT share your context; over-decomposition multiplies cost.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(optional ids)}.
Respond with ONLY one of:
{"objective":"...","nodes":[...]}
{"needInfo":"<query>"}  — you need a reality fact before planning
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
    const user = `${factBlock}Task: ${input.prompt}`;

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
