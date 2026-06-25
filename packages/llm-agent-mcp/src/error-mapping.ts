import { McpError } from '@mcp-abap-adt/llm-agent';

/** Flatten an error's message + code across its `cause` chain (Node `fetch`
 *  wraps the real transport error in `.cause`; AggregateError nests in
 *  `.errors`) into one lowercase string for signature matching. Depth-limited. */
function collectErrorText(err: unknown, depth = 0): string {
  if (err == null || depth > 4) return '';
  if (typeof err === 'string') return err.toLowerCase();
  const e = err as {
    message?: unknown;
    code?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (typeof e.code === 'string') parts.push(e.code);
  if (e.cause !== undefined) parts.push(collectErrorText(e.cause, depth + 1));
  if (Array.isArray(e.errors)) {
    for (const sub of e.errors) parts.push(collectErrorText(sub, depth + 1));
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Map a thrown/returned transport error to an McpError with an availability
 * code. Shared by McpClientAdapter (catch + returned-error path) and
 * MCPClientWrapper (throw on retry exhaustion) so both classify identically.
 *
 * The default for an UNRECOGNIZED message is the non-availability `MCP_ERROR`,
 * so a plain tool error never escalates to fail-loud / NOT_READY. Connection /
 * network / timeout / HTTP-5xx-or-403 signatures DO escalate — including the
 * Node `fetch failed` shape whose real cause (ECONNREFUSED / ENOTFOUND / …)
 * lives on `err.cause`.
 */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const top = err instanceof Error ? err.message : String(err);
  const m = collectErrorText(err) || String(err).toLowerCase();

  let code = 'MCP_ERROR';
  if (
    m.includes('timed out') ||
    m.includes('timeout') ||
    m.includes('-32001') ||
    m.includes('etimedout')
  )
    code = 'MCP_TIMEOUT';
  else if (m.includes('after reconnect') || m.includes('no response'))
    code = 'MCP_NO_RESPONSE';
  else if (m.includes('403')) code = 'MCP_HTTP_403';
  else if (m.includes('502')) code = 'MCP_HTTP_502';
  else if (m.includes('503')) code = 'MCP_HTTP_503';
  else if (
    m.includes('not connected') ||
    m.includes('fetch failed') ||
    m.includes('econnrefused') ||
    m.includes('connection refused') ||
    m.includes('econnreset') ||
    m.includes('ehostunreach') ||
    m.includes('enetunreach') ||
    m.includes('enotfound') ||
    m.includes('eai_again') ||
    m.includes('socket hang up') ||
    m.includes('bad port') ||
    m.includes('network')
  )
    code = 'MCP_NOT_CONNECTED';
  else if (m.includes('transport')) code = 'MCP_TRANSPORT';

  return new McpError(top || 'MCP transport error', code);
}
