# GitHub Skill Source Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the skill plugin-host self-fetch skills from a GitHub Claude-plugin repo (e.g. `https://github.com/secondsky/sap-skills.git`) over HTTPS into memory — no `git clone`, no filesystem.

**Architecture:** Add a new `IMarketplaceTransport` implementation (`makeGitHubTransport`) that reads the standard Claude-plugin layout from GitHub: the marketplace manifest and each `SKILL.md` from `raw.githubusercontent.com`, and the per-plugin `skills/` directory listing from the GitHub Contents API. The existing `makeHttpMarketplaceSource`, both source strategies, the marketplace adapter, and the store are transport-agnostic and stay unchanged. Config grows a `github`/`ref`/`token` source variant; `buildSources` picks the transport by which field is present.

**Tech Stack:** TypeScript (ESM, strict), `node:test` + `tsx`, global `fetch`. Packages: `@mcp-abap-adt/llm-agent-libs` (transport), `@mcp-abap-adt/llm-agent-server-libs` (config + wiring).

**Spec:** `docs/superpowers/specs/2026-06-22-github-skill-source-strategy-design.md`

---

## File Structure

- **Create** `packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts` — `makeGitHubTransport` + the three pure helpers (`parseGitHubRepo`, `parseMarketplace`, `skillDirsFromContents`). One responsibility: turn a GitHub repo coordinate into an `IMarketplaceTransport`.
- **Create** `packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts` — unit tests (pure helpers + transport via injected fake `fetch`).
- **Modify** `packages/llm-agent-libs/src/skills/plugin-host/index.ts` — re-export `makeGitHubTransport`, `parseGitHubRepo`. (Already flows up through `llm-agent-libs/src/index.ts:210` `export * from './skills/plugin-host/index.js'`.)
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.ts` — extend `SkillPluginsFetchedSource` + parse `github`/`ref`/`token` with `github` XOR `registry` fail-loud.
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.test.ts` — config-parse tests.
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.ts` — in `buildSources()`, pick `makeGitHubTransport` when `github` present.
- **Modify** `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.test.ts` — wiring test (a `github` source builds a GitHub-backed source).

### Conventions (match existing code)

- ESM: import siblings with a `.js` extension even from `.ts` files.
- Test header (copy from `source-strategies.test.ts`):
  ```ts
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  ```
- Run one test file from the repo root:
  ```bash
  node --import tsx/esm --test --test-reporter=spec \
    packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
  ```
- Run a whole package's tests:
  ```bash
  npm -w @mcp-abap-adt/llm-agent-libs run test
  npm -w @mcp-abap-adt/llm-agent-server-libs run test
  ```
- Lint/build the touched packages before finishing:
  ```bash
  npm run lint && npm run build
  ```

---

## Task 1: Pure helpers (`parseGitHubRepo`, `parseMarketplace`, `skillDirsFromContents`)

**Files:**
- Create: `packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `github-transport.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseGitHubRepo,
  parseMarketplace,
  skillDirsFromContents,
} from './github-transport.js';

test('parseGitHubRepo accepts all URL forms', () => {
  const expected = { owner: 'secondsky', repo: 'sap-skills' };
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills.git'),
    expected,
  );
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills'),
    expected,
  );
  assert.deepEqual(parseGitHubRepo('github.com/secondsky/sap-skills'), expected);
  assert.deepEqual(parseGitHubRepo('secondsky/sap-skills'), expected);
  assert.deepEqual(
    parseGitHubRepo('https://github.com/secondsky/sap-skills/'),
    expected,
  );
});

test('parseGitHubRepo throws on garbage', () => {
  assert.throws(() => parseGitHubRepo('not a repo'), /cannot parse GitHub repo/);
});

test('parseMarketplace maps plugins[] and strips a leading ./', () => {
  const out = parseMarketplace({
    plugins: [
      { name: 'sap-abap', version: '2.3.2', source: './plugins/sap-abap' },
      { name: 'x', source: 'plugins/x' },
    ],
  });
  assert.deepEqual(out, [
    { plugin: 'sap-abap', version: '2.3.2', sourcePath: 'plugins/sap-abap' },
    { plugin: 'x', version: '0.0.0', sourcePath: 'plugins/x' },
  ]);
});

test('parseMarketplace throws when plugins[] is missing', () => {
  assert.throws(() => parseMarketplace({}), /no plugins\[\] array/);
});

test('skillDirsFromContents returns only dir entries', () => {
  const out = skillDirsFromContents([
    { name: 'sap-abap', type: 'dir' },
    { name: 'README.md', type: 'file' },
    { name: 'extra', type: 'dir' },
  ]);
  assert.deepEqual(out, ['sap-abap', 'extra']);
});

test('skillDirsFromContents throws on a non-array', () => {
  assert.throws(
    () => skillDirsFromContents({ message: 'Not Found' }),
    /expected a Contents-API directory array/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
```
Expected: FAIL — cannot resolve `./github-transport.js` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `github-transport.ts` with the helpers (transport added in Task 2):

