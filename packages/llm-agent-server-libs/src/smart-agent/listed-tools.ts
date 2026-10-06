import { McpError, type McpTool, type Result } from '@mcp-abap-adt/llm-agent';

/**
 * Each client's listed tools, in client order — or the first failure thrown as
 * an McpError (a rejection that is not one becomes `MCP_ERROR`). One pass; the
 * server's snapshot and the tools-RAG handle share it (spec §10.5.3 M9, M11).
 * Server-libs-internal: not exported from the package root.
 */
export function listedToolsOrThrow(
  settled: readonly PromiseSettledResult<Result<McpTool[], McpError>>[],
): McpTool[][] {
  const perClient: McpTool[][] = [];
  for (const entry of settled) {
    if (entry.status === 'rejected') {
      const reason = entry.reason;
      throw reason instanceof McpError
        ? reason
        : new McpError(
            reason instanceof Error ? reason.message : String(reason),
            'MCP_ERROR',
          );
    }
    if (!entry.value.ok) throw entry.value.error;
    perClient.push(entry.value.value);
  }
  return perClient;
}
