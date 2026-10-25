// packages/sap-aicore-embedder/src/decode-embedding.ts
/**
 * Decode an embedding vector from either a `number[]` (JSON array) or a
 * base64-encoded Float32 buffer string (compact on-wire form some SAP AI Core
 * deployments return).
 */
export function decodeEmbedding(embedding: number[] | string): number[] {
  if (typeof embedding !== 'string') {
    if (
      !Array.isArray(embedding) ||
      embedding.length === 0 ||
      embedding.some((value) => !Number.isFinite(value))
    )
      throw new Error('Invalid embedding vector');
    return embedding;
  }
  if (typeof embedding === 'string') {
    const buffer = Buffer.from(embedding, 'base64');
    if (buffer.length === 0 || buffer.length % 4 !== 0)
      throw new Error('Invalid embedding buffer');
    const float32 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 4,
    );
    return Array.from(float32);
  }
  return embedding;
}
