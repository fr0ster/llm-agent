/**
 * Plugin contract types.
 *
 * Type declarations moved to @mcp-abap-adt/llm-agent.
 * This file re-exports them and provides the runtime helper functions.
 */
/**
 * Creates an empty {@link LoadedPlugins} object.
 * Useful for custom `IPluginLoader` implementations.
 */
export function emptyLoadedPlugins() {
  return {
    stageHandlers: new Map(),
    embedderFactories: {},
    mcpClients: [],
    clientAdapters: [],
    apiAdapters: new Map(),
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
export function mergePluginExports(result, mod, source) {
  let registered = false;
  if (mod.stageHandlers && typeof mod.stageHandlers === 'object') {
    for (const [type, handler] of Object.entries(mod.stageHandlers)) {
      if (handler && typeof handler.execute === 'function') {
        result.stageHandlers.set(type, handler);
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
        result.apiAdapters.set(name, adapter);
        registered = true;
      }
    }
  }
  if (registered) {
    result.loadedFiles.push(source);
  }
  return registered;
}
//# sourceMappingURL=types.js.map
