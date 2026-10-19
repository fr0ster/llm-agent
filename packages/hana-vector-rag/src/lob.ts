/**
 * Decodes a HANA LOB column value. The driver may hand an NCLOB back as a
 * Buffer rather than a string.
 */
export function decodeLob(v: unknown): string {
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (v === null || v === undefined) return '';
  return String(v);
}
