/**
 * Append an optional per-role hint to a role's agnostic system prompt.
 *
 * The controller engine's role prompts (evaluator / planner / executor) are
 * deliberately AGNOSTIC and concise. A deployment can append extra OPERATIONAL
 * guidance for a role via `subagents.<role>.hint` — how to build the plan, how
 * to execute a step, what to be strict about. Its main purpose is to scaffold
 * WEAKER models: a capable model (Opus / Sonnet) usually needs none, while a
 * smaller executor/planner model (e.g. gpt-4o-mini) may need the extra steering.
 *
 * A hint is NOT a domain description and must NOT name tools (the self-describing
 * tool catalog + the agnostic prompt cover those; richer per-situation
 * procedures belong to the skills RAG — a separate, dynamic mechanism). An absent
 * or blank hint leaves the agnostic prompt untouched.
 */
export function appendHint(system: string, hint?: string): string {
  const h = hint?.trim();
  return h ? `${system}\n\nAdditional guidance: ${h}` : system;
}
