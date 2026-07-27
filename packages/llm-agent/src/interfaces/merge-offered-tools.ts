import type { LlmTool } from './types.js';

/**
 * Concatenate internal (MCP, already namespace-unique) and external
 * (client-provided) tools for the LLM. Fail-fast on any name in BOTH sets:
 * the offered list must be unique so classifyToolCalls cannot double-classify.
 */
export function mergeOfferedTools(
  internal: readonly LlmTool[],
  external: readonly LlmTool[],
): LlmTool[] {
  const internalNames = new Set(internal.map((x) => x.name));
  for (const x of external)
    if (internalNames.has(x.name))
      throw new Error(
        `tool "${x.name}" is both an internal MCP tool (exposed name) and a ` +
          `client-provided external tool — rename the external tool.`,
      );
  return [...internal, ...external];
}
