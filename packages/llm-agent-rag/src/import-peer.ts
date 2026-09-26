import { MissingProviderError } from '@mcp-abap-adt/llm-agent';

/**
 * Load an optional peer. `load` is a thunk whose body is a LITERAL
 * `import('@mcp-abap-adt/…')`, so the module's type is inferred at compile
 * time — no `as T` — while the package stays an optional peer at runtime
 * (each is declared in both peerDependencies and devDependencies).
 * `MissingProviderError` is the one runtime check kept: a package is either
 * installed or not, and no type can answer that.
 */
export async function importPeer<T>(
  load: () => Promise<T>,
  pkg: string,
  name: string,
): Promise<T> {
  try {
    return await load();
  } catch {
    throw new MissingProviderError(pkg, name);
  }
}
