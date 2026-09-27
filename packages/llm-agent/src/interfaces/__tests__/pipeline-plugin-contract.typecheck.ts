// Compile-only assertions for §4.6.7: a plugin reads no configuration.
// Appended to tsconfig.typecheck.json.
import type {
  IPipelineContext,
  IPipelineInstance,
  IPipelinePlugin,
} from '../pipeline-plugin.js';
import type { PluginExports } from '../plugin.js';

declare const plugin: IPipelinePlugin;
declare const ctx: IPipelineContext;

// a plugin is name + build(ctx)
export const built: Promise<IPipelineInstance> = plugin.build(ctx);

// @ts-expect-error — a plugin reads no configuration: parseConfig is gone
export const parse = plugin.parseConfig;

// @ts-expect-error — build takes the context only
export const twoArgs = plugin.build({}, ctx);

// a factory returns a plugin, synchronously
export const factories: PluginExports['pipelinePluginFactories'] = {
  demo: (_raw) => plugin,
};
export const asyncFactory: PluginExports['pipelinePluginFactories'] = {
  // @ts-expect-error — not a promise of one
  demo: async () => plugin,
};
