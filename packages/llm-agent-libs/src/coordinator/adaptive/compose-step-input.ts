import type {
  CheckStep,
  ITaskSpec,
  Message,
  StepRecord,
  WorkStep,
} from '@mcp-abap-adt/llm-agent';
import { renderTaskSpec } from '@mcp-abap-adt/llm-agent';

/** Compose worker context without truncation; map insertion order is plan order. */
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
    sections.push(
      `Result of ${id} (${record.status}):\n---\n${record.output}\n---`,
    );
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
      // Keep complete tool rounds between the user request and the final reply.
      if (assistant) history = args.history.slice(userIndex);
    }
  } else if (mode === 'all') {
    history = [...args.history];
  }
  if (step.kind === 'check' && step.worker !== 'self') {
    sections.push(
      'Return ONLY JSON: {"verdict":"pass|fail|partial","reason":"<one line>"}',
    );
  }
  return { task: sections.join('\n\n'), history };
}
