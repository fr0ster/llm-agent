import type {
  CheckStep,
  ITaskSpec,
  Message,
  StepRecord,
  WorkStep,
} from '@mcp-abap-adt/llm-agent';
import { renderTaskSpec } from '@mcp-abap-adt/llm-agent';

/** Maximum characters included from each worker result. */
export const RESULT_CHAR_LIMIT = 8000;
/** Maximum conversation messages passed to a worker. */
export const HISTORY_MESSAGE_LIMIT = 20;

/** Compose bounded worker context; latest map insertion order is plan order. */
export function composeStepInput(args: {
  request: string;
  spec?: ITaskSpec;
  step: WorkStep | CheckStep;
  latest: ReadonlyMap<string, StepRecord>;
  history: readonly Message[];
  checkReason?: { checkId: string; reason: string };
}): { task: string; history: Message[] } {
  const { request, spec, step, latest, checkReason } = args;
  const context = step.context;
  const sections = [`Request:\n${request}`];
  if (spec && context?.spec !== false)
    sections.push(`Spec:\n${renderTaskSpec(spec)}`);
  sections.push(`Step:\n${step.goal}`);
  const selected = new Set([
    ...(context?.results ?? []),
    ...(step.kind === 'check' ? step.targets : []),
  ]);
  for (const [id, record] of latest) {
    if (!selected.has(id)) continue;
    let output = record.output;
    if (output.length > RESULT_CHAR_LIMIT) {
      output = `${output.slice(0, RESULT_CHAR_LIMIT)}\n[cut: ${output.length - RESULT_CHAR_LIMIT} characters omitted]`;
    }
    sections.push(`Result of ${id} (${record.status}):\n---\n${output}\n---`);
  }
  if (checkReason)
    sections.push(
      `Previous check ${checkReason.checkId} said:\n${checkReason.reason}`,
    );
  if (context?.note !== undefined) sections.push(`Note:\n${context.note}`);

  let history: Message[] = [];
  const mode = context?.history ?? 'all';
  if (mode === 'last-turn') {
    let userIndex = args.history.length - 1;
    while (userIndex >= 0 && args.history[userIndex]?.role !== 'user')
      userIndex--;
    if (userIndex >= 0) {
      const assistant = args.history
        .slice(userIndex + 1)
        .find((message) => message.role === 'assistant');
      const user = args.history[userIndex];
      if (user && assistant) history = [user, assistant];
    }
  } else if (mode === 'all') {
    history = args.history.slice(-HISTORY_MESSAGE_LIMIT);
    const omitted = args.history.length - history.length;
    if (omitted > 0)
      sections.push(`[conversation cut: ${omitted} earlier messages omitted]`);
  }
  if (step.kind === 'check' && step.worker !== 'self') {
    sections.push(
      'Return ONLY JSON: {"verdict":"pass|fail|partial","reason":"<one line>"}',
    );
  }
  return { task: sections.join('\n\n'), history };
}
