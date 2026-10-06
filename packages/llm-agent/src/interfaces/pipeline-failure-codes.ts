/** Codes for failures no component has a code for (spec §10.5.1, D69). A set of its own: no shared set is widened. */
export const PIPELINE_FAILURE_CODES = {
  RAG_STORE_MISSING: 'RAG_STORE_MISSING',
  STATE_CORRUPT: 'STATE_CORRUPT',
  TOOL_ARGUMENTS_JSON_PARSE_FAILED: 'TOOL_ARGUMENTS_JSON_PARSE_FAILED',
} as const;
export type PipelineFailureCode =
  (typeof PIPELINE_FAILURE_CODES)[keyof typeof PIPELINE_FAILURE_CODES];
