import type {
  IAuxiliaryMcpTools,
  IToolsRagHandle,
  McpTool,
} from '@mcp-abap-adt/llm-agent';

/**
 * Resolve the auxiliary tool defs ONCE at build. `!ok` is a real bug in the
 * in-process provider — fail loud, never silently skip the aux tools.
 */
export async function resolveAuxDefs(
  aux: IAuxiliaryMcpTools,
): Promise<McpTool[]> {
  const listed = await aux.listTools();
  if (!listed.ok) {
    throw new Error(
      `auxiliary tools failed to list at build: ${listed.error.message}`,
    );
  }
  return listed.value;
}

/**
 * Fail-loud collision gate (sync, over the already-resolved defs). Aux-first
 * dispatch would otherwise silently shadow a same-named domain tool. Uses the
 * sync `toolsRag.lookup` (non-optional on IPipelineContext; EMPTY_TOOLS_RAG
 * returns undefined for every name when there is no domain catalog).
 */
export function assertNoAuxCollision(
  auxDefs: McpTool[],
  toolsRag: IToolsRagHandle,
): void {
  for (const def of auxDefs) {
    if (toolsRag.lookup(def.name) !== undefined) {
      throw new Error(
        `auxiliary tool '${def.name}' collides with a connected MCP tool — ` +
          'rename the auxiliary tool',
      );
    }
  }
}
