# SAP AI Core Embedder — foundation-models scenario support

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issue #116 — make `@mcp-abap-adt/sap-aicore-embedder` work on SAP AI Core tenants where embedding models are deployed under `foundation-models` scenario (not `orchestration`).

**Architecture:** Add a `scenario` config option (default `'foundation-models'`). For `foundation-models`, bypass `OrchestrationEmbeddingClient` and call the AI Core REST inference API directly: (1) OAuth2 client_credentials against token URL from `AICORE_SERVICE_KEY` or the programmatic `credentials` option, (2) GET `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING` to resolve deployment id by model name (cached), (3) POST `/v2/inference/deployments/{id}/embeddings`. For `orchestration`, keep the existing SDK path untouched for backward compatibility.

**Tech Stack:** TypeScript (ESM), `node --test` + `tsx/esm`, native `fetch`, Biome. No new runtime dependencies.

---

## File Structure

- `packages/sap-aicore-embedder/src/types.ts` — **create** — `SapAiCoreEmbedderConfig` (extended with `scenario` and `credentials`), `SapAICoreCredentials`, `ParsedServiceKey` internal type.
- `packages/sap-aicore-embedder/src/service-key.ts` — **create** — parse `AICORE_SERVICE_KEY` env var into `{ clientId, clientSecret, tokenUrl, apiBaseUrl }`. Exported for testability.
- `packages/sap-aicore-embedder/src/auth.ts` — **create** — `TokenProvider` class: fetch + cache OAuth2 bearer token with 60 s pre-expiry refresh window.
- `packages/sap-aicore-embedder/src/deployments.ts` — **create** — `resolveDeploymentId(apiBaseUrl, token, resourceGroup, model)`: GET deployment list, return id of RUNNING deployment matching model name. Caller caches.
- `packages/sap-aicore-embedder/src/foundation-embedder.ts` — **create** — `FoundationModelsEmbedder` class: REST-based `IEmbedderBatch` implementation. Depends on `TokenProvider` and `resolveDeploymentId`. Handles both array and base64 embedding shapes.
- `packages/sap-aicore-embedder/src/orchestration-embedder.ts` — **create** — extracted from current `sap-ai-core-embedder.ts`: `OrchestrationScenarioEmbedder` class wrapping `OrchestrationEmbeddingClient` (existing behavior).
- `packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts` — **modify** — becomes a thin façade that picks `FoundationModelsEmbedder` or `OrchestrationScenarioEmbedder` based on `config.scenario` (default `'foundation-models'`).
- `packages/sap-aicore-embedder/src/index.ts` — **modify** — export new types (`SapAICoreCredentials`, `scenario` values are part of the config type).
- `packages/sap-aicore-embedder/src/service-key.test.ts` — **create** — unit tests for service-key parsing.
- `packages/sap-aicore-embedder/src/auth.test.ts` — **create** — unit tests for token caching (with mocked `fetch`).
- `packages/sap-aicore-embedder/src/deployments.test.ts` — **create** — unit tests for deployment resolution (mocked `fetch`).
- `packages/sap-aicore-embedder/src/foundation-embedder.test.ts` — **create** — unit tests for `FoundationModelsEmbedder.embed` / `embedBatch` (mocked `fetch`, both array and base64 response shapes).
- `packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts` — **create** — unit tests verifying the façade routes to the correct backend given `scenario`.
- `packages/sap-aicore-embedder/README.md` — **modify** — document `scenario` option and show both `foundation-models` (default) and `orchestration` examples.
- `packages/sap-aicore-embedder/CHANGELOG.md` — **modify** — add 11.1.0 entry.
- `packages/sap-aicore-embedder/package.json` — **modify** — bump version to 11.1.0.

---

## Task 1: Extract current orchestration embedder into its own module (no behavior change)

**Files:**
- Create: `packages/sap-aicore-embedder/src/orchestration-embedder.ts`
- Modify: `packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts`

Pure refactor: move the existing `OrchestrationEmbeddingClient`-based logic into its own class, leaving `SapAiCoreEmbedder` as a thin pass-through. This isolates the orchestration backend from the upcoming routing logic.

- [ ] **Step 1: Create `orchestration-embedder.ts` with the extracted class**

