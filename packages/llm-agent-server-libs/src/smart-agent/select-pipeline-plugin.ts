import type {
  IPipelinePlugin,
  PipelinePluginFactory,
} from '@mcp-abap-adt/llm-agent';
import { describePipelinePluginDefect } from '@mcp-abap-adt/llm-agent-libs';

/**
 * Call the selected factory — once, and only that one — and check its result the way
 * the loader checks an instance export: a factory's contract is its RESULT, which
 * only exists once it runs (§4.6.7). Every failure names the module and the key.
 */
export function selectPipelinePlugin(
  factories: ReadonlyMap<string, PipelinePluginFactory>,
  sources: ReadonlyMap<string, string>,
  name: string,
  section: unknown,
): IPipelinePlugin {
  const factory = factories.get(name);
  if (!factory) {
    throw new Error(
      `unknown pipeline '${name}'; available: ${[...factories.keys()].join(', ')}`,
    );
  }
  const source = sources.get(name) ?? 'unknown';
  let plugin: unknown;
  try {
    plugin = factory(section);
  } catch (e) {
    throw new Error(
      `pipeline plugin '${name}' from '${source}' failed to construct: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const defect = describePipelinePluginDefect(plugin, name);
  if (defect !== undefined) {
    throw new Error(
      `pipeline plugin '${name}' from '${source}' refused: ${defect}`,
    );
  }
  return plugin as IPipelinePlugin;
}
