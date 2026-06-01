import type {
  DagPlan,
  IKnowledgeRagHandle,
  ILlm,
  IStepperPlanner,
  ITaskSpec,
  IToolsRagHandle,
  RunIdentity,
} from '@mcp-abap-adt/llm-agent';
import { renderTaskSpec } from '@mcp-abap-adt/llm-agent';
import { parseDagPlan } from '../dag/llm-dag-planner.js';

// NOTE (18.1): the 18.0 SOFT completeness clause was REMOVED here — the dedicated
// Evaluator now owns prompt/plan completeness (it judges WITH the RAG context and
// feeds the planner the named gaps as "Prerequisites to address FIRST"), so a
// completeness clause here would double-judge. If a deployment disables the
// Evaluator (`flow.evaluator.enabled: false`), supply thoroughness via a
// knowledgeSeed / planner.systemPrompt override instead.
export const STEPPER_PLANNER_SYSTEM = `You are a planner in a recursive Stepper hierarchy. Decompose the task into a SHALLOW DAG of steps.
RAG-FIRST: the "Known facts" section lists what is already in the shared knowledge store. If a fact you need is already there, DO NOT add a step to re-fetch it — use it. Only add a step to obtain information that is genuinely missing.
FETCHING IS THE EXECUTOR'S JOB — plan WORK, not granular fetches. A worker reads whatever its step needs (program source, includes, tables, metadata) at EXECUTION time via the available tools; do NOT decompose a task into many tiny fetch steps. Emit a separate "gather" step ONLY when its result must be SHARED by MULTIPLE later steps — and then emit ONE gather step they all "dependsOn" (fetched once, threaded to them), NEVER several fetch steps. (Use needInfo ONLY for a fact no listed tool can obtain — see below.)
DECOMPOSE TO CONCRETE LEAVES: if a task is achievable by ONE tool call, emit a single-step plan whose goal is that concrete leaf call — do NOT re-emit the parent's task verbatim (that causes infinite recursion). Each node spawns a fresh worker that does NOT share your context; over-decomposition multiplies cost.
DELEGATION: if an "Available workers" section is listed below, you MAY set a node's "agent" to one of those worker names to delegate a SUB-GOAL to that recursive worker (it will plan and execute the sub-goal itself). Omit "agent" for a concrete leaf you want executed directly. Only delegate when the sub-goal is a distinct unit of work that benefits from its own planning — otherwise emit a direct leaf.
DEPENDENCIES — DATAFLOW + ORDERING. A step receives another step's output ONLY if that step is in its "dependsOn"; steps WITHOUT dependsOn run in PARALLEL and do NOT see each other's data. THEREFORE: NEVER place in parallel two steps that depend on, build on, or read the SAME data — that is the most common planning error. If step B uses, refines, or overlaps step A, set B."dependsOn" = [A] so they run sequentially and A's output flows into B. Emit parallel (no-dependsOn) steps ONLY for GENUINELY INDEPENDENT, DISJOINT work. Prose like "using step 1" is NOT enough — encode it as dependsOn. When unsure whether two steps are independent, CHAIN them (sequential is safe; wrong parallelism re-fetches and races).
ONE READ PER ARTEFACT — discovery (list/shell to find what exists) and reading the bodies are SEQUENTIAL: the read step "dependsOn" the discovery; never two parallel steps that both fetch the same object.
Each node: {"id","goal","agent"(optional worker name),"dependsOn"(ids of steps whose OUTPUT this step needs)}.
Respond with ONLY one of:
{"objective":"...","nodes":[...]}
{"needInfo":"<query>"}  — ONLY for a fact that NO listed tool can obtain (e.g. a human decision, or knowledge external to the system). If a listed tool below could get it, plan a step instead.
{"clarify":"<question>"}  — you need a human decision before planning`;

/** Granularity directive appended to the planner system prompt — the eager
 *  decomposition knob (see DESIGN). 'shallow' defers detail to executors;
 *  'detailed' decomposes fully into concrete leaves up front. */
const GRANULARITY_DIRECTIVE = {
  shallow:
    '\nGRANULARITY: produce a SHALLOW plan — a few high-level steps; defer fine-grained detail to the executors that run each step.',
  detailed:
    '\nGRANULARITY: produce a DETAILED plan NOW — decompose fully into concrete, single-action leaf steps with explicit dependsOn; do not defer detail to the executors.',
} as const;

export class LlmStepperPlanner implements IStepperPlanner {
  readonly name = 'llm-stepper';
  readonly model?: string;
  private readonly granularity: 'shallow' | 'detailed';
  /** Base system prompt; a consumer may override STEPPER_PLANNER_SYSTEM via
   *  `coordinator.flow.planner.systemPrompt` (yaml) or the builder. The
   *  granularity directive is still appended to whatever base is used. */
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: ILlm,
    granularity: 'shallow' | 'detailed' = 'shallow',
    systemPrompt: string = STEPPER_PLANNER_SYSTEM,
  ) {
    this.model = llm.model;
    this.granularity = granularity;
    this.systemPrompt = systemPrompt;
  }

  async plan(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    parentPath: string[];
    identity: RunIdentity;
    agents?: ReadonlyArray<{ name: string; description?: string }>;
    taskSpec?: ITaskSpec;
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

    // 18.1 dedup manifest: the EXACT artefacts already fetched this run (by
    // identity, not lossy semantic top-k). The planner must NOT plan a step to
    // re-fetch any of these — backs the "RAG-FIRST: don't re-fetch" rule with a
    // hard lookup. Feature-detected (older handles omit it).
    let fetchedBlock = '';
    try {
      const arts = (await input.knowledgeRag.listArtifacts?.()) ?? [];
      if (arts.length > 0) {
        fetchedBlock =
          'Already fetched (DO NOT plan a step to re-fetch these — they are in the store):\n' +
          arts.map((a) => `- ${a.identityKey}`).join('\n') +
          '\n\n';
      }
    } catch {
      // listArtifacts unavailable / failed — omit the manifest gracefully
    }

    const agentsBlock =
      input.agents && input.agents.length > 0
        ? `Available workers (set a node's "agent" to delegate a sub-goal):\n${input.agents
            .map(
              (a) =>
                `- ${a.name}: ${truncate(a.description ?? '(no description)', 200)}`,
            )
            .join('\n')}\n\n`
        : '';

    // Overall-task anchor: every planner at every level sees the formalized
    // global task (with its constraints), not just its local sub-prompt.
    const taskBlock = input.taskSpec
      ? `${renderTaskSpec(input.taskSpec)}\n\n`
      : '';

    const user = `${taskBlock}${factBlock}${fetchedBlock}${toolsBlock}${agentsBlock}Task: ${input.prompt}`;

    const res = await this.llm.chat(
      [
        {
          role: 'system',
          content: `${this.systemPrompt}${GRANULARITY_DIRECTIVE[this.granularity]}`,
        },
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
