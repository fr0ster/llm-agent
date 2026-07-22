import { type NextStep, validateRequires } from './types.js';

/** Parse the planner's reply into a NextStep, tolerating ```json fences and
 *  surrounding prose. Returns null when no valid decision can be extracted — the
 *  caller treats that as a FORMAT error (re-ask the planner), NOT a rewind, so a
 *  badly-formatted reply never silently burns the rewind budget. */
export function parseNextStep(content: string): NextStep | null {
  const json = extractJsonObject(content);
  if (json === null) return null;
  try {
    const obj = JSON.parse(json) as Partial<NextStep>;
    if (obj.kind === 'done' && typeof obj.result === 'string')
      return { kind: 'done', result: obj.result };
    if (obj.kind === 'rewind' && typeof obj.reason === 'string')
      return { kind: 'rewind', reason: obj.reason };
    if (obj.kind === 'error' && typeof obj.error === 'string')
      return { kind: 'error', error: obj.error };
    if (
      obj.kind === 'next' &&
      obj.step &&
      typeof obj.step.name === 'string' &&
      typeof obj.step.instructions === 'string'
    ) {
      // Validate requires[] so a non-string / empty / oversized reference never
      // reaches the semantic query / embedder; a malformed value is a parse
      // failure that drives the existing parse-retry.
      const req = validateRequires(
        (obj.step as { requires?: unknown }).requires,
      );
      if (req === false) return null;
      return {
        kind: 'next',
        step: {
          name: obj.step.name,
          instructions: obj.step.instructions,
          ...(obj.step.type ? { type: obj.step.type } : {}),
          ...(req ? { requires: req } : {}),
        },
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Extract the first balanced JSON object from a planner reply, ignoring ```json
 *  fences and prose around it. String-aware (braces inside strings don't count).
 *  Returns null if no balanced object is present. */
export function extractJsonObject(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}
