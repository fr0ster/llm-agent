export type ToolTraceEntry = {
  /** One-based dispatch order; gaps identify omitted calls. */
  sequence: number;
  toolName: string;
  /** Sanitized JSON or text preserved without character truncation. */
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
