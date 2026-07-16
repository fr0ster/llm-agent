import type {
  CallOptions,
  IAuxiliaryMcpTools,
  IToolsRagHandle,
  LlmTool,
  McpError,
  McpTool,
  McpToolResult,
  Result,
} from '@mcp-abap-adt/llm-agent';

type CallMcp = (
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => Promise<string>;

type AuxCallTool = (
  name: string,
  args: Record<string, unknown>,
  options?: CallOptions,
) => Promise<Result<McpToolResult, McpError>>;

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

/**
 * Wrap the domain `callMcp` bridge so auxiliary tools are dispatched FIRST
 * (aux-first; collisions were rejected at build). Auxiliary results are mapped
 * to the string bridge contract: ok → content text / JSON; !ok → error.message
 * (tool-level, the domain classifier / fail-loud is NOT run). An abort rejection
 * from `auxCallTool` propagates unchanged (see the controller's abort handling).
 */
type SelectTools = (
  query: string,
  k?: number,
  options?: CallOptions,
) => Promise<readonly LlmTool[]>;

/**
 * Wrap the pipeline's `selectTools` so the resolved auxiliary defs are ALWAYS
 * merged into every selection result (deduped by name; aux appended). Auxiliary
 * tools are a small fixed utility set that should always be in scope — not
 * semantically ranked — which also makes them available MCP-less (domain
 * `selectTools` → [] → result is just the aux defs). `McpTool` is structurally
 * an `LlmTool`, so aux defs are assignable into the `LlmTool[]` result.
 */
export function composeAuxiliarySelect(
  auxDefs: McpTool[],
  selectTools: SelectTools,
): SelectTools {
  return async (query, k, options) => {
    const domain = await selectTools(query, k, options);
    const domainNames = new Set(domain.map((t) => t.name));
    const extra = auxDefs.filter((d) => !domainNames.has(d.name));
    return [...domain, ...extra];
  };
}

export function composeAuxiliaryBridge(
  auxDefs: McpTool[],
  auxCallTool: AuxCallTool,
  domainBridge: CallMcp,
): CallMcp {
  const auxNames = new Set(auxDefs.map((d) => d.name));
  return async (name, args, signal) => {
    if (!auxNames.has(name)) return domainBridge(name, args, signal);
    const safeArgs =
      args != null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};
    const result = await auxCallTool(
      name,
      safeArgs,
      signal ? { signal } : undefined,
    );
    if (!result.ok) return result.error.message;
    const { content } = result.value;
    return typeof content === 'string' ? content : JSON.stringify(content);
  };
}
