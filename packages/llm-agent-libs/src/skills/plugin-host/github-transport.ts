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
