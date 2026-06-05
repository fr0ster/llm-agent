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
    pipelinePluginSources: new Map(),
    loadedFiles: [],
    errors: [],
  };
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

  if (mod.pipelinePlugins && typeof mod.pipelinePlugins === 'object') {
    for (const [name, plugin] of Object.entries(mod.pipelinePlugins)) {
      if (!plugin || typeof (plugin as IPipelinePlugin).build !== 'function') continue;
      if (result.pipelinePlugins.has(name)) {
        const prior = result.pipelinePluginSources.get(name) ?? 'unknown';
        result.errors.push({
          file: source,
          error: `duplicate pipeline name '${name}' from '${source}'; already registered by '${prior}' (keeping the first)`,
        });
        continue; // keep the first
      }
      result.pipelinePlugins.set(name, plugin as IPipelinePlugin);
      result.pipelinePluginSources.set(name, source);
      registered = true;
    }
  }

  if (registered) {
    result.loadedFiles.push(source);
  }

  return registered;
}
