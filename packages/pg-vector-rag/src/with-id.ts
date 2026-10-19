import type { RagMetadata } from '@mcp-abap-adt/llm-agent';

/**
 * upsert keeps the id in its own column and out of the jsonb, so a read puts
 * it back: readers find a record's id in its metadata, as every other store
 * returns it (tool selection's toolNameFromRecord keys on it).
 */
export function withId(row: Record<string, unknown>): RagMetadata {
  return { ...((row.metadata as RagMetadata) ?? {}), id: String(row.id) };
}
