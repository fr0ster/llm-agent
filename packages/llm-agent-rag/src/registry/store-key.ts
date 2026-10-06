import type { RagCollectionScope } from '@mcp-abap-adt/llm-agent';
import { ReservedCollectionNameError } from '@mcp-abap-adt/llm-agent';

/**
 * The prefixes the `ragStores` projection gives the two owned scopes (§6.4). A
 * global may not begin with one: it would take a key the projection gives
 * another scope, and one entry would silently overwrite the other.
 */
const RESERVED_GLOBAL_PREFIXES = ['user/', 'session/'] as const;

/** The refusal for a global named into a reserved prefix, or undefined. */
export function reservedGlobalNameError(
  scope: RagCollectionScope,
  name: string,
): ReservedCollectionNameError | undefined {
  if (scope !== 'global') return undefined;
  const prefix = RESERVED_GLOBAL_PREFIXES.find((p) => name.startsWith(p));
  return prefix ? new ReservedCollectionNameError(name, prefix) : undefined;
}

/**
 * The key a collection has in the `ragStores` projection: a global keeps its
 * bare name, so every stage configuration naming one keeps working; a user or
 * session collection is `user/<name>` or `session/<name>`. An absent scope is
 * global, as `register` defaults it.
 */
export function ragStoreKey(meta: {
  readonly name: string;
  readonly scope?: RagCollectionScope;
}): string {
  const scope = meta.scope ?? 'global';
  return scope === 'global' ? meta.name : `${scope}/${meta.name}`;
}
