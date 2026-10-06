/**
 * Deterministic, server-agnostic word derivation (spec §7.3.1). Every word comes
 * from the provider: no lexicon, no synonyms, no LLM, no assumed word order.
 * Module-internal: used by the facets, composers and tests, never exported from
 * `collections/index.ts`.
 */

/** Split a name on camelCase, acronym, `_`, `-`, `.` and digit boundaries; lowercase. */
export function nameWords(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase())
    .join(' ');
}

/** An enum value's words — the same split as a name. */
export function valueWords(value: string): string {
  return nameWords(value);
}

const MAX_CLAUSE = 200;

/** The description up to the first `.`, `;`, `:` or newline, without a leading `[...]` tag. */
export function firstClause(description: string): string {
  const untagged = description.replace(/^\s*\[[^\]]*\]\s*/, '');
  const end = untagged.search(/[.;:\n]/);
  const clause = (end === -1 ? untagged : untagged.slice(0, end)).trim();
  return clause.slice(0, MAX_CLAUSE);
}