```ts
// packages/sap-aicore-embedder/src/orchestration-embedder.ts
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';

export interface OrchestrationScenarioEmbedderConfig {
  model: string;
  resourceGroup?: string;
}

export class OrchestrationScenarioEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup?: string;

  constructor(config: OrchestrationScenarioEmbedderConfig) {
    this.model = config.model;
    this.resourceGroup = config.resourceGroup;
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const client = await this.createClient();
    const response = await client.embed({ input: text });
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(embeddings[0].embedding) };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const client = await this.createClient();
    const response = await client.embed({ input: texts });
    const embeddings = response.getEmbeddings();
    if (!embeddings || embeddings.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...embeddings].sort((a, b) => a.index - b.index);
    return sorted.map((e) => ({ vector: decodeEmbedding(e.embedding) }));
  }

  private async createClient() {
    const { OrchestrationEmbeddingClient } = await import(
      '@sap-ai-sdk/orchestration'
    );
    const modelName = this
      .model as unknown as import('@sap-ai-sdk/orchestration').EmbeddingModel;
    return new OrchestrationEmbeddingClient(
      { embeddings: { model: { name: modelName } } },
      this.resourceGroup ? { resourceGroup: this.resourceGroup } : undefined,
    );
  }
}

function decodeEmbedding(embedding: number[] | string): number[] {
  if (typeof embedding === 'string') {
    const buffer = Buffer.from(embedding, 'base64');
    const float32 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 4,
    );
    return Array.from(float32);
  }
  return embedding;
}
```

- [ ] **Step 2: Replace `sap-ai-core-embedder.ts` with a pass-through that delegates to `OrchestrationScenarioEmbedder`**

```ts
// packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small') */
  model: string;
  /** SAP AI Core resource group (optional) */
  resourceGroup?: string;
}

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly backend: IEmbedderBatch;

  constructor(config: SapAiCoreEmbedderConfig) {
    this.backend = new OrchestrationScenarioEmbedder({
      model: config.model,
      resourceGroup: config.resourceGroup,
    });
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.backend.embed(text, options);
  }

  embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    return this.backend.embedBatch(texts, options);
  }
}
```

- [ ] **Step 3: Build and verify nothing changed externally**

Run: `npm --prefix packages/sap-aicore-embedder run build`
Expected: exits 0, no type errors.

Run (from repo root): `npm run build`
Expected: exits 0, top-level build still green.

- [ ] **Step 4: Commit**

```bash
git add packages/sap-aicore-embedder/src/
git commit -m "refactor(sap-aicore-embedder): extract orchestration backend into its own module"
```

---

## Task 2: Parse `AICORE_SERVICE_KEY` into a typed struct

**Files:**
- Create: `packages/sap-aicore-embedder/src/service-key.ts`
- Test: `packages/sap-aicore-embedder/src/service-key.test.ts`

Isolated, pure function — easy to TDD. SAP AI Core service key JSON typically contains `clientid`, `clientsecret`, `url` (token endpoint), and `serviceurls.AI_API_URL` (REST API base).

- [ ] **Step 1: Write the failing test**

```ts
// packages/sap-aicore-embedder/src/service-key.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseServiceKey } from './service-key.js';

test('parseServiceKey extracts credentials from raw SAP AI Core service key JSON', () => {
  const raw = JSON.stringify({
    clientid: 'sb-123',
    clientsecret: 'secret-abc',
    url: 'https://example.authentication.eu10.hana.ondemand.com',
    serviceurls: {
      AI_API_URL: 'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
    },
  });

  const parsed = parseServiceKey(raw);

  assert.equal(parsed.clientId, 'sb-123');
  assert.equal(parsed.clientSecret, 'secret-abc');
  assert.equal(
    parsed.tokenUrl,
    'https://example.authentication.eu10.hana.ondemand.com/oauth/token',
  );
  assert.equal(
    parsed.apiBaseUrl,
    'https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com',
  );
});

test('parseServiceKey does not double-append /oauth/token', () => {
  const raw = JSON.stringify({
    clientid: 'x',
    clientsecret: 'y',
    url: 'https://example.authentication.eu10.hana.ondemand.com/oauth/token',
    serviceurls: { AI_API_URL: 'https://api.example.com' },
  });
  assert.equal(
    parseServiceKey(raw).tokenUrl,
    'https://example.authentication.eu10.hana.ondemand.com/oauth/token',
  );
});

test('parseServiceKey throws on missing required fields', () => {
  const raw = JSON.stringify({ clientid: 'x' });
  assert.throws(() => parseServiceKey(raw), /AICORE_SERVICE_KEY/);
});

test('parseServiceKey throws on invalid JSON', () => {
  assert.throws(() => parseServiceKey('not json'), /AICORE_SERVICE_KEY/);
});
```

- [ ] **Step 2: Run test — expect failure (module not defined)**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: FAIL — `Cannot find module './service-key.js'`.

- [ ] **Step 3: Implement `service-key.ts`**

