import type {
  IBriefing,
  ICoordinatorContext,
  PlanStep,
  StepResult,
} from '@mcp-abap-adt/llm-agent';

const KNOWN_OUTPUT_MAX = 300;

/**
 * Distill `ICoordinatorContext.stepResults` into a structured briefing for
 * the upcoming `currentStep`. Successful steps with usable output become
 * `known[]`. Failed steps and successful steps with empty output become
 * `tried[]` — the dead-ends section that tells the subagent NOT to repeat
 * these approaches.
 *
 * The current step itself is excluded (in case a retry has left a prior
 * StepResult under the same id).
 */
export function buildBriefingFromContext(
  currentStep: PlanStep,
  ctx: ICoordinatorContext,
): IBriefing {
  const known: string[] = [];
  const tried: string[] = [];

  // Preserve plan order when iterating (Object.values order is insertion
  // order, but plan order is the authoritative sequence).
  const planOrder = ctx.plan?.steps.map((s) => s.id) ?? [];
  const orderedIds =
    planOrder.length > 0
      ? planOrder.filter((id) => id in ctx.stepResults)
      : Object.keys(ctx.stepResults);

  for (const id of orderedIds) {
    if (id === currentStep.id) continue;
    const r = ctx.stepResults[id] as StepResult | undefined;
    if (!r) continue;
    const stepGoal =
      ctx.plan?.steps.find((s) => s.id === id)?.goal ?? '(no goal)';

    if (!r.ok) {
      tried.push(
        `${id} (${stepGoal}) — failed: ${r.error ?? 'unknown error'}`,
      );
      continue;
    }

    const trimmed = r.output.trim();
    if (trimmed.length === 0) {
      tried.push(`${id} (${stepGoal}) — completed but produced no usable output`);
      continue;
    }

    const snippet =
      trimmed.length > KNOWN_OUTPUT_MAX
        ? `${trimmed.slice(0, KNOWN_OUTPUT_MAX)}…`
        : trimmed;
    known.push(`${id} (${stepGoal}): ${snippet}`);
  }

  return {
    goal: ctx.inputText,
    known,
    tried,
  };
}
