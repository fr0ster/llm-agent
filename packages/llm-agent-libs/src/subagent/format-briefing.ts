import type { IBriefing } from '@mcp-abap-adt/llm-agent';

/**
 * Render a structured briefing + task as a canonical prompt string.
 *
 * Section order is fixed (Goal → Known → Tried → Constraints → Artifacts → Task).
 * Empty/absent sections are omitted entirely. When the briefing yields no
 * sections, returns the bare task string so callers see no behavioral change.
 */
export function formatBriefing(task: string, briefing?: IBriefing): string {
  if (!briefing) return task;

  const sections: string[] = [];

  if (briefing.goal && briefing.goal.length > 0) {
    sections.push(`Goal: ${briefing.goal}`);
  }

  if (briefing.known && briefing.known.length > 0) {
    sections.push(
      ['Known so far:', ...briefing.known.map((k) => `- ${k}`)].join('\n'),
    );
  }

  if (briefing.tried && briefing.tried.length > 0) {
    sections.push(
      [
        'Already tried (do not repeat these approaches):',
        ...briefing.tried.map((t) => `- ${t}`),
      ].join('\n'),
    );
  }

  if (briefing.constraints && briefing.constraints.length > 0) {
    sections.push(
      ['Constraints:', ...briefing.constraints.map((c) => `- ${c}`)].join('\n'),
    );
  }

  if (briefing.artifacts && briefing.artifacts.length > 0) {
    sections.push(
      [
        'Relevant artifacts:',
        ...briefing.artifacts.map((a) => `- ${a.ref} — ${a.summary}`),
      ].join('\n'),
    );
  }

  if (sections.length === 0) return task;

  return `${sections.join('\n\n')}\n\nTask: ${task}`;
}
