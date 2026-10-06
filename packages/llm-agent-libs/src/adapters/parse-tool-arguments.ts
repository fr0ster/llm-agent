import type { LlmToolCall } from '@mcp-abap-adt/llm-agent';
import { PIPELINE_FAILURE_CODES } from '@mcp-abap-adt/llm-agent';

export type ParsedToolArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse a provider's tool-call argument text (spec §10.5.2 N2). No text — a call
 * with no arguments — is a valid empty object; text that is not a JSON object is
 * an error, never `{}`.
 */
export function parseToolArguments(
  raw: string | undefined,
): ParsedToolArguments {
  if (raw === undefined || raw.trim() === '') return { ok: true, value: {} }; // no arguments given — a valid empty call
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? { ok: true, value: v as Record<string, unknown> }
      : { ok: false, error: 'arguments are not a JSON object' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * A tool call from the provider's argument text (spec §10.5.2 N2, D87): parsed, or
 * marked — `argumentsError` = the parse error, `arguments` `{}`. Never `{}` alone
 * for text that did not parse: the site that runs tools must see the difference.
 */
export function toolCallFromRaw(
  id: string,
  name: string,
  raw: string | undefined,
): LlmToolCall {
  const parsed = parseToolArguments(raw);
  return parsed.ok
    ? { id, name, arguments: parsed.value }
    : { id, name, arguments: {}, argumentsError: parsed.error };
}

/** The tool result of a call that was not run because its arguments did not parse. */
export function invalidArgumentsMessage(tool: string, error: string): string {
  return `Error: arguments of tool "${tool}" are not valid JSON (${PIPELINE_FAILURE_CODES.TOOL_ARGUMENTS_JSON_PARSE_FAILED}): ${error}`;
}
