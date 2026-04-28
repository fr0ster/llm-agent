/**
 * FileSystemPluginLoader — default {@link IPluginLoader} implementation.
 *
 * Scans directories and dynamically imports `.js`, `.mjs`, and `.ts` files.
 * Each file is expected to export named registrations matching {@link PluginExports}.
 * Invalid exports are silently ignored; import errors are collected in `errors`.
 *
 * ## Load order
 *
 * Directories are processed in order. Within a directory, files are sorted
 * alphabetically. Later registrations override earlier ones (last wins).
 *
 * ## Security
 *
 * Plugin files are executed via dynamic `import()`. Only load plugins from
 * trusted directories. The loader does NOT sandbox plugin code.
 */
import type { IPluginLoader, LoadedPlugins } from './types.js';
export interface FileSystemPluginLoaderConfig {
  /** Directories to scan for plugin files (in order, later wins). */
  dirs: string[];
  /** Optional logger for diagnostic messages. */
  log?: (msg: string) => void;
}
/**
 * Filesystem-based plugin loader.
 *
 * Scans one or more directories for plugin files and dynamically imports them.
 * This is the default implementation shipped with the library.
 *
 * @example
 * ```ts
 * const loader = new FileSystemPluginLoader({
 *   dirs: getDefaultPluginDirs(),
 * });
 * const plugins = await loader.load();
 * ```
 *
 * @example Inject into builder
 * ```ts
 * builder.withPluginLoader(new FileSystemPluginLoader({
 *   dirs: [...getDefaultPluginDirs(), './my-extra-plugins'],
 * }));
 * ```
 */
export declare class FileSystemPluginLoader implements IPluginLoader {
  private readonly dirs;
  private readonly log?;
  constructor(config: FileSystemPluginLoaderConfig);
  load(): Promise<LoadedPlugins>;
}
/**
 * Returns the default plugin directories (in load order).
 *
 * 1. `~/.config/llm-agent/plugins/` (user-level)
 * 2. `./plugins/` (project-level, relative to cwd)
 */
export declare function getDefaultPluginDirs(): string[];
/**
 * Convenience function — creates a {@link FileSystemPluginLoader} and loads.
 *
 * @param dirs - Directories to scan (in order, later wins).
 * @param log  - Optional logger.
 * @returns Merged plugin registrations.
 */
export declare function loadPlugins(
  dirs: string[],
  log?: (msg: string) => void,
): Promise<LoadedPlugins>;
//# sourceMappingURL=loader.d.ts.map