```ts
// packages/sap-aicore-embedder/src/service-key.ts
export interface ParsedServiceKey {
  clientId: string;
  clientSecret: string;
  /** Fully qualified token endpoint incl. `/oauth/token`. */
  tokenUrl: string;
  /** AI Core REST API base URL (no trailing slash). */
  apiBaseUrl: string;
}

interface RawServiceKey {
  clientid?: string;
  clientsecret?: string;
  url?: string;
  serviceurls?: { AI_API_URL?: string };
}

export function parseServiceKey(raw: string): ParsedServiceKey {
  let obj: RawServiceKey;
  try {
    obj = JSON.parse(raw) as RawServiceKey;
  } catch (err) {
    throw new Error(
      `AICORE_SERVICE_KEY is not valid JSON: ${(err as Error).message}`,
    );
  }

  const clientId = obj.clientid;
  const clientSecret = obj.clientsecret;
  const authUrl = obj.url;
  const apiBaseUrl = obj.serviceurls?.AI_API_URL;

  if (!clientId || !clientSecret || !authUrl || !apiBaseUrl) {
    throw new Error(
      'AICORE_SERVICE_KEY is missing required fields (clientid, clientsecret, url, serviceurls.AI_API_URL)',
    );
  }

  const tokenUrl = authUrl.endsWith('/oauth/token')
    ? authUrl
    : `${authUrl.replace(/\/+$/, '')}/oauth/token`;

  return {
    clientId,
    clientSecret,
    tokenUrl,
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
  };
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: 4/4 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sap-aicore-embedder/src/service-key.ts packages/sap-aicore-embedder/src/service-key.test.ts
git commit -m "feat(sap-aicore-embedder): add AICORE_SERVICE_KEY parser"
```

---

## Task 3: OAuth2 token provider with caching

**Files:**
- Create: `packages/sap-aicore-embedder/src/auth.ts`
- Test: `packages/sap-aicore-embedder/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/sap-aicore-embedder/src/auth.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { TokenProvider } from './auth.js';

const originalFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(responder: (url: string) => { body: unknown; status?: number }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: u, init });
    const { body, status = 200 } = responder(u);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

test('TokenProvider fetches and returns access_token', async () => {
  mockFetch(() => ({ body: { access_token: 'tok-1', expires_in: 3600 } }));
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });

  const token = await provider.getToken();
  assert.equal(token, 'tok-1');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://auth.example.com/oauth/token');
  assert.equal(
    (fetchCalls[0].init?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from('cid:csec').toString('base64')}`,
  );
});

test('TokenProvider caches token until near expiry', async () => {
  let issued = 0;
  mockFetch(() => {
    issued++;
    return { body: { access_token: `tok-${issued}`, expires_in: 3600 } };
  });
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });

  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(fetchCalls.length, 1);
});

test('TokenProvider refreshes when forced', async () => {
  let issued = 0;
  mockFetch(() => {
    issued++;
    return { body: { access_token: `tok-${issued}`, expires_in: 3600 } };
  });
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });

  assert.equal(await provider.getToken(), 'tok-1');
  assert.equal(await provider.getToken({ forceRefresh: true }), 'tok-2');
  assert.equal(fetchCalls.length, 2);
});

