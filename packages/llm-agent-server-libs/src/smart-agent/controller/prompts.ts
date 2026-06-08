/**
 * Append an optional consumer-supplied domain hint to a role's agnostic system
 * prompt.
 *
 * The controller engine's role prompts (evaluator / planner / executor) are
 * deliberately DOMAIN-AGNOSTIC — they say "the live target system", never "SAP"
 * or "ABAP". A deployment re-specialises a role (makes it gnostic) by setting
 * `subagents.<role>.hint` in the pipeline config; that hint is appended here as
 * a short "Domain context" preamble to the role's system prompt. An absent or
 * blank hint leaves the agnostic prompt untouched.
 *
 * This is the STATIC gnosticization channel. The DYNAMIC channel — procedural
 * skills retrieved from a RAG collection at the right moment — is a separate
 * mechanism and is not wired here.
 */
export function appendHint(system: string, hint?: string): string {
  const h = hint?.trim();
  return h ? `${system}\n\nDomain context: ${h}` : system;
}
