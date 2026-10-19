import { RagError } from '@mcp-abap-adt/llm-agent';

/**
 * The pgvector literal for a vector, refused before any SQL when a component
 * is not finite or, when a `dimension` is given (the `shared` layout), its
 * length differs from it.
 */
export function pgVectorLiteral(
  vec: readonly number[],
  dimension?: number,
): string {
  if (dimension !== undefined && vec.length !== dimension) {
    throw new RagError(
      `Vector length ${vec.length} does not match the configured dimension ${dimension}`,
      'INVALID_VECTOR',
    );
  }
  const bad = vec.findIndex((v) => !Number.isFinite(v));
  if (bad !== -1) {
    throw new RagError(
      `Vector component at index ${bad} is not a finite number`,
      'INVALID_VECTOR',
    );
  }
  return `'[${vec.join(',')}]'::vector`;
}
