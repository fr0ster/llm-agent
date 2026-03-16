/**
 * Plugin loader — scans directories and dynamically imports plugin modules.
 *
 * Loads `.js`, `.mjs`, and `.ts` files from specified directories.
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

import { existsSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IStageHandler } from '../pipeline/stage-handler.js';
import type { LoadedPlugins, PluginExports } from './types.js';

const PLUGIN_EXTENSIONS = new Set(['.js', '.mjs', '.ts']);

/**
 * Load plugins from one or more directories.
 *
 * @param dirs - Directories to scan (in order, later wins).
 *               Non-existent directories are silently skipped.
 * @param log  - Optional logger for diagnostic messages.
 * @returns Merged plugin registrations.
 */
export async function loadPlugins(
  dirs: string[],
  log?: (msg: string) => void,
): Promise<LoadedPlugins> {
  const result: LoadedPlugins = {
    stageHandlers: new Map(),
    embedderFactories: {},
    loadedFiles: [],
    errors: [],
  };

  for (const dir of dirs) {
    const resolved = resolve(dir);
    if (!existsSync(resolved)) {
      log?.(`[plugins] Directory not found, skipping: ${resolved}`);
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(resolved)
        .filter((f) => PLUGIN_EXTENSIONS.has(extname(f)))
        .sort();
    } catch {
      log?.(`[plugins] Cannot read directory: ${resolved}`);
      continue;
    }

    for (const file of files) {
      const filePath = resolve(resolved, file);
      try {
        const fileUrl = pathToFileURL(filePath).href;
        const mod = (await import(fileUrl)) as PluginExports;
        let registered = false;

        // Stage handlers
        if (mod.stageHandlers && typeof mod.stageHandlers === 'object') {
          for (const [type, handler] of Object.entries(mod.stageHandlers)) {
            if (
              handler &&
              typeof (handler as IStageHandler).execute === 'function'
            ) {
              result.stageHandlers.set(type, handler as IStageHandler);
              registered = true;
            }
          }
        }

        // Embedder factories
        if (
          mod.embedderFactories &&
          typeof mod.embedderFactories === 'object'
        ) {
          for (const [name, factory] of Object.entries(mod.embedderFactories)) {
            if (typeof factory === 'function') {
              result.embedderFactories[name] = factory;
              registered = true;
            }
          }
        }

        // Reranker
        if (mod.reranker && typeof mod.reranker === 'object') {
          result.reranker = mod.reranker;
          registered = true;
        }

        // Query expander
        if (mod.queryExpander && typeof mod.queryExpander === 'object') {
          result.queryExpander = mod.queryExpander;
          registered = true;
        }

        // Output validator
        if (mod.outputValidator && typeof mod.outputValidator === 'object') {
          result.outputValidator = mod.outputValidator;
          registered = true;
        }

        if (registered) {
          result.loadedFiles.push(filePath);
          log?.(`[plugins] Loaded: ${filePath}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ file: filePath, error: message });
        log?.(`[plugins] Failed to load ${filePath}: ${message}`);
      }
    }
  }

  return result;
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
