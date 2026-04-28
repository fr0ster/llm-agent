/**
 * Plugin contract types.
 *
 * Type declarations moved to @mcp-abap-adt/llm-agent.
 * This file re-exports them and provides the runtime helper functions.
 */
import type {
  IPluginLoader,
  IStageHandler,
  LoadedPlugins,
  PluginExports,
} from '@mcp-abap-adt/llm-agent';

export type { IPluginLoader, IStageHandler, LoadedPlugins, PluginExports };
/**
 * Creates an empty {@link LoadedPlugins} object.
 * Useful for custom `IPluginLoader` implementations.
 */
export declare function emptyLoadedPlugins(): LoadedPlugins;
/**
 * Merges a single plugin module's exports into a {@link LoadedPlugins} result.
 * Useful for custom `IPluginLoader` implementations.
 *
 * @param result - Target to merge into (mutated in place).
 * @param mod    - Plugin module exports to merge.
 * @param source - Source identifier (file path, package name, etc.).
 * @returns `true` if any registrations were found.
 */
export declare function mergePluginExports(
  result: LoadedPlugins,
  mod: PluginExports,
  source: string,
): boolean;
//# sourceMappingURL=types.d.ts.map
