import type {
  EvaluatorRoute,
  EvaluatorVerdict,
  IEvaluator,
  IKnowledgeRagHandle,
  ILlm,
  ITaskSpec,
  IToolsRagHandle,
  RunIdentity,
} from '@mcp-abap-adt/llm-agent';
import { renderTaskSpec } from '@mcp-abap-adt/llm-agent';

/**
 * Task-agnostic Evaluator prompt. It judges the INPUT (the sub-prompt) against
 * the RAG context — NOT how to do the task. "What completeness means" comes from
 * the Known facts (the consumer's RAG skills); the prompt names no tools or
 * domain rules. The three routes ARE the recursion control: executable =
 * terminal, needs-work = recurse with gaps, needs-consumer = ask the human.
 */
export const EVALUATOR_SYSTEM = `You assess whether a TASK can be executed as stated, using ONLY the provided context. Do NOT perform the task. Decide ONE route:
- "executable": the task can be carried out unambiguously with what is already known (see "Known facts") or with a single available tool call. Nothing essential is missing.
- "needs-work": something essential is missing BUT it can be obtained by the agent — fetched via an available tool, or produced by decomposing/gathering first. List each missing item.
- "needs-consumer": something essential is missing that ONLY the human/consumer can resolve (a decision, or knowledge external to the system that no available tool can obtain). List the question(s).
Use "Known facts" to decide what "complete" means for this domain — e.g. if a review needs the COMPLETE artifact (all parts/sub-parts) and the facts show only a part is present, that is "needs-work" (fetch the rest). If an available tool could obtain the missing data, the route is "needs-work", NEVER "needs-consumer".
Respond with ONLY JSON: {"route":"executable|needs-work|needs-consumer","missing":["..."],"reason":"<one line>"}`;

const ROUTES: ReadonlySet<string> = new Set([
  'executable',
  'needs-work',
  'needs-consumer',
]);

export class LlmEvaluator implements IEvaluator {
  readonly name = 'llm-evaluator';
  readonly model?: string;
  private readonly systemPrompt: string;

  constructor(
    private readonly llm: ILlm,
    systemPrompt: string = EVALUATOR_SYSTEM,
  ) {
    this.model = llm.model;
    this.systemPrompt = systemPrompt;
  }

  async evaluate(input: {
    prompt: string;
    knowledgeRag: IKnowledgeRagHandle;
    toolsRag: IToolsRagHandle;
    taskSpec?: ITaskSpec;
    identity: RunIdentity;
    signal?: AbortSignal;
  }): Promise<EvaluatorVerdict> {
    const facts = await input.knowledgeRag.query(input.prompt, { k: 8 });
    const factBlock = facts.length
      ? `Known facts (already in the knowledge store):\n${facts
          .map(
            (f) => `- [${f.metadata.artifactType}] ${truncate(f.content, 400)}`,
          )
          .join('\n')}\n\n`
      : 'Known facts: (none yet)\n\n';

    let toolsBlock = '';
    try {
      const tools = await input.toolsRag.query(input.prompt, 15);
      if (tools.length > 0) {
        toolsBlock =
          `Available tools (the agent can call these to obtain data):\n` +
          tools
            .map((t) => `- ${t.name}: ${truncate(t.description ?? '', 200)}`)
            .join('\n') +
          '\n\n';
      }
    } catch {
      // toolsRag unavailable — omit gracefully (fewer obtainable options known)
    }

    const taskBlock = input.taskSpec
      ? `${renderTaskSpec(input.taskSpec)}\n\n`
      : '';

    const user = `${taskBlock}${factBlock}${toolsBlock}Task: ${input.prompt}`;

    const res = await this.llm.chat(
      [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: user },
      ] as never,
      [] as never,
      { signal: input.signal },
    );
    if (res.ok === false)
      throw new Error(
        `evaluator: ${(res as { error?: { message?: string } }).error?.message ?? 'llm error'}`,
      );
    return parseVerdict(
      (res as { ok: true; value: { content: string } }).value.content,
    );
  }
}

/** Parse the JSON verdict; tolerate code fences and stray prose around it.
 *  Defaults to a safe `needs-work` if the route is missing/unknown (never
 *  silently treat an unparseable answer as executable). */
export function parseVerdict(raw: string): EvaluatorVerdict {
  const json = extractJson(raw);
  const route =
    json && typeof json.route === 'string' && ROUTES.has(json.route)
      ? (json.route as EvaluatorRoute)
      : 'needs-work';
  const missing = Array.isArray(json?.missing)
    ? (json?.missing as unknown[]).filter(
        (m): m is string => typeof m === 'string',
      )
    : [];
  const reason =
    json && typeof json.reason === 'string' ? json.reason : undefined;
  return { route, missing, ...(reason ? { reason } : {}) };
}

function extractJson(s: string): Record<string, unknown> | undefined {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
