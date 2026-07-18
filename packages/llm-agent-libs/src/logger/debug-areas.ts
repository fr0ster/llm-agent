/**
 * Debug-trace areas (#213 diagnostics). Each area is gated by its own `DEBUG_*`
 * env var — uniform with the existing DEBUG_CONTROLLER / DEBUG_SMART_AGENT flags.
 * Off by default. Adding a new area = one entry here.
 */
export type DebugArea = 'llm' | 'controller' | 'mcp' | 'rag';

export const DEBUG_ENV: Record<DebugArea, string> = {
  llm: 'DEBUG_LLM',
  controller: 'DEBUG_CONTROLLER',
  mcp: 'DEBUG_MCP',
  rag: 'DEBUG_RAG',
};

/** True when the area's `DEBUG_*` env var is set to a non-empty value. */
export function isDebugArea(area: DebugArea): boolean {
  return !!process.env[DEBUG_ENV[area]];
}

/** The set of areas whose `DEBUG_*` flag is currently on. */
export function enabledAreasFromEnv(): Set<DebugArea> {
  const on = new Set<DebugArea>();
  for (const area of Object.keys(DEBUG_ENV) as DebugArea[])
    if (isDebugArea(area)) on.add(area);
  return on;
}