test('TokenProvider throws on non-2xx', async () => {
  mockFetch(() => ({ body: { error: 'invalid_client' }, status: 401 }));
  const provider = new TokenProvider({
    clientId: 'cid',
    clientSecret: 'csec',
    tokenUrl: 'https://auth.example.com/oauth/token',
  });

  await assert.rejects(() => provider.getToken(), /401/);
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.ts`**

```ts
// packages/sap-aicore-embedder/src/auth.ts
export interface TokenProviderConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
}

export interface GetTokenOptions {
  forceRefresh?: boolean;
}

/** Refresh the token when less than this many ms remain on it. */
const REFRESH_WINDOW_MS = 60_000;

export class TokenProvider {
  private readonly cfg: TokenProviderConfig;
  private cachedToken: string | null = null;
  private cachedExpiryMs = 0;
  private inFlight: Promise<string> | null = null;

  constructor(cfg: TokenProviderConfig) {
    this.cfg = cfg;
  }

  async getToken(options?: GetTokenOptions): Promise<string> {
    if (
      !options?.forceRefresh &&
      this.cachedToken &&
      Date.now() < this.cachedExpiryMs - REFRESH_WINDOW_MS
    ) {
      return this.cachedToken;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchToken()
      .then((result) => {
        this.cachedToken = result.token;
        this.cachedExpiryMs = Date.now() + result.expiresInMs;
        return result.token;
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  private async fetchToken(): Promise<{ token: string; expiresInMs: number }> {
    const basic = Buffer.from(
      `${this.cfg.clientId}:${this.cfg.clientSecret}`,
    ).toString('base64');
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `SAP AI Core token request failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!body.access_token) {
      throw new Error('SAP AI Core token response missing access_token');
    }
    return {
      token: body.access_token,
      expiresInMs: (body.expires_in ?? 3600) * 1000,
    };
  }
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: all tests in `auth.test.ts` pass (plus the previous 4 from Task 2).

- [ ] **Step 5: Commit**

```bash
git add packages/sap-aicore-embedder/src/auth.ts packages/sap-aicore-embedder/src/auth.test.ts
git commit -m "feat(sap-aicore-embedder): add OAuth2 token provider with caching"
```

---

## Task 4: Deployment resolver

**Files:**
- Create: `packages/sap-aicore-embedder/src/deployments.ts`
- Test: `packages/sap-aicore-embedder/src/deployments.test.ts`

AI Core `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING` returns `{ resources: [{ id, details: { resources: { backend_details: { model: { name } } } } } ] }`. The exact shape varies across tenants — we match on any occurrence of `model.name` inside the resource. Keep it pragmatic: walk known paths.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sap-aicore-embedder/src/deployments.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { resolveDeploymentId } from './deployments.js';

const originalFetch = globalThis.fetch;
let lastUrl = '';
let lastInit: RequestInit | undefined;

beforeEach(() => {
  lastUrl = '';
  lastInit = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOnce(body: unknown, status = 200) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    lastUrl = typeof url === 'string' ? url : url.toString();
    lastInit = init;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

test('resolveDeploymentId returns id of RUNNING deployment matching model name', async () => {
  mockOnce({
    resources: [
      {
        id: 'd-other',
        details: { resources: { backend_details: { model: { name: 'text-embedding-3-small' } } } },
      },
      {
        id: 'd-match',
        details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } },
      },
    ],
  });

  const id = await resolveDeploymentId({
    apiBaseUrl: 'https://api.example.com',
    token: 'tok',
    resourceGroup: 'default',
    model: 'gemini-embedding',
  });

  assert.equal(id, 'd-match');
  assert.ok(
    lastUrl.includes('scenarioId=foundation-models'),
    `url should filter by scenario, got: ${lastUrl}`,
  );
  assert.ok(lastUrl.includes('status=RUNNING'));
  const headers = lastInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['AI-Resource-Group'], 'default');
});

test('resolveDeploymentId throws when no match found', async () => {
  mockOnce({ resources: [] });
  await assert.rejects(
    () =>
      resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'gemini-embedding',
      }),
    /gemini-embedding/,
  );
});

test('resolveDeploymentId propagates HTTP errors', async () => {
  mockOnce({ error: 'forbidden' }, 403);
  await assert.rejects(
    () =>
      resolveDeploymentId({
        apiBaseUrl: 'https://api.example.com',
        token: 'tok',
        resourceGroup: 'default',
        model: 'x',
      }),
    /403/,
  );
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deployments.ts`**

```ts
// packages/sap-aicore-embedder/src/deployments.ts
export interface ResolveDeploymentOptions {
  apiBaseUrl: string;
  token: string;
  resourceGroup: string;
  model: string;
  /** Scenario id. Default: 'foundation-models'. */
  scenarioId?: string;
}

interface DeploymentResource {
  id?: string;
  details?: {
    resources?: {
      backend_details?: { model?: { name?: string } };
    };
  };
  // Some tenants put the model on the top-level resource
  model?: { name?: string };
}

interface DeploymentListResponse {
  resources?: DeploymentResource[];
}

function extractModelName(resource: DeploymentResource): string | undefined {
  return (
    resource.details?.resources?.backend_details?.model?.name ??
    resource.model?.name
  );
}

export async function resolveDeploymentId(
  options: ResolveDeploymentOptions,
): Promise<string> {
  const scenarioId = options.scenarioId ?? 'foundation-models';
  const url = `${options.apiBaseUrl}/v2/lm/deployments?scenarioId=${encodeURIComponent(scenarioId)}&status=RUNNING`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'AI-Resource-Group': options.resourceGroup,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `SAP AI Core deployment list failed: ${res.status} ${res.statusText} ${text}`,
    );
  }
  const body = (await res.json()) as DeploymentListResponse;
  const match = (body.resources ?? []).find(
    (r) => extractModelName(r) === options.model && typeof r.id === 'string',
  );
  if (!match?.id) {
    throw new Error(
      `No RUNNING deployment found for model "${options.model}" in scenario "${scenarioId}"`,
    );
  }
  return match.id;
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: all `deployments.test.ts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/sap-aicore-embedder/src/deployments.ts packages/sap-aicore-embedder/src/deployments.test.ts
git commit -m "feat(sap-aicore-embedder): add foundation-models deployment resolver"
```

---

## Task 5: Foundation-models REST embedder

**Files:**
- Create: `packages/sap-aicore-embedder/src/foundation-embedder.ts`
- Test: `packages/sap-aicore-embedder/src/foundation-embedder.test.ts`

Caches deployment id per instance after first resolution. Handles both `embedding: number[]` and `embedding: string` (base64) response shapes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sap-aicore-embedder/src/foundation-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FoundationModelsEmbedder } from './foundation-embedder.js';

const originalFetch = globalThis.fetch;
interface Call {
  url: string;
  init?: RequestInit;
}
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installFetch(handler: (url: string, init?: RequestInit) => { body: unknown; status?: number }) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    const { body, status = 200 } = handler(u, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeEmbedder() {
  return new FoundationModelsEmbedder({
    model: 'gemini-embedding',
    resourceGroup: 'default',
    credentials: {
      clientId: 'cid',
      clientSecret: 'csec',
      tokenUrl: 'https://auth.example.com/oauth/token',
      apiBaseUrl: 'https://api.example.com',
    },
  });
}

test('embed: resolves deployment, fetches token, returns vector', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token')) {
      return { body: { access_token: 'tok', expires_in: 3600 } };
    }
    if (url.includes('/v2/lm/deployments')) {
      return {
        body: {
          resources: [
            {
              id: 'd-1',
              details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } },
            },
          ],
        },
      };
    }
    if (url.endsWith('/v2/inference/deployments/d-1/embeddings')) {
      return { body: { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] } };
    }
    throw new Error(`unexpected url ${url}`);
  });

  const result = await makeEmbedder().embed('hello');
  assert.deepEqual(result.vector, [0.1, 0.2, 0.3]);
});

test('embed: decodes base64 embedding', async () => {
  const floats = new Float32Array([1, 2, 3]);
  const base64 = Buffer.from(floats.buffer).toString('base64');

  installFetch((url) => {
    if (url.endsWith('/oauth/token')) return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return { body: { resources: [{ id: 'd-1', details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } } }] } };
    }
    return { body: { data: [{ embedding: base64, index: 0 }] } };
  });

  const result = await makeEmbedder().embed('hello');
  assert.deepEqual(Array.from(result.vector), [1, 2, 3]);
});

test('embedBatch: sorts by index and returns vectors in input order', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token')) return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return { body: { resources: [{ id: 'd-1', details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } } }] } };
    }
    return {
      body: {
        data: [
          { embedding: [2, 2], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
      },
    };
  });

  const result = await makeEmbedder().embedBatch(['a', 'b']);
  assert.deepEqual(result[0].vector, [1, 1]);
  assert.deepEqual(result[1].vector, [2, 2]);
});

test('embedBatch: returns [] for empty input without fetching', async () => {
  installFetch(() => {
    throw new Error('fetch should not be called');
  });
  const result = await makeEmbedder().embedBatch([]);
  assert.deepEqual(result, []);
});

test('deployment id is cached across calls', async () => {
  let deploymentCalls = 0;
  installFetch((url) => {
    if (url.endsWith('/oauth/token')) return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      deploymentCalls++;
      return { body: { resources: [{ id: 'd-1', details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } } }] } };
    }
    return { body: { data: [{ embedding: [0], index: 0 }] } };
  });

  const emb = makeEmbedder();
  await emb.embed('x');
  await emb.embed('y');
  assert.equal(deploymentCalls, 1);
});

test('embeddings request uses Bearer + AI-Resource-Group headers', async () => {
  installFetch((url) => {
    if (url.endsWith('/oauth/token')) return { body: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/v2/lm/deployments')) {
      return { body: { resources: [{ id: 'd-1', details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } } }] } };
    }
    return { body: { data: [{ embedding: [0], index: 0 }] } };
  });

  await makeEmbedder().embed('x');

  const embedCall = calls.find((c) => c.url.endsWith('/embeddings'));
  assert.ok(embedCall, 'expected an embeddings call');
  const headers = embedCall.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.equal(headers['AI-Resource-Group'], 'default');
  assert.equal(embedCall.init?.method, 'POST');
});
```

- [ ] **Step 2: Run test — expect failure**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `foundation-embedder.ts`**

```ts
// packages/sap-aicore-embedder/src/foundation-embedder.ts
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import { type CallOptions, RagError } from '@mcp-abap-adt/llm-agent';
import { TokenProvider } from './auth.js';
import { resolveDeploymentId } from './deployments.js';
import { parseServiceKey } from './service-key.js';

export interface FoundationModelsCredentials {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  apiBaseUrl: string;
}

export interface FoundationModelsEmbedderConfig {
  model: string;
  resourceGroup?: string;
  /** Explicit credentials. When omitted, `AICORE_SERVICE_KEY` env var is parsed. */
  credentials?: FoundationModelsCredentials;
}

interface EmbeddingsResponseItem {
  embedding: number[] | string;
  index: number;
}

interface EmbeddingsResponse {
  data?: EmbeddingsResponseItem[];
}

export class FoundationModelsEmbedder implements IEmbedderBatch {
  private readonly model: string;
  private readonly resourceGroup: string;
  private readonly apiBaseUrl: string;
  private readonly tokenProvider: TokenProvider;
  private deploymentIdPromise: Promise<string> | null = null;

  constructor(config: FoundationModelsEmbedderConfig) {
    const creds = config.credentials ?? this.loadCredentialsFromEnv();
    this.model = config.model;
    this.resourceGroup = config.resourceGroup ?? 'default';
    this.apiBaseUrl = creds.apiBaseUrl;
    this.tokenProvider = new TokenProvider({
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      tokenUrl: creds.tokenUrl,
    });
  }

  async embed(text: string, _options?: CallOptions): Promise<IEmbedResult> {
    const items = await this.requestEmbeddings([text]);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core');
    }
    return { vector: decodeEmbedding(items[0].embedding) };
  }

  async embedBatch(
    texts: string[],
    _options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    if (texts.length === 0) return [];
    const items = await this.requestEmbeddings(texts);
    if (items.length === 0) {
      throw new RagError('No embeddings returned from SAP AI Core batch');
    }
    const sorted = [...items].sort((a, b) => a.index - b.index);
    return sorted.map((item) => ({ vector: decodeEmbedding(item.embedding) }));
  }

  private async requestEmbeddings(
    input: string[],
  ): Promise<EmbeddingsResponseItem[]> {
    const token = await this.tokenProvider.getToken();
    const deploymentId = await this.getDeploymentId(token);
    const url = `${this.apiBaseUrl}/v2/inference/deployments/${deploymentId}/embeddings`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'AI-Resource-Group': this.resourceGroup,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ input: input.length === 1 ? input[0] : input }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RagError(
        `SAP AI Core embeddings call failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const body = (await res.json()) as EmbeddingsResponse;
    return body.data ?? [];
  }

  private getDeploymentId(token: string): Promise<string> {
    if (!this.deploymentIdPromise) {
      this.deploymentIdPromise = resolveDeploymentId({
        apiBaseUrl: this.apiBaseUrl,
        token,
        resourceGroup: this.resourceGroup,
        model: this.model,
      }).catch((err) => {
        // Don't cache failures
        this.deploymentIdPromise = null;
        throw err;
      });
    }
    return this.deploymentIdPromise;
  }

  private loadCredentialsFromEnv(): FoundationModelsCredentials {
    const raw = process.env.AICORE_SERVICE_KEY;
    if (!raw) {
      throw new Error(
        'SapAiCoreEmbedder (foundation-models): no credentials provided and AICORE_SERVICE_KEY env var is not set',
      );
    }
    return parseServiceKey(raw);
  }
}

function decodeEmbedding(embedding: number[] | string): number[] {
  if (typeof embedding === 'string') {
    const buffer = Buffer.from(embedding, 'base64');
    const float32 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.length / 4,
    );
    return Array.from(float32);
  }
  return embedding;
}
```

- [ ] **Step 4: Run test — expect pass**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: all new tests pass. If the SAP AI Core API in a given tenant returns a different JSON shape, the test-driven contract is: `{ data: [{ embedding, index }] }`. Real-tenant shape discrepancies surface as the next issue.

- [ ] **Step 5: Commit**

```bash
git add packages/sap-aicore-embedder/src/foundation-embedder.ts packages/sap-aicore-embedder/src/foundation-embedder.test.ts
git commit -m "feat(sap-aicore-embedder): add foundation-models REST embedder"
```

---

## Task 6: Wire the scenario router into `SapAiCoreEmbedder`

**Files:**
- Modify: `packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts`
- Modify: `packages/sap-aicore-embedder/src/index.ts`
- Test: `packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts`

Default `scenario` to `'foundation-models'` — this makes existing v11.0.0 consumers whose embedding models are under `foundation-models` work without config changes, which is exactly the group the issue targets. Consumers whose models are under `orchestration` get an explicit `scenario: 'orchestration'` value.

- [ ] **Step 1: Write the failing test**

```ts
// packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';

const originalFetch = globalThis.fetch;
let lastUrl = '';

beforeEach(() => {
  lastUrl = '';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AICORE_SERVICE_KEY;
});

test('defaults to foundation-models scenario and calls REST inference endpoint', async () => {
  process.env.AICORE_SERVICE_KEY = JSON.stringify({
    clientid: 'cid',
    clientsecret: 'csec',
    url: 'https://auth.example.com',
    serviceurls: { AI_API_URL: 'https://api.example.com' },
  });

  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    lastUrl = u;
    if (u.endsWith('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/v2/lm/deployments')) {
      return new Response(
        JSON.stringify({
          resources: [
            {
              id: 'd-1',
              details: { resources: { backend_details: { model: { name: 'gemini-embedding' } } } },
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ data: [{ embedding: [0.5], index: 0 }] }), { status: 200 });
  }) as typeof fetch;

  const emb = new SapAiCoreEmbedder({ model: 'gemini-embedding' });
  const res = await emb.embed('hi');
  assert.deepEqual(res.vector, [0.5]);
  assert.ok(lastUrl.includes('/v2/inference/deployments/d-1/embeddings'));
});

test('scenario: orchestration delegates to the SDK-based backend', async () => {
  // We can't easily instantiate the SDK backend without network, so just
  // verify construction + routing by asserting no REST fetch happens.
  globalThis.fetch = (async () => {
    throw new Error('fetch should not be called for orchestration scenario in construction');
  }) as typeof fetch;

  const emb = new SapAiCoreEmbedder({
    model: 'text-embedding-3-small',
    scenario: 'orchestration',
  });
  assert.ok(emb);
});
```

- [ ] **Step 2: Run test — expect failure (scenario property not accepted yet)**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: FAIL — type error or missing property.

- [ ] **Step 3: Update `sap-ai-core-embedder.ts` to route based on scenario**

```ts
// packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts
import type { IEmbedderBatch, IEmbedResult } from '@mcp-abap-adt/llm-agent';
import type { CallOptions } from '@mcp-abap-adt/llm-agent';
import {
  FoundationModelsEmbedder,
  type FoundationModelsCredentials,
} from './foundation-embedder.js';
import { OrchestrationScenarioEmbedder } from './orchestration-embedder.js';

export type SapAiCoreEmbedderScenario = 'foundation-models' | 'orchestration';

export interface SapAiCoreEmbedderConfig {
  /** Embedding model name (e.g. 'text-embedding-3-small', 'gemini-embedding') */
  model: string;
  /** SAP AI Core resource group. Default: 'default'. */
  resourceGroup?: string;
  /**
   * SAP AI Core scenario under which the embedding model is deployed.
   * - `'foundation-models'` (default): calls the AI Core REST inference API directly.
   *   Works on tenants where embedding models are deployed under the foundation-models scenario.
   * - `'orchestration'`: uses `OrchestrationEmbeddingClient` from `@sap-ai-sdk/orchestration`.
   *   Requires an orchestration-scenario deployment of the embedding model.
   */
  scenario?: SapAiCoreEmbedderScenario;
  /**
   * Explicit credentials for the `foundation-models` scenario.
   * When omitted, `AICORE_SERVICE_KEY` env var is parsed instead.
   * Ignored for `scenario: 'orchestration'` (the SAP SDK handles auth there).
   */
  credentials?: FoundationModelsCredentials;
}

export type { FoundationModelsCredentials };

export class SapAiCoreEmbedder implements IEmbedderBatch {
  private readonly backend: IEmbedderBatch;

  constructor(config: SapAiCoreEmbedderConfig) {
    const scenario = config.scenario ?? 'foundation-models';
    if (scenario === 'orchestration') {
      this.backend = new OrchestrationScenarioEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
      });
    } else {
      this.backend = new FoundationModelsEmbedder({
        model: config.model,
        resourceGroup: config.resourceGroup,
        credentials: config.credentials,
      });
    }
  }

  embed(text: string, options?: CallOptions): Promise<IEmbedResult> {
    return this.backend.embed(text, options);
  }

  embedBatch(
    texts: string[],
    options?: CallOptions,
  ): Promise<IEmbedResult[]> {
    return this.backend.embedBatch(texts, options);
  }
}
```

- [ ] **Step 4: Update `index.ts` to export new public types**

```ts
// packages/sap-aicore-embedder/src/index.ts
export type {
  FoundationModelsCredentials,
  SapAiCoreEmbedderConfig,
  SapAiCoreEmbedderScenario,
} from './sap-ai-core-embedder.js';
export { SapAiCoreEmbedder } from './sap-ai-core-embedder.js';
```

- [ ] **Step 5: Run test — expect pass**

Run: `npm --prefix packages/sap-aicore-embedder test`
Expected: all tests pass.

- [ ] **Step 6: Build and run top-level build**

Run: `npm --prefix packages/sap-aicore-embedder run build && npm run build`
Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/sap-aicore-embedder/src/sap-ai-core-embedder.ts packages/sap-aicore-embedder/src/sap-ai-core-embedder.test.ts packages/sap-aicore-embedder/src/index.ts
git commit -m "feat(sap-aicore-embedder): route to foundation-models REST or orchestration SDK by scenario"
```

---

## Task 7: README, CHANGELOG, version bump

**Files:**
- Modify: `packages/sap-aicore-embedder/README.md`
- Modify: `packages/sap-aicore-embedder/CHANGELOG.md`
- Modify: `packages/sap-aicore-embedder/package.json`

- [ ] **Step 1: Read current README and CHANGELOG**

Run: `cat packages/sap-aicore-embedder/README.md packages/sap-aicore-embedder/CHANGELOG.md`
Goal: identify where to slot in the new `scenario` documentation and the new changelog entry.

- [ ] **Step 2: Update README with the `scenario` option and examples**

Add (or splice into existing config section):

````markdown
## Configuration

```ts
interface SapAiCoreEmbedderConfig {
  model: string;
  resourceGroup?: string;                             // default: 'default'
  scenario?: 'foundation-models' | 'orchestration';   // default: 'foundation-models'
  credentials?: FoundationModelsCredentials;          // foundation-models only; falls back to AICORE_SERVICE_KEY
}
```

### Foundation-models (default)

For tenants where embedding models are deployed under the `foundation-models` scenario:

```ts
import { SapAiCoreEmbedder } from '@mcp-abap-adt/sap-aicore-embedder';

const embedder = new SapAiCoreEmbedder({ model: 'gemini-embedding' });
// Auth: process.env.AICORE_SERVICE_KEY (client_credentials flow)
```

### Orchestration

For tenants where the embedding model is deployed under the `orchestration` scenario:

```ts
const embedder = new SapAiCoreEmbedder({
  model: 'text-embedding-3-small',
  scenario: 'orchestration',
});
```
````

- [ ] **Step 3: Add CHANGELOG entry**

Prepend:

```markdown
## 11.1.0

- feat: add `scenario` config option (`'foundation-models'` | `'orchestration'`), default `'foundation-models'`.
- feat: foundation-models scenario uses the AI Core REST inference API directly (`/v2/inference/deployments/{id}/embeddings`), resolving the deployment id from `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`.
- feat: support explicit `credentials` option; falls back to parsing `AICORE_SERVICE_KEY` env var.
- fix: #116 — embedder no longer fails with `TypeError: fetch failed` on tenants where embedding models live under `foundation-models`.
```

- [ ] **Step 4: Bump version to 11.1.0 in `package.json`**

Edit `packages/sap-aicore-embedder/package.json`: `"version": "11.0.0"` → `"version": "11.1.0"`.

- [ ] **Step 5: Lint and format**

Run: `npm run lint && npm run format`
Expected: exit 0.

- [ ] **Step 6: Final full-workspace verification**

Run: `npm run build && npm --prefix packages/sap-aicore-embedder test`
Expected: both exit 0; all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/sap-aicore-embedder/README.md packages/sap-aicore-embedder/CHANGELOG.md packages/sap-aicore-embedder/package.json
git commit -m "docs(sap-aicore-embedder): document scenario option and bump to 11.1.0"
```

---

## Task 8: Update `package-lock.json` and open the PR

**Files:**
- Modify: `package-lock.json` (top-level, auto-generated)

Per project convention: always commit lockfile changes that result from our work.

- [ ] **Step 1: Refresh the lockfile if the version bump changed it**

Run: `npm install`
Expected: exits 0. If `package-lock.json` changed, it reflects the new 11.1.0 workspace version.

- [ ] **Step 2: Commit lockfile if changed**

```bash
git status --short
# if package-lock.json appears:
git add package-lock.json
git commit -m "chore: update lockfile for sap-aicore-embedder 11.1.0"
```

- [ ] **Step 3: Push branch and open PR referencing #116**

```bash
git push -u origin HEAD
gh pr create --title "fix(sap-aicore-embedder): support foundation-models scenario (#116)" --body "$(cat <<'EOF'
## Summary
- Adds `scenario` config option (`'foundation-models'` | `'orchestration'`), default `'foundation-models'`.
- For `foundation-models`, embeddings go through the AI Core REST inference API (resolves deployment id from `/v2/lm/deployments?scenarioId=foundation-models&status=RUNNING`, posts to `/v2/inference/deployments/{id}/embeddings`).
- For `orchestration`, keeps the existing `OrchestrationEmbeddingClient` SDK path.

Fixes #116.

## Test plan
- [ ] Unit tests for `service-key`, `auth`, `deployments`, `foundation-embedder`, and `SapAiCoreEmbedder` scenario routing pass: `npm --prefix packages/sap-aicore-embedder test`.
- [ ] `npm run build` passes at the repo root.
- [ ] Manual smoke test on a tenant with `gemini-embedding` under foundation-models (consumer: `poc_rag_openclaw` branch `feat/llm-agent-v11`): skill and RAG vectorization succeed.
EOF
)"
```

---

## Notes for the implementer

- **No new runtime dependencies.** We use native `fetch` and `Buffer` — the embedder package already supports ESM + Node 18+ through its workspace root.
- **Why default to `foundation-models`.** The issue reports this is the mode in which *most* tenants deploy foundation embedding models; flipping the default fixes the widest set of broken v11 consumers. Users on orchestration-scenario embeddings opt in with `scenario: 'orchestration'` — a one-line change.
- **Why don't we reuse `SapAICoreCredentials` from `@mcp-abap-adt/sap-aicore-llm`.** The embedder package intentionally does not depend on `sap-aicore-llm`. Duplicating a 4-field interface is cheaper than introducing a cross-package runtime dependency here.
- **Tenant-shape robustness.** The deployment resolver looks at `details.resources.backend_details.model.name` first, with `model.name` as a fallback. If a new tenant shape appears, extend `extractModelName` and add a test case — don't widen the parsing to accept anything.
- **Do NOT cache `TypeError: fetch failed`.** `FoundationModelsEmbedder.getDeploymentId` clears its promise on failure so the next call retries. Same principle applies if we add a token-refresh retry on 401 later (out of scope here).
