// packages/sap-aicore-embedder/src/decode-embedding.ts
/**
 * Decode an embedding vector from either a `number[]` (JSON array) or a
 * base64-encoded Float32 buffer string (compact on-wire form some SAP AI Core
 * deployments return).
 */
export function decodeEmbedding(embedding) {
    if (typeof embedding === 'string') {
        const buffer = Buffer.from(embedding, 'base64');
        const float32 = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
        return Array.from(float32);
    }
    return embedding;
}
//# sourceMappingURL=decode-embedding.js.map