import {
  type DebugArea,
  enabledAreasFromEnv,
} from '@mcp-abap-adt/llm-agent-libs';

const DEFAULT_TRACE_DIR = './.smart-agent-debug/';

/** Resolve the SessionLogger sink for a request. `cfg.logDir` (legacy) wins and
 *  forces all-areas; otherwise any `DEBUG_*` area flag opens the default trace
 *  dir (or `DEBUG_TRACE_DIR`) with only the on-areas enabled; nothing → no sink. */
export function resolveTraceSink(logDir: string | undefined): {
  dir: string | null;
  enabledAreas: 'all' | Set<DebugArea>;
} {
  if (logDir) return { dir: logDir, enabledAreas: 'all' };
  const areas = enabledAreasFromEnv();
  if (areas.size === 0) return { dir: null, enabledAreas: areas };
  return {
    dir: process.env.DEBUG_TRACE_DIR || DEFAULT_TRACE_DIR,
    enabledAreas: areas,
  };
}
