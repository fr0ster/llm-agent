import type { ContextPath, DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';

/**
 * Deterministically compose a worker's task from the node's intent, the plan
 * objective, the outputs of THIS node's dependencies, and the original prompt
 * (only when needsInput). No LLM. DAG-scoped (NOT the linear composeTask).
 */
export function composeNodeTask(
  node: PlanNode,
  plan: DagPlan,
  inputText: string,
  depOutputs: Record<string, string>,
  ancestorContext?: ContextPath,
): string {
  const deps = node.dependsOn ?? [];
  if (
    !plan.objective &&
    deps.length === 0 &&
    !node.needsInput &&
    !ancestorContext
  ) {
    return node.goal;
  }
  const parts: string[] = [`Task: ${node.goal}`];
  if (plan.objective) parts.push(`Overall objective: ${plan.objective}`);

  // Render ancestor path when present and non-trivial.
  if (ancestorContext) {
    const { objective, clarifications, oracleObservations } = ancestorContext;
    // Only render objective if it differs from the plan objective (avoid duplication).
    if (objective && objective !== plan.objective) {
      parts.push(`Objective: ${objective}`);
    }
    for (const c of clarifications ?? []) {
      parts.push(`Clarified: ${c.question} -> ${c.answer}`);
    }
    for (const o of oracleObservations ?? []) {
      parts.push(`Known: ${o.query} -> ${o.answer}`);
    }
  }

  // '---' is a prose-level fence (no escaping); content containing a literal
  // '---' line is rare enough to accept — the output is an LLM prompt, not parsed.
  for (const depId of deps) {
    parts.push(`Input from ${depId}:\n---\n${depOutputs[depId] ?? ''}\n---`);
  }
  if (node.needsInput) {
    parts.push(`Input (user-provided data):\n---\n${inputText}\n---`);
  }
  return parts.join('\n\n');
}
