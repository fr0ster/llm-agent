export interface HanaConnection {
  connect: (opts: unknown, cb: (err: Error | null) => void) => void;
  exec: (
    sql: string,
    params: unknown[],
    cb: (err: Error | null, rows: unknown) => void,
  ) => void;
  disconnect: (cb: (err: Error | null) => void) => void;
}

export interface HanaModule {
  createConnection: () => HanaConnection;
}

function hasCreateConnection(m: unknown): m is HanaModule {
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof (m as { createConnection?: unknown }).createConnection === 'function'
  );
}

/**
 * `@sap/hana-client` is CommonJS: under an ESM `import()` its exports arrive
 * as `default` (named exports are not always detected), so look at both.
 */
export function resolveHanaModule(m: unknown): HanaModule {
  if (hasCreateConnection(m)) return m;
  const def = (m as { default?: unknown } | null | undefined)?.default;
  if (hasCreateConnection(def)) return def;
  throw new Error(
    "@sap/hana-client does not expose createConnection (neither as a named export nor on 'default')",
  );
}
