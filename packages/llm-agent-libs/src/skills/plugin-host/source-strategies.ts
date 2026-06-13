import type { ISkillSource } from '@mcp-abap-adt/llm-agent';
import {
  type IMarketplaceTransport,
  makeHttpMarketplaceSource,
} from './http-marketplace-source.js';

/** A fetched source's config, resolved from YAML/CLI. A {@link SkillSourceStrategy}
 *  turns it into a concrete {@link ISkillSource} with strategy-specific placement. */
export type FetchedSourceConfig = {
  source: string;
  enabled: readonly string[];
  transport: IMarketplaceTransport;
  chunk: { maxChars: number };
  strategyConfig?: Record<string, unknown>;
};

/** Maps a {@link FetchedSourceConfig} to an {@link ISkillSource} (placement decided here). */
export type SkillSourceStrategy = (cfg: FetchedSourceConfig) => ISkillSource;

const registry = new Map<string, SkillSourceStrategy>();

/** Register (or override) a named source strategy. */
export function registerSkillSourceStrategy(
  name: string,
  f: SkillSourceStrategy,
): void {
  registry.set(name, f);
}

/** Resolve a registered strategy by name; throws (listing registered names) if unknown. */
export function resolveSkillSourceStrategy(name: string): SkillSourceStrategy {
  const f = registry.get(name);
  if (!f) {
    const known = [...registry.keys()].sort().join(', ');
    throw new Error(
      `unknown skill source strategy '${name}'; registered: ${known}`,
    );
  }
  return f;
}

// --- Built-in strategies (registered at module load) -----------------------

/** Default: one collection per plugin, named/described by the plugin id. */
registerSkillSourceStrategy('one-group-per-plugin', (cfg) =>
  makeHttpMarketplaceSource({
    source: cfg.source,
    enabled: cfg.enabled,
    transport: cfg.transport,
    chunk: cfg.chunk,
    placement: (plugin) => ({ group: plugin, description: plugin }),
  }),
);

/** Bundle every enabled plugin into ONE collection named by
 *  `strategyConfig.collection` (default `'skills'`). */
registerSkillSourceStrategy('single-collection', (cfg) => {
  const collection = String(cfg.strategyConfig?.collection ?? 'skills');
  return makeHttpMarketplaceSource({
    source: cfg.source,
    enabled: cfg.enabled,
    transport: cfg.transport,
    chunk: cfg.chunk,
    placement: () => ({ group: collection, description: collection }),
  });
});