```ts
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
    throw new Error('parseMarketplace: marketplace.json has no plugins[] array');
  }
  return plugins.map((p) => {
    const o = p as { name?: unknown; version?: unknown; source?: unknown };
    if (typeof o.name !== 'string' || o.name.length === 0) {
      throw new Error('parseMarketplace: a plugin entry is missing a string name');
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
```

> Note: the unused `IMarketplaceTransport` import is consumed in Task 2. If the linter rejects an unused import between tasks, add the import in Task 2's step instead — but Task 2 follows immediately, so leaving it is fine.

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
```
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts \
        packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
git commit -m "feat(skills): GitHub transport pure helpers (parse repo/manifest/contents)"
```

---

## Task 2: `makeGitHubTransport` (listPlugins + fetchSkillMd)

**Files:**
- Modify: `packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts`
- Test: `packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `github-transport.test.ts`:

```ts
import { makeGitHubTransport } from './github-transport.js';

/** Build a fake `fetch` from a URL→response map. Each value is `{ status?, body }`
 *  where body is an object (JSON) or string (raw text). Unmapped URL → 404. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const headers: Array<Record<string, string> | undefined> = [];
  const impl = async (
    input: unknown,
    init?: { headers?: Record<string, string> },
  ) => {
    const url = String(input);
    calls.push(url);
    headers.push(init?.headers);
    const hit = routes[url];
    const status = hit?.status ?? (hit ? 200 : 404);
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Not Found',
      json: async () => hit?.body,
      text: async () => String(hit?.body ?? ''),
    } as unknown as Response;
  };
  return { impl: impl as unknown as typeof fetch, calls, headers };
}

const RAW = 'https://raw.githubusercontent.com';
const API = 'https://api.github.com';

const MARKETPLACE = {
  plugins: [
    { name: 'sap-abap', version: '2.3.2', source: './plugins/sap-abap' },
    { name: 'sap-btp', version: '1.0.0', source: './plugins/sap-btp' },
    { name: 'unused', version: '9.9.9', source: './plugins/unused' },
  ],
};

test('listPlugins resolves default branch and enumerates ONLY enabled plugins', async () => {
  const { impl, calls } = fakeFetch({
    [`${API}/repos/o/r`]: { body: { default_branch: 'main' } },
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
    [`${API}/repos/o/r/contents/plugins/sap-btp/skills?ref=main`]: {
      body: [{ name: 'sap-btp', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    enabled: ['sap-abap', 'sap-btp'],
    fetchImpl: impl,
  });
  const out = await t.listPlugins();
  assert.deepEqual(out, [
    { plugin: 'sap-abap', version: '2.3.2', skills: ['sap-abap'] },
    { plugin: 'sap-btp', version: '1.0.0', skills: ['sap-btp'] },
  ]);
  // The 'unused' plugin must NOT be enumerated (no Contents-API call for it).
  assert.ok(!calls.some((u) => u.includes('plugins/unused/skills')));
});

test('an explicit ref skips the default-branch metadata call', async () => {
  const { impl, calls } = fakeFetch({
    [`${RAW}/o/r/dev/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=dev`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'dev',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await t.listPlugins();
  assert.ok(!calls.some((u) => u === `${API}/repos/o/r`));
});

test('fetchSkillMd hits the raw SKILL.md URL and returns the body', async () => {
  const { impl } = fakeFetch({
    [`${API}/repos/o/r`]: { body: { default_branch: 'main' } },
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${RAW}/o/r/main/plugins/sap-abap/skills/sap-abap/SKILL.md`]: {
      body: '# ABAP skill',
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  assert.equal(await t.fetchSkillMd('sap-abap', 'sap-abap'), '# ABAP skill');
});

test('a token attaches an Authorization header to every request', async () => {
  // Proper response sequence: marketplace JSON for the manifest URL, a directory
  // array for the one enabled plugin's Contents URL. (ref is provided, so no
  // default-branch metadata call.) Then assert EVERY captured call carried auth.
  const { impl, headers } = fakeFetch({
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      body: [{ name: 'sap-abap', type: 'dir' }],
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'main',
    token: 'gho_x',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await t.listPlugins();
  assert.ok(headers.length > 0);
  for (const h of headers) {
    assert.equal(h?.authorization, 'Bearer gho_x');
  }
});

test('listPlugins throws with a token hint on a 403', async () => {
  const { impl } = fakeFetch({
    [`${RAW}/o/r/main/.claude-plugin/marketplace.json`]: { body: MARKETPLACE },
    [`${API}/repos/o/r/contents/plugins/sap-abap/skills?ref=main`]: {
      status: 403,
      body: {},
    },
  });
  const t = makeGitHubTransport({
    owner: 'o',
    repo: 'r',
    ref: 'main',
    enabled: ['sap-abap'],
    fetchImpl: impl,
  });
  await assert.rejects(() => t.listPlugins(), /set a token/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
```
Expected: FAIL — `makeGitHubTransport` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `github-transport.ts`:

```ts
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
    const res = await doFetch(`${API_BASE}/repos/${owner}/${repo}`, { headers });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
```
Expected: PASS — all tests pass (11 total across Tasks 1+2).

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts \
        packages/llm-agent-libs/src/skills/plugin-host/github-transport.test.ts
git commit -m "feat(skills): makeGitHubTransport (self-fetch skills from a GitHub repo, zero-FS)"
```

---

## Task 3: Export from the package index

**Files:**
- Modify: `packages/llm-agent-libs/src/skills/plugin-host/index.ts:11-15`

- [ ] **Step 1: Add the exports**

The current block re-exports the HTTP transport:
```ts
export {
  type HttpMarketplaceSourceOptions,
  type HttpTransportOptions,
  type IMarketplaceTransport,
  makeHttpMarketplaceSource,
  makeHttpTransport,
} from './http-marketplace-source.js';
```

Add a sibling re-export of the GitHub transport immediately after that block:
```ts
export {
  type GitHubTransportOptions,
  makeGitHubTransport,
  parseGitHubRepo,
} from './github-transport.js';
```

(`parseMarketplace`/`skillDirsFromContents` stay internal — only `makeGitHubTransport` + `parseGitHubRepo` are needed by the wiring layer.)

- [ ] **Step 2: Verify the export builds and is reachable**

Run:
```bash
npm -w @mcp-abap-adt/llm-agent-libs run build
node --import tsx/esm -e "import('@mcp-abap-adt/llm-agent-libs').then(m => { if (typeof m.makeGitHubTransport !== 'function' || typeof m.parseGitHubRepo !== 'function') throw new Error('missing export'); console.log('exports OK'); })"
```
Expected: build succeeds; prints `exports OK`.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent-libs/src/skills/plugin-host/index.ts
git commit -m "feat(skills): export makeGitHubTransport + parseGitHubRepo"
```

---

## Task 4: Config schema + parse (`github` XOR `registry`, `ref`, `token`)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.ts:28-36` (interface), `:188-221` (fetched-source parse)
- Test: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.test.ts`

> Env expansion (`${GITHUB_TOKEN}`) happens UPSTREAM in the YAML loader, exactly like `registry`/`apiKey`. The parser reads `raw.token` verbatim — no env handling here.

- [ ] **Step 1: Write the failing test**

Append to `skill-plugins-config.test.ts` (match the file's existing import of `parseSkillPluginsConfig`; if it is not yet imported there, add `import { parseSkillPluginsConfig } from './skill-plugins-config.js';` with the other imports):

```ts
test('a github source parses with ref + token', () => {
  const cfg = parseSkillPluginsConfig({
    store: { type: 'in-memory' },
    embedder: { provider: 'sap-ai-core', model: 'text-embedding-3-small' },
    sources: [
      {
        id: 'sap-skills',
        github: 'https://github.com/secondsky/sap-skills.git',
        ref: 'main',
        token: 'gho_x',
        enabled: ['sap-abap'],
        strategy: 'single-collection',
        strategyConfig: { collection: 'sap' },
      },
    ],
  });
  const src = cfg.sources?.[0] as {
    github?: string;
    ref?: string;
    token?: string;
  };
  assert.equal(src.github, 'https://github.com/secondsky/sap-skills.git');
  assert.equal(src.ref, 'main');
  assert.equal(src.token, 'gho_x');
});

test('a fetched source with BOTH github and registry fails loud', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'in-memory' },
        embedder: { provider: 'sap-ai-core', model: 'm' },
        sources: [
          {
            id: 'x',
            github: 'secondsky/sap-skills',
            registry: 'http://localhost:4100',
            enabled: ['sap-abap'],
          },
        ],
      }),
    /exactly one of 'registry' or 'github'/,
  );
});

test('a fetched source with NEITHER github nor registry fails loud', () => {
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        store: { type: 'in-memory' },
        embedder: { provider: 'sap-ai-core', model: 'm' },
        sources: [{ id: 'x', enabled: ['sap-abap'] }],
      }),
    /exactly one of 'registry' or 'github'/,
  );
});

test('a fetched source rejects an empty / non-string selector', () => {
  const base = {
    store: { type: 'in-memory' as const },
    embedder: { provider: 'sap-ai-core', model: 'm' },
  };
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        ...base,
        sources: [{ id: 'x', registry: '', enabled: ['a'] }],
      }),
    /registry must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        ...base,
        sources: [{ id: 'x', github: '', enabled: ['a'] }],
      }),
    /github must be a non-empty string/,
  );
  assert.throws(
    () =>
      parseSkillPluginsConfig({
        ...base,
        sources: [{ id: 'x', registry: 123, enabled: ['a'] }],
      }),
    /registry must be a non-empty string/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.test.ts
```
Expected: FAIL — `github`/`ref`/`token` are dropped (not parsed) and the XOR check does not exist.

- [ ] **Step 3: Extend the interface**

In `skill-plugins-config.ts`, replace the `SkillPluginsFetchedSource` interface body (currently `id`, `registry?`, `enabled?`, `strategy?`, `strategyConfig?`) with:

```ts
/** A FETCHED source: a marketplace/registry pulled into memory. Requires a
 *  non-empty `enabled` plugin list AND exactly one transport selector
 *  (`registry` for an HTTP marketplace, or `github` for a GitHub repo). */
