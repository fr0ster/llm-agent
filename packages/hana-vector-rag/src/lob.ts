import type { RagMetadata } from '@mcp-abap-adt/llm-agent';

/**
 * Decodes a HANA LOB column value. The driver may hand an NCLOB back as a
 * Buffer rather than a string.
 */
export function decodeLob(v: unknown): string {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * A row's metadata with its id put back: the id lives in its own column and
 * out of the JSON, so readers find it in the metadata as every other store
 * returns it (tool selection's toolNameFromRecord keys on it).
 */
export function withId(row: Record<string, unknown>): RagMetadata {
  const raw = decodeLob(row.metadata);
  const parsed = raw ? (JSON.parse(raw) as RagMetadata) : {};
  return { ...parsed, id: String(row.id) };
}
