/**
 * FileSystemPluginLoader — default {@link IPluginLoader} implementation.
 *
 * Scans directories and dynamically imports `.js`, `.mjs`, and `.ts` files.
 * Each file is expected to export named registrations matching {@link PluginExports}.
 * A file in a directory is DISCOVERED, not required (spec §17.43 D96): one that
 * fails to import, or whose exports are refused, is reported in
 * `LoadedPlugins.skipped` and logged — never in `errors`, which holds only the
 * plugins a loader was told to load.
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

import { existsSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IPluginLoader, LoadedPlugins, PluginExports } from './types.js';
import { emptyLoadedPlugins, mergePluginExports } from './types.js';

const PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);

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
export class FileSystemPluginLoader implements IPluginLoader {
  private readonly dirs: string[];
  private readonly log?: (msg: string) => void;

  constructor(config: FileSystemPluginLoaderConfig) {
    this.dirs = config.dirs;
    this.log = config.log;
  }

  async load(): Promise<LoadedPlugins> {
    const result = emptyLoadedPlugins();
    const skipped: Array<{ file: string; error: string }> = [];
    result.skipped = skipped;

    for (const dir of this.dirs) {
      const resolved = resolve(dir);
      if (!existsSync(resolved)) {
        this.log?.(`[plugins] Directory not found, skipping: ${resolved}`);
        continue;
      }

      let files: string[];
      try {
        files = readdirSync(resolved)
          .filter((f) => PLUGIN_EXTENSIONS.has(extname(f)))
          .sort();
      } catch (err) {
        // Its files are discovered, not required: reported like one (D96).
        const error = `cannot read directory: ${err instanceof Error ? err.message : String(err)}`;
        skipped.push({ file: resolved, error });
        this.log?.(`[plugins] Skipped ${resolved}: ${error}`);
        continue;
      }

      for (const file of files) {
        const filePath = resolve(resolved, file);
        const skip = (error: string) => {
          skipped.push({ file: filePath, error });
          this.log?.(`[plugins] Skipped ${filePath}: ${error}`);
        };
        try {
          const fileUrl = pathToFileURL(filePath).href;
          const mod = (await import(fileUrl)) as PluginExports;
          const before = result.errors.length;
          const registered = mergePluginExports(result, mod, filePath);
          // A refused export of a discovered file is reported, not an error (D96).
          for (const e of result.errors.splice(before)) skip(e.error);
          if (registered) {
            this.log?.(`[plugins] Loaded: ${filePath}`);
          }
        } catch (err) {
          skip(err instanceof Error ? err.message : String(err));
        }
      }
    }

    return result;
  }
}

/**
 * Returns the default plugin directories (in load order).
 *
 * 1. `~/.config/llm-agent/plugins/` (user-level)
 * 2. `./plugins/` (project-level, relative to cwd)
 */
export function getDefaultPluginDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  if (home) {
    dirs.push(resolve(home, '.config', 'llm-agent', 'plugins'));
  }
  dirs.push(resolve(process.cwd(), 'plugins'));
  return dirs;
}

/**
 * Convenience function — creates a {@link FileSystemPluginLoader} and loads.
 *
 * @param dirs - Directories to scan (in order, later wins).
 * @param log  - Optional logger.
 * @returns Merged plugin registrations.
 */
export async function loadPlugins(
  dirs: string[],
  log?: (msg: string) => void,
): Promise<LoadedPlugins> {
  return new FileSystemPluginLoader({ dirs, log }).load();
}
