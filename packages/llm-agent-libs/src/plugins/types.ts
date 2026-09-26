/**
 * Plugin contract types.
 *
 * Type declarations moved to @mcp-abap-adt/llm-agent.
 * This file re-exports them and provides the runtime helper functions.
 */

import type {
  ILlmApiAdapter,
  IPipelinePlugin,
  IPluginLoader,
  IStageHandler,
  LoadedPlugins,
  PipelinePluginFactory,
  PluginExports,
} from '@mcp-abap-adt/llm-agent';

export type { IPluginLoader, IStageHandler, LoadedPlugins, PluginExports };

/**
 * Creates an empty {@link LoadedPlugins} object.
 * Useful for custom `IPluginLoader` implementations.
 */
export function emptyLoadedPlugins(): LoadedPlugins {
  return {
    stageHandlers: new Map(),
    embedderFactories: {},
    mcpClients: [],
    clientAdapters: [],
    apiAdapters: new Map(),
    pipelinePlugins: new Map(),
    pipelinePluginFactories: new Map(),
    pipelinePluginSources: new Map(),
    loadedFiles: [],
    errors: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const kindOf = (v: unknown): string => (v === null ? 'null' : typeof v);

/**
 * What is wrong with a value offered as a pipeline plugin under `key`, or
 * `undefined` when nothing is. An imported module is `unknown` until something
 * inspects it, so this is the check that makes the cast after it honest (§4.6.7).
 * The loader runs it on an instance export; the server runs it on a factory's result.
 */
export function describePipelinePluginDefect(
  value: unknown,
  key: string,
): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return `expected an object with 'name' and 'build', got ${kindOf(value)}`;
  }
  const { name, build } = value as { name?: unknown; build?: unknown };
  const missing: string[] = [];
  if (typeof name !== 'string')
    missing.push(`'name' must be a string, got ${kindOf(name)}`);
  if (typeof build !== 'function')
    missing.push(`'build' must be a function, got ${kindOf(build)}`);
  if (missing.length > 0) return missing.join('; ');
  if (name !== key) {
    return `its name '${String(name)}' differs from the key '${key}' it is registered under`;
  }
  return undefined;
}

/**
 * Merges a single plugin module's exports into a {@link LoadedPlugins} result.
 * Useful for custom `IPluginLoader` implementations.
 *
 * @param result - Target to merge into (mutated in place).
 * @param mod    - Plugin module exports to merge.
 * @param source - Source identifier (file path, package name, etc.).
 * @returns `true` if any registrations were found.
 */
export function mergePluginExports(
  result: LoadedPlugins,
  mod: PluginExports,
  source: string,
): boolean {
  let registered = false;

  if (mod.stageHandlers && typeof mod.stageHandlers === 'object') {
    for (const [type, handler] of Object.entries(mod.stageHandlers)) {
      if (handler && typeof (handler as IStageHandler).execute === 'function') {
        result.stageHandlers.set(type, handler as IStageHandler);
        registered = true;
      }
    }
  }

  if (mod.embedderFactories && typeof mod.embedderFactories === 'object') {
    for (const [name, factory] of Object.entries(mod.embedderFactories)) {
      if (typeof factory === 'function') {
        result.embedderFactories[name] = factory;
        registered = true;
      }
    }
  }

  if (mod.reranker && typeof mod.reranker === 'object') {
    result.reranker = mod.reranker;
    registered = true;
  }

  if (mod.queryExpander && typeof mod.queryExpander === 'object') {
    result.queryExpander = mod.queryExpander;
    registered = true;
  }

  if (mod.outputValidator && typeof mod.outputValidator === 'object') {
    result.outputValidator = mod.outputValidator;
    registered = true;
  }

  if (mod.skillManager && typeof mod.skillManager === 'object') {
    result.skillManager = mod.skillManager;
    registered = true;
  }

  if (mod.mcpClients && Array.isArray(mod.mcpClients)) {
    result.mcpClients.push(...mod.mcpClients);
    registered = true;
  }

  if (mod.clientAdapters && Array.isArray(mod.clientAdapters)) {
    result.clientAdapters.push(...mod.clientAdapters);
    registered = true;
  }

  if (mod.apiAdapters && typeof mod.apiAdapters === 'object') {
    for (const [name, adapter] of Object.entries(mod.apiAdapters)) {
      if (adapter && typeof adapter === 'object' && 'name' in adapter) {
        result.apiAdapters.set(name, adapter as ILlmApiAdapter);
        registered = true;
      }
    }
  }

  // One key space for instances and factories; the first source keeps a key.
  const claim = (key: string): boolean => {
    const prior = result.pipelinePluginSources.get(key);
    if (prior === undefined) return true;
    result.errors.push({
      file: source,
      error: `duplicate pipeline name '${key}' from '${source}'; already registered by '${prior}' (keeping the first)`,
    });
    return false;
  };

  if (mod.pipelinePlugins !== undefined) {
    if (!isRecord(mod.pipelinePlugins)) {
      result.errors.push({
        file: source,
        error: `'pipelinePlugins' from '${source}' must be an object keyed by pipeline name`,
      });
    } else {
      for (const [key, plugin] of Object.entries(mod.pipelinePlugins)) {
        const defect = describePipelinePluginDefect(plugin, key);
        if (defect !== undefined) {
          result.errors.push({
            file: source,
            error: `pipeline plugin '${key}' from '${source}' refused: ${defect}`,
          });
          continue;
        }
        if (!claim(key)) continue;
        result.pipelinePlugins.set(key, plugin as IPipelinePlugin);
        result.pipelinePluginSources.set(key, source);
        registered = true;
      }
    }
  }

  if (mod.pipelinePluginFactories !== undefined) {
    if (!isRecord(mod.pipelinePluginFactories)) {
      result.errors.push({
        file: source,
        error: `'pipelinePluginFactories' from '${source}' must be an object keyed by pipeline name`,
      });
    } else {
      result.pipelinePluginFactories ??= new Map();
      const factories = result.pipelinePluginFactories;
      for (const [key, factory] of Object.entries(
        mod.pipelinePluginFactories,
      )) {
        if (typeof factory !== 'function') {
          result.errors.push({
            file: source,
            error: `pipeline plugin factory '${key}' from '${source}' refused: expected a function, got ${kindOf(factory)}`,
          });
          continue;
        }
        if (!claim(key)) continue;
        factories.set(key, factory as PipelinePluginFactory);
        result.pipelinePluginSources.set(key, source);
        registered = true;
      }
    }
  }

  if (registered) {
    result.loadedFiles.push(source);
  }

  return registered;
}
