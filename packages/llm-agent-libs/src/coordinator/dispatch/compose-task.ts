import type { ICoordinatorContext, PlanStep } from '@mcp-abap-adt/llm-agent';
import { resolveTemplate } from '../../util/template.js';

/**
 * Deterministically compose the executor `task` from the planner's structured
 * intent. The planner decides (goal, plan objective, needsInput); this helper
 * assembles the final string with no LLM involvement, so client material is
 * inserted verbatim and losslessly.
 *
 * - `step.inputTemplate` (advanced override) wins and is resolved as-is.
 * - No-regression path: when there is no objective and no needsInput (and no
 *   template), the task reduces to the bare `step.goal` — unchanged behavior.
 * - Otherwise: "Task: <goal>", then "Overall objective: <objective>" when the
 *   plan carries one, then the client request as delimited data when
 *   `step.needsInput` is true.
 */
export function composeTask(step: PlanStep, ctx: ICoordinatorContext): string {
  if (step.inputTemplate) {
    const renderCtx: Record<string, unknown> = {
      goal: step.goal,
      objective: ctx.plan?.objective ?? '',
      inputText: ctx.inputText,
      stepResults: ctx.stepResults,
      step,
    };
    return resolveTemplate(step.inputTemplate, renderCtx);
  }

  const objective = ctx.plan?.objective;

  // No-regression path: nothing to compose → bare goal (unchanged behavior).
  if (!objective && !step.needsInput) {
    return step.goal;
  }

  const parts: string[] = [`Task: ${step.goal}`];
  if (objective) {
    parts.push(`Overall objective: ${objective}`);
  }
  if (step.needsInput) {
    parts.push(`Input (user-provided data):\n---\n${ctx.inputText}\n---`);
  }
  return parts.join('\n\n');
}
