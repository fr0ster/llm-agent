import type { ContextPath } from '@mcp-abap-adt/llm-agent';

/**
 * Render an ancestor intent path (objective + clarification dialogue + oracle
 * observations) into plain text, prepended to a role's task. Shared by the
 * planner and reviewer role adapters.
 */
export function renderAncestorContext(ac: ContextPath): string {
  const lines: string[] = [];
  if (ac.objective) {
    lines.push(`Ancestor objective: ${ac.objective}`);
  }
  if (ac.clarifications.length > 0) {
    lines.push('Prior clarifications:');
    for (const c of ac.clarifications) {
      lines.push(`  Q: ${c.question}`);
      lines.push(`  A: ${c.answer}`);
    }
  }
  if (ac.oracleObservations.length > 0) {
    lines.push('Oracle observations:');
    for (const o of ac.oracleObservations) {
      lines.push(`  Query: ${o.query}`);
      lines.push(`  Answer: ${o.answer}`);
    }
  }
  return lines.join('\n');
}
