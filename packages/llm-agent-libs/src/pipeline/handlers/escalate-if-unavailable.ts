import {
  isMcpUnavailable,
  type McpError,
  type Result,
} from '@mcp-abap-adt/llm-agent';

type ToolRes = Result<{ content: unknown }, McpError>;

/**
 * The single decision both MCP tool loops (the core SmartAgent loop and the
 * pipeline-handler tool loop) use to turn a tool-call result into text — EXCEPT
 * an availability failure, which it THROWS so the run fails loud (→ a real error
 * to the consumer, not a silent "(no response)") instead of feeding "MCP error"
 * back to the LLM as tool text. A tool-level error stays text (LLM feedback).
 */
export function escalateIfUnavailable(res: ToolRes): string {
  if (!res.ok) {
    if (isMcpUnavailable(res.error)) throw res.error;
    return res.error.message;
  }
  return typeof res.value.content === 'string'
    ? res.value.content
    : JSON.stringify(res.value.content);
}
