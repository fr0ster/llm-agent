import type {
  CallOptions,
  ISkillSource,
  SkillIngestResult,
} from '@mcp-abap-adt/llm-agent';
import { buildIngestResult } from './marketplace-adapter.js';

/** Mockable transport over the marketplace registry: a manifest listing plus per-skill
 *  SKILL.md fetch. The unit tests inject a fake; {@link makeHttpTransport} is the live
 *  global-`fetch` implementation (exercised end-to-end, not in unit tests). */
export interface IMarketplaceTransport {
  /** List every plugin the registry offers, with its version and skill names. */
  listPlugins(): Promise<
    Array<{ plugin: string; version: string; skills: string[] }>
  >;
  /** Fetch the raw SKILL.md text for one skill of one plugin. */
  fetchSkillMd(plugin: string, skill: string): Promise<string>;
}

export interface HttpMarketplaceSourceOptions {
  /** Stable sourceId stamped onto every record/collection. */
  source: string;
  /** Plugins to enable; non-empty required. `['*']` = every offered plugin. */
  enabled: readonly string[];
  transport: IMarketplaceTransport;
  chunk: { maxChars: number };
  /** plugin → its group + description; default one-group-per-plugin. */
  placement?: (plugin: string) => { group: string; description: string };
}

const defaultPlacement = (plugin: string) => ({
  group: plugin,
  description: plugin,
});

/** Build an {@link ISkillSource} backed by a marketplace {@link IMarketplaceTransport}.
 *  `acquire()` resolves the enabled plugin set against the registry manifest, fetches each
 *  SKILL.md, and delegates placement/chunking to {@link buildIngestResult}. FS/network-free
 *  given a mock transport. */
export function makeHttpMarketplaceSource(
  opts: HttpMarketplaceSourceOptions,
): ISkillSource {
  if (opts.enabled.length === 0) {
    throw new Error('makeHttpMarketplaceSource: `enabled` must be non-empty');
  }
  const placement = opts.placement ?? defaultPlacement;
  const wantAll = opts.enabled.includes('*');
  const enabledSet = new Set(opts.enabled);

  return {
    async acquire(_options?: CallOptions): Promise<SkillIngestResult> {
      const offered = await opts.transport.listPlugins();
      const selected = wantAll
        ? offered
        : offered.filter((p) => enabledSet.has(p.plugin));

      const plugins = await Promise.all(
        selected.map(async (p) => ({
          plugin: p.plugin,
          version: p.version,
          skills: await Promise.all(
            p.skills.map(async (skill) => ({
              skill,
              skillMd: await opts.transport.fetchSkillMd(p.plugin, skill),
            })),
          ),
        })),
      );

      return buildIngestResult({
        source: opts.source,
        plugins,
        chunk: opts.chunk,
        placement,
      });
    },
  };
}

export interface HttpTransportOptions {
  /** Base URL of the marketplace registry (no trailing slash required). */
  registry: string;
  /** Optional bearer token sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
}

/** Live {@link IMarketplaceTransport} over global `fetch`. NOT unit-tested (no real network
 *  in tests); exercised live against a registry. Endpoints:
 *  `GET {registry}/plugins` → `[{ plugin, version, skills }]`;
 *  `GET {registry}/plugins/{plugin}/skills/{skill}` → raw SKILL.md text. */
export function makeHttpTransport(
  opts: HttpTransportOptions,
): IMarketplaceTransport {
  const base = opts.registry.replace(/\/+$/, '');
  const headers: Record<string, string> = opts.apiKey
    ? { authorization: `Bearer ${opts.apiKey}` }
    : {};

  return {
    async listPlugins() {
      const res = await fetch(`${base}/plugins`, { headers });
      if (!res.ok) {
        throw new Error(`listPlugins ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as Array<{
        plugin: string;
        version: string;
        skills: string[];
      }>;
    },
    async fetchSkillMd(plugin: string, skill: string) {
      const url = `${base}/plugins/${encodeURIComponent(plugin)}/skills/${encodeURIComponent(skill)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(
          `fetchSkillMd(${plugin}/${skill}) ${res.status} ${res.statusText}`,
        );
      }
      return await res.text();
    },
  };
}
