import { McpError } from '@mcp-abap-adt/llm-agent';

/**
 * Map a thrown/returned transport message to an McpError with an availability
 * code. Shared by McpClientAdapter (catch + returned-error path) and
 * MCPClientWrapper (throw on retry exhaustion) so both classify identically.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.toLowerCase();
  // Default is the NON-availability tool-level code: an unrecognized message must
  // NOT be treated as a transport outage (that would escalate a plain tool error to
  // fail-loud / NOT_READY). Only an explicit availability signature escalates.
  let code = 'MCP_ERROR';
  if (m.includes('not connected')) code = 'MCP_NOT_CONNECTED';
  else if (m.includes('transport')) code = 'MCP_TRANSPORT';
  else if (
    m.includes('-32001') ||
    m.includes('timed out') ||
    m.includes('timeout')
  )
    code = 'MCP_TIMEOUT';
  else if (m.includes('403')) code = 'MCP_HTTP_403';
  else if (m.includes('502')) code = 'MCP_HTTP_502';
  else if (m.includes('503')) code = 'MCP_HTTP_503';
  else if (m.includes('after reconnect') || m.includes('no response'))
    code = 'MCP_NO_RESPONSE';
  return new McpError(msg, code);
}
