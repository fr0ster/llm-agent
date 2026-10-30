export type ToolTraceEntry = {
  /** One-based dispatch order; gaps identify omitted calls. */
  sequence: number;
  toolName: string;
  /** Sanitized compact JSON, possibly truncated and no longer parseable. */
  arguments: string;
  resultExcerpt: string;
} & (
  | { outcome: 'ok'; error?: never }
  | { outcome: 'error'; error: string }
  | { outcome: 'unsettled'; error?: never }
);

export interface ToolTrace {
  entries: ToolTraceEntry[];
  omittedCount: number;
  /** False when evidence is known to be partial or calls remain unsettled. */
  complete: boolean;
}

export const TOOL_TRACE_MAX_ENTRIES = 50;
export const TOOL_TRACE_ARGUMENT_CHARS = 400;
export const TOOL_TRACE_RESULT_CHARS = 300;
export const TOOL_TRACE_ERROR_CHARS = 300;
export const TOOL_TRACE_RENDER_CHARS = 8_000;
