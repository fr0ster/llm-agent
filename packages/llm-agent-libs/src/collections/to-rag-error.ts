import { RagError, SmartAgentError } from '@mcp-abap-adt/llm-agent';

/**
 * A thrown value as a `RagError` (a Result-returning call that rejected): a
 * `RagError` as is, another `SmartAgentError` with its code kept (fail loud: the
 * component's code reaches the caller), anything else `RAG_ERROR`.
 * Internal to `collections/`; not exported from the package.
 */
export function toRagError(err: unknown): RagError {
  if (err instanceof RagError) return err;
  if (err instanceof SmartAgentError)
    return new RagError(err.message, err.code);
  return new RagError(err instanceof Error ? err.message : String(err));
}
