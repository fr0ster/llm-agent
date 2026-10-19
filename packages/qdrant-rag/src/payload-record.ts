import type { RagMetadata } from '@mcp-abap-adt/llm-agent';

/**
 * The single payload → record mapping: `upsert` stores `{ text, ...metadata }`
 * flat, so the text is lifted out and everything else is the metadata.
 */
export function splitPayload(payload: Record<string, unknown>): {
  text: string;
  metadata: RagMetadata;
} {
  const { text, ...rest } = payload;
  return { text: String(text ?? ''), metadata: rest as RagMetadata };
}
