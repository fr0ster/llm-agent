import type { DagPlan, PlanNode } from '@mcp-abap-adt/llm-agent';

/**
 * Replace node `nodeId` in `plan` with the nodes of `subPlan`, flat (no nesting):
 * - sub-plan node ids are namespaced `${nodeId}:${id}` (collision-safe);
 * - sub-plan ROOT nodes (no intra-sub deps) inherit the replaced node's
 *   `dependsOn` AND `needsInput`;
 * - consumers that depended on `nodeId` now depend on the sub-plan's TERMINAL
 *   nodes (sub nodes nothing else in the sub-plan depends on).
 * Returns a new DagPlan (no mutation of the input).
 */
export function spliceSubPlan(
  plan: DagPlan,
  nodeId: string,
  subPlan: DagPlan,
): DagPlan {
  const replaced = plan.nodes.find((n) => n.id === nodeId);
  if (!replaced) return plan;
  const ns = (id: string) => `${nodeId}:${id}`;

  const subDependedOn = new Set(
    subPlan.nodes.flatMap((n) => n.dependsOn ?? []),
  );
  const terminals = subPlan.nodes
    .filter((n) => !subDependedOn.has(n.id))
    .map((n) => ns(n.id));
  const inheritedDeps = replaced.dependsOn ?? [];

  const splicedSubNodes: PlanNode[] = subPlan.nodes.map((n) => {
    const intra = (n.dependsOn ?? []).map(ns);
    const isRoot = (n.dependsOn ?? []).length === 0;
    return {
      ...n,
      id: ns(n.id),
      dependsOn: isRoot ? inheritedDeps : intra,
      needsInput: isRoot ? (replaced.needsInput ?? n.needsInput) : n.needsInput,
    };
  });

  const rest = plan.nodes
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      const deps = n.dependsOn ?? [];
      if (!deps.includes(nodeId)) return n;
      const rewired = deps.filter((d) => d !== nodeId).concat(terminals);
      return { ...n, dependsOn: rewired };
    });

  return { ...plan, nodes: [...rest, ...splicedSubNodes] };
}
