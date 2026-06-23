# GitHub Skill Source Strategy — Design

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan.

## Problem

The skill plugin-host is meant to **self-fetch** the skills a consumer declares
in `skillPlugins.sources` — the consumer writes config and the host pulls. Today
the host has exactly one fetched-source transport: `makeHttpTransport`, which
talks to an **HTTP marketplace** (`GET {registry}/plugins` +
`GET {registry}/plugins/{plugin}/skills/{skill}`). A raw git/GitHub Claude-plugin
repo URL (e.g. `https://github.com/secondsky/sap-skills.git`) is **not** such a
marketplace, so there is no way to point the host at a GitHub skills repo. The
only workaround has been to hand-clone the repo and run a local marketplace shim
— which defeats the purpose of a self-fetching host.

This design adds a **GitHub source** so a consumer configures only the repo URL
(plus the enabled plugins) and the host downloads the skills itself.

## Constraints (decided)

1. **No `git clone`, no filesystem.** The deployment may have no writable FS
   (serverless/edge). The host fetches files over **HTTPS into memory** only.
   This mirrors the existing in-memory store philosophy.
2. **Standard Claude-plugin layout is fixed.** Every Claude-plugin repo places
   files identically (this is how Anthropic's own loader finds them):
   ```
   .claude-plugin/marketplace.json            # lists plugins: name, source, version
   plugins/<plugin>/.claude-plugin/plugin.json
   plugins/<plugin>/skills/<skill>/SKILL.md   # the skills
   ```
   The transport relies on this fixed layout — no generic git-host abstraction,
   no path guessing.
3. **Skill discovery needs ONE directory listing.** `marketplace.json` lists
   plugins but **not** skill names; the skills are the `skills/<skill>/`
   subdirectories. `raw.githubusercontent.com` cannot list a directory, so the
   transport uses the **GitHub Contents API** to list `plugins/<plugin>/skills/`
   (the only HTTP way to enumerate a folder), then fetches each `SKILL.md` from
   `raw` (unlimited, no base64). — hybrid, per design decision.
4. **Auth: optional token, public default.** Public repos (e.g. `sap-skills`)
   work with no token. An optional token lifts the Contents-API rate limit
   (60/hr anon → 5000/hr) and enables private repos.

## Architecture

The existing `IMarketplaceTransport` (`listPlugins()` + `fetchSkillMd()`) is the
seam. `makeHttpMarketplaceSource`, both source strategies
(`one-group-per-plugin` / `single-collection`), the marketplace adapter, and the
store are all transport-agnostic. **A GitHub source is therefore just a new
transport** — zero changes to strategies, adapter, host, or store.

```
config github: → buildSources → makeGitHubTransport
                                       │ (IMarketplaceTransport)
                                       ▼
                              makeHttpMarketplaceSource (placement = strategy)
                                       │
                              host.load() → acquire()
                                       │
   raw marketplace.json  +  Contents-API skills listing  +  raw SKILL.md
                                       │
                              buildIngestResult → store        (zero FS)
```

### Component 1 — `makeGitHubTransport`

New file: `packages/llm-agent-libs/src/skills/plugin-host/github-transport.ts`.
Implements `IMarketplaceTransport`.

**Options:** `{ owner: string; repo: string; ref?: string; token?: string;
enabled: readonly string[]; fetchImpl?: typeof fetch }`.
`fetchImpl` defaults to global `fetch`; injected in unit tests (no real network).

**Pure, separately unit-tested helpers (no network):**

- `parseGitHubRepo(url: string): { owner: string; repo: string }` — accepts
  `https://github.com/owner/repo`, the same with a trailing `.git`,
  `github.com/owner/repo`, and bare `owner/repo`. Throws a clear error on an
  unparseable URL.
- `parseMarketplace(json: unknown): Array<{ plugin: string; version: string;
  sourcePath: string }>` — reads `plugins[]` (`name`→plugin, `version`,
  `source`→sourcePath, normalising a leading `./`). Throws if `plugins` is
  missing or not an array.
- `skillDirsFromContents(json: unknown): string[]` — from a Contents-API
  directory response, returns entry `name`s where `type === 'dir'`.

**`listPlugins()`:**

1. Resolve `ref`: if `ref` is unset, `GET https://api.github.com/repos/{owner}/{repo}`
   → use `default_branch`. (Cached on the instance after first resolution.)
2. `GET https://raw.githubusercontent.com/{owner}/{repo}/{ref}/.claude-plugin/marketplace.json`
   → `parseMarketplace` → cache a `plugin → sourcePath` map on the instance.
3. Determine the plugins to enumerate: if `enabled` includes `'*'`, all plugins
   from the manifest; otherwise only the manifest plugins whose name is in
   `enabled`. (Enumerating skills for only the enabled subset avoids spending
   one Contents-API call per unused plugin — 37 plugins in `sap-skills`.)
4. For each such plugin:
   `GET https://api.github.com/repos/{owner}/{repo}/contents/{sourcePath}/skills?ref={ref}`
   → `skillDirsFromContents` → its skill names.
5. Return `Array<{ plugin, version, skills }>` for the enumerated subset.

**`fetchSkillMd(plugin, skill)`:** ensure the manifest is loaded (so the
`sourcePath` map exists), then
`GET https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{sourcePath}/skills/{skill}/SKILL.md`
→ response text.

**Headers:** when `token` is set, attach `Authorization: Bearer <token>` to
**every** request (Contents API, repo metadata, and raw — enabling private
repos). When unset, send no auth header.

**Errors:** any non-OK response throws `"<op> <status> <statusText>"` (matching
`makeHttpTransport`'s style). A `403` on a Contents-API call additionally hints
that an unauthenticated rate limit was likely hit and a `token` should be set.

### Component 2 — config schema + parse

File: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-config.ts`.

Extend `SkillPluginsFetchedSource` with GitHub fields:

```ts
export interface SkillPluginsFetchedSource {
  id: string;
  registry?: string;        // HTTP marketplace (existing)
  github?: string;          // GitHub repo URL or owner/repo (new)
  ref?: string;             // branch/tag/sha; default = repo default_branch
  token?: string;           // optional auth (env-expanded like other config)
  enabled?: readonly string[];
  strategy?: string;
  strategyConfig?: Record<string, unknown>;
}
```

**Parse rules (fail-loud):**

- A fetched source must have **exactly one** of `registry` / `github` — both set
  → error; neither set → error. (Today `registry` is silently optional; this
  tightens it.)
- `github`, `ref`, `token` parsed as strings; `ref`/`token` optional. `token`
  goes through the same `${ENV}` expansion the loader applies to other config
  values (e.g. `${GITHUB_TOKEN}`).
- The existing `enabled` non-empty requirement is unchanged (applies to both
  transports).

Config example:

```yaml
skillPlugins:
  sources:
    - id: sap-skills
      github: https://github.com/secondsky/sap-skills.git   # host self-fetches
      ref: main                 # optional; default = repo default_branch
      token: ${GITHUB_TOKEN}    # optional
      enabled: [sap-abap, sap-btp-developer-guide]
      strategy: single-collection
      strategyConfig: { collection: sap }
```

### Component 3 — wiring

File: `packages/llm-agent-server-libs/src/smart-agent/skill-plugins-host-factory.ts`,
`buildSources()` (currently builds `makeHttpTransport({ registry })`).

In the fetched-source branch, pick the transport by which field is present:

- `src.github` present → `makeGitHubTransport({ ...parseGitHubRepo(src.github),
  ...(src.ref ? { ref: src.ref } : {}), ...(src.token ? { token: src.token } :
  {}), enabled: src.enabled ?? [] })`.
- else → `makeHttpTransport({ registry: src.registry ?? '' })` (unchanged).

Export `makeGitHubTransport` and `parseGitHubRepo` from the `llm-agent-libs`
package index (alongside `makeHttpTransport`).

## Data flow (load)

`host.load()` → source `acquire()` → `transport.listPlugins()` (default-branch
resolve + raw marketplace.json + Contents-API skills listing for enabled
plugins) → `transport.fetchSkillMd()` per skill (raw) → `buildIngestResult`
(strategy placement + chunking) → store upsert. No file is ever written to disk.

## Error handling

| Condition | Behaviour |
|-----------|-----------|
| Unparseable `github` URL | `parseGitHubRepo` throws at build time |
| Both/neither `registry`+`github` | config parse throws (fail-loud) |
| `marketplace.json` missing / not JSON | `listPlugins` throws with status/parse error |
| Plugin has no `skills/` dir (404) | throws a clear "no skills/ directory" error |
| Contents-API `403` (rate limit) | throws, hinting to set `token` |
| Any non-OK fetch | throws `"<op> <status> <statusText>"` |

## Testing

**Unit (no real network):**

- `parseGitHubRepo`: all accepted URL forms + `.git` suffix + bare `owner/repo`;
  throw on garbage.
- `parseMarketplace`: maps `plugins[]` (name/version/source, `./` stripped);
  throws on missing `plugins`.
- `skillDirsFromContents`: returns only `type === 'dir'` names.
- `makeGitHubTransport` via an injected fake `fetch` scripted with the response
  sequence (default-branch → marketplace.json → contents listing → SKILL.md):
  - `listPlugins()` returns `[{plugin,version,skills}]` for the enabled subset;
  - **only enabled plugins are enumerated** (no Contents-API call for the rest);
  - `ref` defaults to `default_branch` when unset, and the metadata call is
    skipped when `ref` is provided;
  - a `token` attaches `Authorization: Bearer` to requests;
  - `fetchSkillMd` hits the correct raw URL and returns the body.
- Config parse: `github` XOR `registry` (both → throw, neither → throw); `ref`
  and `token` parsed; `enabled` requirement preserved.

**Live verification (manual, after build):** re-run the `sap-skills` review
config with a `github:` source (no shim) and confirm the host fetches
`sap-abap` + `sap-btp-developer-guide` itself and the controller uses them.

## Out of scope (YAGNI)

- `git clone` / any on-disk caching.
- Generic git-host abstraction (GitLab/Bitbucket/self-hosted).
- Reading `plugin.json` or `commands` (marketplace.json + the `skills/` listing
  are sufficient).
- Multi-skill-name conventions beyond what the Contents-API listing returns
  (the listing already handles plugins with any number of differently-named
  skills).
