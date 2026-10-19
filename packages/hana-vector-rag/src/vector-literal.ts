import { RagError } from '@mcp-abap-adt/llm-agent';

/**
 * The `TO_REAL_VECTOR` literal for a vector, refused before any SQL when its
 * length differs from the table's dimension or a component is not finite.
 */
export function hanaVectorLiteral(
  vec: readonly number[],
  dimension: number,
): string {
  if (vec.length !== dimension) {
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
  return `TO_REAL_VECTOR('[${vec.join(',')}]')`;
}
