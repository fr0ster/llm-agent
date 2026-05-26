import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';

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
): string {
  const deps = node.dependsOn ?? [];
  if (!plan.objective && deps.length === 0 && !node.needsInput) {
    return node.goal;
  }
  const parts: string[] = [`Task: ${node.goal}`];
  if (plan.objective) parts.push(`Overall objective: ${plan.objective}`);
  for (const depId of deps) {
    parts.push(`Input from ${depId}:\n---\n${depOutputs[depId] ?? ''}\n---`);
  }
  if (node.needsInput) {
    parts.push(`Input (user-provided data):\n---\n${inputText}\n---`);
  }
  return parts.join('\n\n');
}
