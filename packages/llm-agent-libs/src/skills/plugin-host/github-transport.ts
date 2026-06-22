import type { IMarketplaceTransport } from './http-marketplace-source.js';

/** Parse `owner`/`repo` from a GitHub URL or bare `owner/repo`. */
export function parseGitHubRepo(url: string): { owner: string; repo: string } {
  const cleaned = url
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const m = cleaned.match(
    /^(?:https?:\/\/)?(?:github\.com\/)?([^/\s]+)\/([^/\s]+)$/,
  );
  if (!m) {
    throw new Error(`parseGitHubRepo: cannot parse GitHub repo from '${url}'`);
  }
  return { owner: m[1], repo: m[2] };
}

/** Map a parsed `.claude-plugin/marketplace.json` to plugin coordinates. */
export function parseMarketplace(
  json: unknown,
): Array<{ plugin: string; version: string; sourcePath: string }> {
  const plugins = (json as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(
      'parseMarketplace: marketplace.json has no plugins[] array',
    );
  }
  return plugins.map((p) => {
    const o = p as { name?: unknown; version?: unknown; source?: unknown };
    if (typeof o.name !== 'string' || o.name.length === 0) {
      throw new Error(
        'parseMarketplace: a plugin entry is missing a string name',
      );
    }
    const source =
      typeof o.source === 'string' ? o.source : `./plugins/${o.name}`;
    return {
      plugin: o.name,
      version: typeof o.version === 'string' ? o.version : '0.0.0',
      sourcePath: source.replace(/^\.\//, '').replace(/\/+$/, ''),
    };
  });
}

/** Extract subdirectory names from a GitHub Contents-API directory response. */
export function skillDirsFromContents(json: unknown): string[] {
  if (!Array.isArray(json)) {
    throw new Error(
      'skillDirsFromContents: expected a Contents-API directory array',
    );
  }
  return (json as Array<{ name?: unknown; type?: unknown }>)
    .filter((e) => e.type === 'dir' && typeof e.name === 'string')
    .map((e) => e.name as string);
}

const RAW_BASE = 'https://raw.githubusercontent.com';
const API_BASE = 'https://api.github.com';

export interface GitHubTransportOptions {
  owner: string;
  repo: string;
  /** Branch/tag/sha; default = the repo's `default_branch`. */
  ref?: string;
  /** Optional auth token (lifts rate limit + enables private repos). */
  token?: string;
  /** Plugins to enumerate; `['*']` = all. Only these get a Contents-API call. */
  enabled: readonly string[];
  /** Injected for tests; default global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * An {@link IMarketplaceTransport} over a GitHub Claude-plugin repo. Reads the
 * standard layout via HTTPS into memory (no clone, no FS): marketplace.json and
 * each SKILL.md from `raw.githubusercontent.com`; per-plugin `skills/` listings
 * from the GitHub Contents API. NOT unit-tested over a real network — the unit
 * tests inject `fetchImpl`.
 */
export function makeGitHubTransport(
  opts: GitHubTransportOptions,
): IMarketplaceTransport {
  const { owner, repo, token, enabled } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = token
    ? { authorization: `Bearer ${token}` }
    : {};
  const wantAll = enabled.includes('*');
  const enabledSet = new Set(enabled);

  let ref = opts.ref;
  let manifest:
    | Array<{ plugin: string; version: string; sourcePath: string }>
    | undefined;

  async function resolveRef(): Promise<string> {
    if (ref) return ref;
    const res = await doFetch(`${API_BASE}/repos/${owner}/${repo}`, {
      headers,
    });
    if (!res.ok) {
      throw new Error(`resolveRef ${res.status} ${res.statusText}`);
    }
    const meta = (await res.json()) as { default_branch?: string };
    ref = meta.default_branch ?? 'main';
    return ref;
  }

  async function loadManifest() {
    if (manifest) return manifest;
    const r = await resolveRef();
    const url = `${RAW_BASE}/${owner}/${repo}/${r}/.claude-plugin/marketplace.json`;
    const res = await doFetch(url, { headers });
    if (!res.ok) {
      throw new Error(`marketplace.json ${res.status} ${res.statusText}`);
    }
    manifest = parseMarketplace(await res.json());
    return manifest;
  }

  function sourcePathOf(plugin: string): string {
    const entry = manifest?.find((m) => m.plugin === plugin);
    if (!entry) {
      throw new Error(
        `github transport: unknown plugin '${plugin}' (not in marketplace.json)`,
      );
    }
    return entry.sourcePath;
  }

  return {
    async listPlugins() {
      const m = await loadManifest();
      const r = await resolveRef();
      const selected = wantAll ? m : m.filter((p) => enabledSet.has(p.plugin));
      return Promise.all(
        selected.map(async (p) => {
          const url = `${API_BASE}/repos/${owner}/${repo}/contents/${p.sourcePath}/skills?ref=${encodeURIComponent(r)}`;
          const res = await doFetch(url, { headers });
          if (!res.ok) {
            const hint = res.status === 403 ? ' (rate limit? set a token)' : '';
            throw new Error(
              `list skills(${p.plugin}) ${res.status} ${res.statusText}${hint}`,
            );
          }
          return {
            plugin: p.plugin,
            version: p.version,
            skills: skillDirsFromContents(await res.json()),
          };
        }),
      );
    },
    async fetchSkillMd(plugin: string, skill: string) {
      await loadManifest();
      const r = await resolveRef();
      const sp = sourcePathOf(plugin);
      const url = `${RAW_BASE}/${owner}/${repo}/${r}/${sp}/skills/${skill}/SKILL.md`;
      const res = await doFetch(url, { headers });
      if (!res.ok) {
        throw new Error(
          `fetchSkillMd(${plugin}/${skill}) ${res.status} ${res.statusText}`,
        );
      }
      return res.text();
    },
  };
}
