import { isMcpUnavailable, type McpError } from '@mcp-abap-adt/llm-agent';

// Loose over the exact tool-result shape (callTool's Result error is structurally
// `{ message }`, but at runtime an availability failure is a real McpError — which
// `isMcpUnavailable`'s instanceof check detects). Accepting `{ message: string }`
// keeps both the core loop and the pipeline-handler loop type-compatible.
type ToolRes =
  | { ok: true; value: { content: unknown } }
  | { ok: false; error: { message: string } };

/** The decision both MCP tool loops share for one tool-call result:
 *  - `escalate` → an availability failure (transport down / 403 / timeout after
 *    reconnect): the caller must FAIL LOUD (yield an error → process() ok:false),
 *    NOT feed it to the LLM as text;
 *  - `text` → normal content OR a tool-level error, which stays LLM feedback. */
export type ToolResultDecision =
  | { escalate: McpError }
  | { escalate?: undefined; text: string };

/** Classify a tool-call result. Used by BOTH the core SmartAgent tool loop and the
 *  pipeline-handler tool loop so the throw-or-text decision lives in ONE place. */
export function classifyToolResult(res: ToolRes): ToolResultDecision {
  if (!res.ok) {
    if (isMcpUnavailable(res.error)) return { escalate: res.error as McpError };
    return { text: res.error.message };
  }
  return {
    text:
      typeof res.value.content === 'string'
        ? res.value.content
        : JSON.stringify(res.value.content),
  };
}