export interface SkillPluginsFetchedSource {
  id: string;
  /** HTTP marketplace base URL. Mutually exclusive with `github`. */
  registry?: string;
  /** GitHub repo URL or bare `owner/repo`. Mutually exclusive with `registry`. */
  github?: string;
  /** Branch/tag/sha for a `github` source; default = repo `default_branch`. */
  ref?: string;
  /** Optional auth token for a `github` source (env-expanded upstream). */
  token?: string;
  enabled?: readonly string[];
  /** Acquisition/materialisation strategy name (validated via the registry). */
  strategy?: string;
  /** Opaque, strategy-specific config (incl. any placement rules). */
  strategyConfig?: Record<string, unknown>;
}
```

- [ ] **Step 4: Parse the new fields + non-empty validation + XOR check**

Currently the fetched-source path builds `out` with an inline conditional copy of
`registry` (`...(typeof raw.registry === 'string' ? { registry: raw.registry } : {})`).
**Replace that whole `out` construction** (the object literal plus the inline
`registry` copy) with an explicit, validated build. Both selectors are validated
as **non-empty strings** so `registry: ''` / `github: ''` / a non-string can no
longer slip through the XOR check into `makeHttpTransport({ registry: '' })`:

```ts
const out: SkillPluginsFetchedSource = {
  id,
  enabled: enabled as readonly string[],
};
if (raw.registry !== undefined) {
  if (typeof raw.registry !== 'string' || raw.registry.length === 0) {
    fail(`source '${id}': registry must be a non-empty string`);
  }
  out.registry = raw.registry;
}
if (raw.github !== undefined) {
  if (typeof raw.github !== 'string' || raw.github.length === 0) {
    fail(`source '${id}': github must be a non-empty string`);
  }
  out.github = raw.github;
}
if (raw.ref !== undefined) {
  if (typeof raw.ref !== 'string') {
    fail(`source '${id}': ref must be a string`);
  }
  out.ref = raw.ref;
}
if (raw.token !== undefined) {
  if (typeof raw.token !== 'string') {
    fail(`source '${id}': token must be a string`);
  }
  out.token = raw.token;
}
if ((out.registry === undefined) === (out.github === undefined)) {
  fail(
    `source '${id}': a fetched source needs exactly one of 'registry' or 'github'`,
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.test.ts
```
Expected: PASS — the four new tests pass and existing config tests still pass.

> If any PRE-EXISTING config test now fails because it declared a fetched source with neither `registry` nor `github` (relying on the old silently-optional `registry`), that test was asserting the old loose behaviour. Update it to include a `registry` (or `github`) — the XOR rule is intended. Do NOT weaken the XOR check to keep a loose test green.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.ts \
        packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.test.ts
git commit -m "feat(skills): config supports a github source (github XOR registry, ref, token)"
```

---

## Task 5: Wire the transport in `buildSources` (DI seam, real wiring tested)

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.ts:35-50` (imports), `:152-180` (`buildSources`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.test.ts`

> The reviewer flagged that testing a `chooseTransportKind` predicate would not
> catch a broken implementation that drops `ref`/`token`/`enabled` or skips
> `parseGitHubRepo`. Instead, give `buildSources` a **transport-factory DI seam**
> (defaulting to the real factories) and assert the GitHub source ACTUALLY
> constructs `makeGitHubTransport` with the right options. No production export
> exists solely for the test — the seam is a real, defaulted parameter.

- [ ] **Step 1: Write the failing test**

Append to `skill-plugins-host-factory.test.ts`. (The file already imports `assert`
and `test`; ensure `SkillPluginsConfig` is imported — if not, add
`import type { SkillPluginsConfig } from './skill-plugins-config.js';`. Also add
`import type { GitHubTransportOptions } from '@mcp-abap-adt/llm-agent-libs';`.)

```ts
import {
  buildSources,
  type TransportFactories,
} from './skill-plugins-host-factory.js';
import type { GitHubTransportOptions } from '@mcp-abap-adt/llm-agent-libs';

const STUB_TRANSPORT = {
  listPlugins: async () => [],
  fetchSkillMd: async () => '',
};

test('buildSources builds a github source, threading repo/ref/token/enabled', () => {
  let captured: GitHubTransportOptions | undefined;
  const factories: TransportFactories = {
    github: (opts) => {
      captured = opts;
      return STUB_TRANSPORT;
    },
    http: () => {
      throw new Error('should not build an http transport for a github source');
    },
  };
  const sources = buildSources(
    {
      chunk: { maxChars: 1000 },
      sources: [
        {
          id: 'sap-skills',
          github: 'https://github.com/secondsky/sap-skills.git',
          ref: 'main',
          token: 'gho_x',
          enabled: ['sap-abap'],
          strategy: 'single-collection',
          strategyConfig: { collection: 'sap' },
        },
      ],
    } as unknown as SkillPluginsConfig,
    factories,
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'sap-skills');
  // parseGitHubRepo ran (URL → owner/repo) AND ref/token/enabled were threaded.
  assert.deepEqual(captured, {
    owner: 'secondsky',
    repo: 'sap-skills',
    ref: 'main',
    token: 'gho_x',
    enabled: ['sap-abap'],
  });
});

test('buildSources builds an http source from registry', () => {
  let registry: string | undefined;
  const factories: TransportFactories = {
    github: () => {
      throw new Error('should not build a github transport for a registry source');
    },
    http: (opts) => {
      registry = opts.registry;
      return STUB_TRANSPORT;
    },
  };
  const sources = buildSources(
    {
      chunk: { maxChars: 1000 },
      sources: [{ id: 'r', registry: 'http://h', enabled: ['*'] }],
    } as unknown as SkillPluginsConfig,
    factories,
  );
  assert.equal(sources.length, 1);
  assert.equal(registry, 'http://h');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.test.ts
```
Expected: FAIL — `buildSources` / `TransportFactories` are not exported, and
`buildSources` does not yet accept a factories argument.

- [ ] **Step 3: Add the imports, the DI seam, and the github branch**

In `skill-plugins-host-factory.ts`, extend the existing
`@mcp-abap-adt/llm-agent-libs` import block (which already imports
`makeHttpTransport`) to also bring in the GitHub transport, the option/transport
types, and `parseGitHubRepo`:

```ts
  type GitHubTransportOptions,
  type HttpTransportOptions,
  type IMarketplaceTransport,
  makeGitHubTransport,
  makeHttpTransport,
  parseGitHubRepo,
```

Define the DI seam + default just above `buildSources`:

```ts
/** Transport factories for {@link buildSources}. A DI seam: production uses the
 *  defaults; unit tests inject capturing stubs to assert the wiring without
 *  touching the network. */
export interface TransportFactories {
  github: (opts: GitHubTransportOptions) => IMarketplaceTransport;
  http: (opts: HttpTransportOptions) => IMarketplaceTransport;
}

const defaultTransports: TransportFactories = {
  github: makeGitHubTransport,
  http: makeHttpTransport,
};
```

Change `buildSources` to be EXPORTED, take the factories (defaulted), and pick
the transport by the present selector. The whole function becomes:

```ts
/** Map every config source to a `{ id, source }` ingest entry. */
export function buildSources(
  cfg: SkillPluginsConfig,
  transports: TransportFactories = defaultTransports,
): ReadonlyArray<{ id: string; source: ISkillSource }> {
  const out: { id: string; source: ISkillSource }[] = [];
  for (const src of cfg.sources ?? []) {
    if ('records' in src) {
      out.push({ id: src.id, source: makeRecordsSource(src) });
      continue;
    }
    // Fetched source → resolve the named strategy + pick a transport by selector.
    const strategy = resolveSkillSourceStrategy(
      src.strategy ?? 'one-group-per-plugin',
    );
    const transport =
      src.github !== undefined
        ? transports.github({
            ...parseGitHubRepo(src.github),
            ...(src.ref !== undefined ? { ref: src.ref } : {}),
            ...(src.token !== undefined ? { token: src.token } : {}),
            enabled: src.enabled ?? [],
          })
        : transports.http({ registry: src.registry ?? '' });
    out.push({
      id: src.id,
      source: strategy({
        source: src.id,
        enabled: src.enabled ?? [],
        transport,
        chunk: cfg.chunk,
        ...(src.strategyConfig !== undefined
          ? { strategyConfig: src.strategyConfig }
          : {}),
      }),
    });
  }
  return out;
}
```

> `buildSkillHostFromConfig` already calls `const sources = buildSources(cfg);` —
> the new second parameter is defaulted, so that call is unchanged and uses the
> real factories. The `'records' in src` guard narrows `src` to
> `SkillPluginsFetchedSource`, so `src.github`/`src.ref`/`src.token` are in scope
> with no cast (Task 4 added those fields to the type).

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --import tsx/esm --test --test-reporter=spec \
  packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.test.ts
```
Expected: PASS — both new wiring tests pass; existing factory tests still pass.

- [ ] **Step 5: Build the package to confirm types**

Run:
```bash
npm -w @mcp-abap-adt/llm-agent-server-libs run build
```
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.ts \
        packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.test.ts
git commit -m "feat(skills): wire github source transport in buildSources (DI seam)"
```

---

## Task 6: Full build + lint + docs example

**Files:**
- Create: `docs/examples/skill-plugins-github.yaml`

- [ ] **Step 1: Add a documented config example**

Create `docs/examples/skill-plugins-github.yaml`:

```yaml
# Skill plugin-host that SELF-FETCHES skills from a GitHub Claude-plugin repo.
# The host downloads marketplace.json + each SKILL.md over HTTPS into memory
# (no git clone, no filesystem). marketplace.json + the Contents API are used to
# enumerate skills; raw.githubusercontent.com fetches the bodies.
#
# Usage:
#   npm run dev -- --config docs/examples/skill-plugins-github.yaml
port: 4004
host: 0.0.0.0

llm:
  main:
    provider: sap-ai-sdk
    model: anthropic--claude-4.6-sonnet

pipeline:
  name: controller

rag:
  type: in-memory
  embedder: sap-ai-core
  scenario: foundation-models
  resourceGroup: default
  model: text-embedding-3-small

skillPlugins:
  store: { type: in-memory }
  embedder: { provider: sap-ai-core, model: text-embedding-3-small }
  controllerSkillGroup: sap
  sources:
    - id: sap-skills
      github: https://github.com/secondsky/sap-skills.git   # host self-fetches
      # ref: main            # optional; default = repo default_branch
      # token: ${GITHUB_TOKEN}  # optional; lifts rate limit + private repos
      enabled: [sap-abap, sap-btp-developer-guide]
      strategy: single-collection
      strategyConfig: { collection: sap }
```

- [ ] **Step 2: Run the full test suite + lint + build**

Run:
```bash
npm test
npm run lint:check
npm run build
```
Expected: all workspace tests pass; lint reports no errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add docs/examples/skill-plugins-github.yaml
git commit -m "docs(examples): github skill-source config example"
```

---

## Task 7: Live verification (manual — no shim)

This is a manual smoke test, run only after Tasks 1–6 are green. It is the
acceptance criterion the feature exists for: the host fetches the skills itself.

- [ ] **Step 1: Point the review config at the GitHub repo**

Edit `.run/skills-review.yaml`'s `skillPlugins.sources[0]` to drop `registry`
and use `github` (no marketplace shim):

```yaml
  sources:
    - id: sap-skills
      github: https://github.com/secondsky/sap-skills.git
      enabled: [sap-abap, sap-btp-developer-guide]
      strategy: single-collection
      strategyConfig: { collection: sap }
```

- [ ] **Step 2: Start the server (no local shim process)**

```bash
npm run build
npm run dev -- --config .run/skills-review.yaml
```
Expected (in the server log): the host loads BOTH `sap-abap` and
`sap-btp-developer-guide` — fetched directly from GitHub — and startup does not
error on `controllerSkillGroup: sap`.

- [ ] **Step 3: Run the review prompt and confirm skill use**

Send the prompt `Review ABAP program zdms_upload_files, check security, performance, CleanCore, maintainability` to the running server (MCP on :3003). Confirm the controller recalls from the `sap` group and the run finalizes with no errors.

> No commit — this is verification. Report the outcome to the user. If the host
> cannot reach GitHub from the run environment, note it and fall back to
> reporting the unit-test evidence (the transport is fully covered) rather than
> re-introducing the shim.

---

## Self-Review

**1. Spec coverage:**
- No clone / zero-FS → Task 2 (HTTPS-only transport, in-memory manifest cache). ✓
- Standard layout / `marketplace.json` + `skills/` listing → Tasks 1–2. ✓
- Contents-API listing + raw bodies (hybrid) → Task 2 `listPlugins`/`fetchSkillMd`. ✓
- Enumerate only enabled → Task 2 test "ONLY enabled". ✓
- Optional token, public default → Task 2 token test; Task 4 config `token`. ✓
- `github` XOR `registry` fail-loud + non-empty validation → Task 4 (+ empty/non-string tests). ✓
- Wiring picks transport (real `buildSources` via DI seam) → Task 5. ✓
- Default-branch resolution + explicit ref skip → Task 2 tests. ✓
- 403 token hint → Task 2 test. ✓
- Index export → Task 3. ✓
- Live verification → Task 7. ✓
- Docs example → Task 6. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output. ✓

**3. Type consistency:** `makeGitHubTransport`/`GitHubTransportOptions`/`parseGitHubRepo`/`parseMarketplace`/`skillDirsFromContents` and the `{ owner, repo, ref?, token?, enabled, fetchImpl? }` option shape are used identically across Tasks 1, 2, 3, and 5. `TransportFactories` (`{ github, http }`) is defined and consumed in Task 5 only. `SkillPluginsFetchedSource` field names (`github`/`ref`/`token`/`registry`/`enabled`) match between Task 4 (definition) and Task 5 (use). The Task 5 test's `captured` deep-equal (`{owner,repo,ref,token,enabled}`) matches exactly what the `buildSources` github branch passes. ✓
