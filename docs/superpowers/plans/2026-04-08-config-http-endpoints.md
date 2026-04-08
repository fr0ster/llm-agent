# Config HTTP Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose `GET /v1/config` and `PUT /v1/config` HTTP endpoints on SmartServer so external clients can read and update runtime configuration.

**Architecture:** Add `IModelResolver` interface + `DefaultModelResolver` in providers. Add `getAgentConfig()` to SmartAgent for reading whitelisted config fields. Add config endpoint handler in SmartServer delegating to `getActiveConfig()`, `getAgentConfig()`, `applyConfigUpdate()`, and `reconfigure()`. PUT is atomic — all validation/resolution happens before any mutation.

**Tech Stack:** TypeScript, Node.js built-in `http`, existing test helpers (`node:test`, `httpRequest()`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/smart-agent/interfaces/model-resolver.ts` | Create | `IModelResolver` interface |
| `src/smart-agent/providers.ts` | Modify | Add `DefaultModelResolver` class |
| `src/smart-agent/agent.ts` | Modify | Add `getAgentConfig()` method |
| `src/smart-agent/smart-server.ts` | Modify | Add `/v1/config` route handling, `modelResolver` config field, CORS update |
| `src/index.ts` | Modify | Export `IModelResolver`, `DefaultModelResolver` |
| `src/smart-agent/__tests__/config-endpoints.test.ts` | Create | Integration tests for config endpoints |

---

### Task 1: IModelResolver Interface

**Files:**
- Create: `src/smart-agent/interfaces/model-resolver.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the interface file**

```typescript
// src/smart-agent/interfaces/model-resolver.ts
import type { ILlm } from './llm.js';

/**
 * Resolves a model name + role into a ready-to-use ILlm instance.
 * Used by SmartServer to handle PUT /v1/config model changes.
 */
export interface IModelResolver {
  resolve(
    modelName: string,
    role: 'main' | 'classifier' | 'helper',
  ): Promise<ILlm>;
}
```

- [ ] **Step 2: Export from index.ts**

Add to `src/index.ts` in the interfaces section (after the `ILlm` export around line 114):

```typescript
export type { IModelResolver } from './smart-agent/interfaces/model-resolver.js';
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: clean compilation, no errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/interfaces/model-resolver.ts src/index.ts
git commit -m "feat(#78): add IModelResolver interface"
```

---

### Task 2: DefaultModelResolver

**Files:**
- Modify: `src/smart-agent/providers.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add DefaultModelResolver class to providers.ts**

Add at the end of the LLM provider resolution section (after `makeDefaultLlm`, around line 172):

```typescript
/**
 * Default IModelResolver — delegates to makeLlm() with the given provider settings.
 * Returns fully constructed ILlm instances ready for use with SmartAgent.reconfigure().
 */
export class DefaultModelResolver implements IModelResolver {
  constructor(
    private readonly providerConfig: Omit<LlmProviderConfig, 'model'>,
    private readonly defaults: { temperature?: number } = {},
  ) {}

  async resolve(
    modelName: string,
    role: 'main' | 'classifier' | 'helper',
  ): Promise<ILlm> {
    const temperature =
      this.defaults.temperature ?? (role === 'main' ? 0.7 : 0.1);
    return makeLlm(
      { ...this.providerConfig, model: modelName },
      temperature,
    );
  }
}
```

Add the import at the top of `providers.ts`:

```typescript
import type { IModelResolver } from './interfaces/model-resolver.js';
```

- [ ] **Step 2: Export DefaultModelResolver from index.ts**

Add to `src/index.ts` near the providers exports (around line 148, after the `LlmProviderConfig` export):

```typescript
export { DefaultModelResolver } from './smart-agent/providers.js';
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: clean compilation, no errors

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/providers.ts src/index.ts
git commit -m "feat(#78): add DefaultModelResolver implementation"
```

---

### Task 3: SmartAgent.getAgentConfig()

**Files:**
- Modify: `src/smart-agent/agent.ts`

The spec defines a whitelist of fields that `GET /v1/config` exposes from `SmartAgentConfig`. SmartAgent currently has no public getter for its config. We add `getAgentConfig()` that returns only whitelisted fields.

- [ ] **Step 1: Write the failing test**

Create test in `src/smart-agent/__tests__/config-endpoints.test.ts` (we'll use this file for all config tests):

```typescript
// src/smart-agent/__tests__/config-endpoints.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SmartAgent } from '../agent.js';
import { makeDefaultDeps } from '../testing/index.js';

describe('SmartAgent.getAgentConfig', () => {
  it('returns only whitelisted fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
      // These should NOT appear in the output:
      timeoutMs: 5000,
      tokenLimit: 4096,
      smartAgentEnabled: true,
    });

    const config = agent.getAgentConfig();

    assert.deepEqual(config, {
      maxIterations: 10,
      maxToolCalls: 5,
      ragQueryK: 15,
      toolUnavailableTtlMs: 30_000,
      showReasoning: true,
      historyAutoSummarizeLimit: 20,
      classificationEnabled: true,
      ragRetrievalMode: 'auto',
      ragTranslationEnabled: true,
      ragUpsertEnabled: false,
    });
  });

  it('returns defaults for omitted optional fields', () => {
    const { deps } = makeDefaultDeps();
    const agent = new SmartAgent(deps, { maxIterations: 5 });

    const config = agent.getAgentConfig();

    assert.equal(config.maxIterations, 5);
    assert.equal(config.maxToolCalls, undefined);
    assert.equal(config.classificationEnabled, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: FAIL — `agent.getAgentConfig is not a function`

- [ ] **Step 3: Implement getAgentConfig()**

Add to `src/smart-agent/agent.ts`, right after `getActiveConfig()` (after line 323):

```typescript
  /** Returns whitelisted runtime-safe agent config fields (for HTTP DTO). */
  getAgentConfig(): {
    maxIterations: number;
    maxToolCalls?: number;
    ragQueryK?: number;
    toolUnavailableTtlMs?: number;
    showReasoning?: boolean;
    historyAutoSummarizeLimit?: number;
    classificationEnabled?: boolean;
    ragRetrievalMode?: 'auto' | 'always' | 'never';
    ragTranslationEnabled?: boolean;
    ragUpsertEnabled?: boolean;
  } {
    return {
      maxIterations: this.config.maxIterations,
      maxToolCalls: this.config.maxToolCalls,
      ragQueryK: this.config.ragQueryK,
      toolUnavailableTtlMs: this.config.toolUnavailableTtlMs,
      showReasoning: this.config.showReasoning,
      historyAutoSummarizeLimit: this.config.historyAutoSummarizeLimit,
      classificationEnabled: this.config.classificationEnabled,
      ragRetrievalMode: this.config.ragRetrievalMode,
      ragTranslationEnabled: this.config.ragTranslationEnabled,
      ragUpsertEnabled: this.config.ragUpsertEnabled,
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/agent.ts src/smart-agent/__tests__/config-endpoints.test.ts
git commit -m "feat(#78): add SmartAgent.getAgentConfig() with whitelisted fields"
```

---

### Task 4: GET /v1/config Endpoint

**Files:**
- Modify: `src/smart-agent/smart-server.ts`
- Modify: `src/smart-agent/__tests__/config-endpoints.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/smart-agent/__tests__/config-endpoints.test.ts`:

```typescript
import { request } from 'node:http';
import { SmartServer } from '../smart-server.js';

// ---------------------------------------------------------------------------
// HTTP helper (same pattern as smart-server-api-adapters.test.ts)
// ---------------------------------------------------------------------------

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options = {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr !== undefined
          ? { 'Content-Length': Buffer.byteLength(bodyStr) }
          : {}),
      },
    };
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, raw: text });
      });
    });
    req.on('error', reject);
    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('GET /v1/config', () => {
  it('returns models and agent config', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 8 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.ok(body.models);
      assert.ok(body.agent);
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 8);
    } finally {
      await handle.close();
    }
  });

  it('works with /config alias', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.ok(body.models);
    } finally {
      await handle.close();
    }
  });

  it('returns only whitelisted fields, not raw SmartAgentConfig', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 5, timeoutMs: 9999, tokenLimit: 4096 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 5);
      assert.equal(agent.timeoutMs, undefined);
      assert.equal(agent.tokenLimit, undefined);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: FAIL — 404 for `/v1/config`

- [ ] **Step 3: Add config endpoint to SmartServer._handle()**

In `src/smart-agent/smart-server.ts`, add the route handler in `_handle()` after the `/v1/usage` block (after line 686) and before the `/health` check:

```typescript
    // GET /v1/config or /config
    if (
      req.method === 'GET' &&
      (urlPath === '/v1/config' || urlPath === '/config')
    ) {
      const models = smartAgent.getActiveConfig();
      const agent = smartAgent.getAgentConfig();
      const body = { models, agent };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
```

Note: `llmDefaults` (temperature/maxTokens) will be added in Task 6 after PUT is wired, since the server needs to track these values as mutable state.

- [ ] **Step 4: Update CORS_HEADERS to include PUT**

In `src/smart-agent/smart-server.ts`, update the `CORS_HEADERS` constant (line 252):

```typescript
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/smart-server.ts src/smart-agent/__tests__/config-endpoints.test.ts
git commit -m "feat(#78): add GET /v1/config endpoint"
```

---

### Task 5: PUT /v1/config — Agent Parameters

**Files:**
- Modify: `src/smart-agent/smart-server.ts`
- Modify: `src/smart-agent/__tests__/config-endpoints.test.ts`

This task adds `PUT /v1/config` support for the `agent` block only (parameters via `applyConfigUpdate`). Model resolution is added in Task 6.

- [ ] **Step 1: Write the failing tests**

Add to `src/smart-agent/__tests__/config-endpoints.test.ts`:

```typescript
describe('PUT /v1/config', () => {
  it('updates agent parameters and returns updated config', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { maxIterations: 20, classificationEnabled: false },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 20);
      assert.equal(agent.classificationEnabled, false);
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported agent fields', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        agent: { timeoutMs: 9999 },
      });
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });

  it('rejects invalid JSON body', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await new Promise<{ status: number; body: unknown; raw: string }>((resolve, reject) => {
        const req = request(
          { host: '127.0.0.1', port: handle.port, method: 'PUT', path: '/v1/config', headers: { 'Content-Type': 'application/json' } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), raw: text });
            });
          },
        );
        req.on('error', reject);
        req.write('not-json');
        req.end();
      });
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });

  it('returns 405 for unsupported methods on /v1/config', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'DELETE', '/v1/config');
      assert.equal(res.status, 405);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: FAIL — PUT returns 404, DELETE returns 404

- [ ] **Step 3: Add PUT handler and 405 handling to _handle()**

In `src/smart-agent/smart-server.ts`, replace the GET-only config handler added in Task 4 with a combined config handler:

```typescript
    // /v1/config or /config
    if (urlPath === '/v1/config' || urlPath === '/config') {
      if (req.method === 'GET') {
        const models = smartAgent.getActiveConfig();
        const agent = smartAgent.getAgentConfig();
        const body = { models, agent };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      if (req.method === 'PUT') {
        await this._handleConfigUpdate(req, res, smartAgent);
        return;
      }
      // 405 for other methods
      res.setHeader('Allow', 'GET, PUT, OPTIONS');
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(jsonError(`Method ${req.method} not allowed on ${urlPath}`, 'invalid_request_error'));
      return;
    }
```

- [ ] **Step 4: Add _handleConfigUpdate() method**

Add a new private method to `SmartServer` class (after `_handleChat` or at the end of the class):

```typescript
  /** Whitelisted agent config fields allowed via PUT /v1/config. */
  private static readonly AGENT_CONFIG_FIELDS = new Set([
    'maxIterations',
    'maxToolCalls',
    'ragQueryK',
    'toolUnavailableTtlMs',
    'showReasoning',
    'historyAutoSummarizeLimit',
    'classificationEnabled',
    'ragRetrievalMode',
    'ragTranslationEnabled',
    'ragUpsertEnabled',
  ]);

  private async _handleConfigUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    smartAgent: SmartAgent,
  ): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Request body must be a JSON object', 'invalid_request_error'));
      return;
    }

    const body = parsed as Record<string, unknown>;

    // --- Validate agent fields against whitelist ---
    if (body.agent !== undefined) {
      if (typeof body.agent !== 'object' || body.agent === null || Array.isArray(body.agent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('"agent" must be a JSON object', 'invalid_request_error'));
        return;
      }
      const agentFields = body.agent as Record<string, unknown>;
      const unsupported = Object.keys(agentFields).filter(
        (k) => !SmartServer.AGENT_CONFIG_FIELDS.has(k),
      );
      if (unsupported.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unsupported agent config fields: ${unsupported.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
    }

    // --- Apply agent config update ---
    if (body.agent) {
      smartAgent.applyConfigUpdate(body.agent as Record<string, unknown>);
    }

    // --- Return updated config ---
    const models = smartAgent.getActiveConfig();
    const agent = smartAgent.getAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models, agent }));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/smart-server.ts src/smart-agent/__tests__/config-endpoints.test.ts
git commit -m "feat(#78): add PUT /v1/config for agent parameters"
```

---

### Task 6: PUT /v1/config — Model Resolution

**Files:**
- Modify: `src/smart-agent/smart-server.ts`
- Modify: `src/smart-agent/__tests__/config-endpoints.test.ts`

This task adds `models` block support to PUT, using `IModelResolver`. Atomicity: all models are resolved before any mutation happens.

- [ ] **Step 1: Write the failing tests**

Add to `src/smart-agent/__tests__/config-endpoints.test.ts`:

```typescript
import { makeLlm as makeTestLlm } from '../testing/index.js';
import type { IModelResolver } from '../interfaces/model-resolver.js';
import type { ILlm } from '../interfaces/llm.js';

function makeResolver(
  results: Record<string, ILlm | Error>,
): IModelResolver {
  return {
    async resolve(modelName: string): Promise<ILlm> {
      const result = results[modelName];
      if (!result) throw new Error(`Unknown model: ${modelName}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe('PUT /v1/config — models', () => {
  it('resolves and reconfigures models when resolver is set', async () => {
    const newMain = { ...makeTestLlm([{ content: 'ok' }]), model: 'gpt-4o' };
    const resolver = makeResolver({ 'gpt-4o': newMain });

    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'gpt-4o' },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const models = body.models as Record<string, unknown>;
      assert.equal(models.mainModel, 'gpt-4o');
    } finally {
      await handle.close();
    }
  });

  it('returns 400 when models sent but no resolver configured', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'gpt-4o' },
      });
      assert.equal(res.status, 400);
      const body = res.body as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      assert.ok(String(error.message).includes('model resolver not configured'));
    } finally {
      await handle.close();
    }
  });

  it('returns 500 when model resolution fails', async () => {
    const resolver = makeResolver({
      'bad-model': new Error('Provider unreachable'),
    });

    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'bad-model' },
      });
      assert.equal(res.status, 500);
    } finally {
      await handle.close();
    }
  });

  it('is atomic — no changes applied when one model resolution fails', async () => {
    const goodLlm = { ...makeTestLlm([{ content: 'ok' }]), model: 'good-model' };
    const resolver = makeResolver({
      'good-model': goodLlm,
      'bad-model': new Error('resolution failed'),
    });

    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
      modelResolver: resolver,
      agent: { maxIterations: 10 },
    });
    const handle = await server.start();
    try {
      // Attempt to update both models + agent param — one model fails
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        models: { mainModel: 'good-model', classifierModel: 'bad-model' },
        agent: { maxIterations: 99 },
      });
      assert.equal(res.status, 500);

      // Verify nothing changed
      const getRes = await httpRequest(handle.port, 'GET', '/v1/config');
      const body = getRes.body as Record<string, unknown>;
      const agent = body.agent as Record<string, unknown>;
      assert.equal(agent.maxIterations, 10); // unchanged
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: FAIL — models block is ignored, no 400 for missing resolver

- [ ] **Step 3: Add `modelResolver` to SmartServerConfig**

In `src/smart-agent/smart-server.ts`, add to `SmartServerConfig` interface (around line 183, before the closing `}`):

```typescript
  /** Model resolver for PUT /v1/config model changes. When not set, model updates are rejected with 400. */
  modelResolver?: IModelResolver;
```

Add the import at the top of the file:

```typescript
import type { IModelResolver } from './interfaces/model-resolver.js';
```

- [ ] **Step 4: Update _handleConfigUpdate() for model resolution**

Replace the `_handleConfigUpdate` method with the version that handles models atomically:

```typescript
  private async _handleConfigUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    smartAgent: SmartAgent,
  ): Promise<void> {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Invalid JSON body', 'invalid_request_error'));
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(jsonError('Request body must be a JSON object', 'invalid_request_error'));
      return;
    }

    const body = parsed as Record<string, unknown>;

    // --- Validate agent fields against whitelist ---
    if (body.agent !== undefined) {
      if (typeof body.agent !== 'object' || body.agent === null || Array.isArray(body.agent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('"agent" must be a JSON object', 'invalid_request_error'));
        return;
      }
      const agentFields = body.agent as Record<string, unknown>;
      const unsupported = Object.keys(agentFields).filter(
        (k) => !SmartServer.AGENT_CONFIG_FIELDS.has(k),
      );
      if (unsupported.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unsupported agent config fields: ${unsupported.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
    }

    // --- Validate and resolve models (atomic: resolve ALL before mutating) ---
    let resolvedModels: SmartAgentReconfigureOptions | undefined;
    if (body.models !== undefined) {
      if (typeof body.models !== 'object' || body.models === null || Array.isArray(body.models)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('"models" must be a JSON object', 'invalid_request_error'));
        return;
      }
      if (!this.cfg.modelResolver) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('model resolver not configured', 'invalid_request_error'));
        return;
      }
      const modelFields = body.models as Record<string, unknown>;
      const validKeys = new Set(['mainModel', 'classifierModel', 'helperModel']);
      const unknownKeys = Object.keys(modelFields).filter((k) => !validKeys.has(k));
      if (unknownKeys.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unknown model fields: ${unknownKeys.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
      try {
        resolvedModels = {};
        if (modelFields.mainModel) {
          resolvedModels.mainLlm = await this.cfg.modelResolver.resolve(
            String(modelFields.mainModel), 'main',
          );
        }
        if (modelFields.classifierModel) {
          resolvedModels.classifierLlm = await this.cfg.modelResolver.resolve(
            String(modelFields.classifierModel), 'classifier',
          );
        }
        if (modelFields.helperModel) {
          resolvedModels.helperLlm = await this.cfg.modelResolver.resolve(
            String(modelFields.helperModel), 'helper',
          );
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(jsonError(String(err), 'server_error'));
        return;
      }
    }

    // --- All validation passed — apply mutations ---
    if (resolvedModels) {
      smartAgent.reconfigure(resolvedModels);
    }
    if (body.agent) {
      smartAgent.applyConfigUpdate(body.agent as Record<string, unknown>);
    }

    // --- Return updated config ---
    const models = smartAgent.getActiveConfig();
    const agent = smartAgent.getAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models, agent }));
  }
```

Add the import for `SmartAgentReconfigureOptions` at the top:

```typescript
import type { SmartAgentReconfigureOptions } from './agent.js';
```

(Check if `SmartAgent` is already imported from `./agent.js` — if so, add `SmartAgentReconfigureOptions` to the same import.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/smart-server.ts src/smart-agent/__tests__/config-endpoints.test.ts
git commit -m "feat(#78): add model resolution to PUT /v1/config with atomicity"
```

---

### Task 7: llmDefaults in Config DTO

**Files:**
- Modify: `src/smart-agent/smart-server.ts`
- Modify: `src/smart-agent/__tests__/config-endpoints.test.ts`

The spec defines `llmDefaults` (temperature, maxTokens) as server-held runtime state for new requests. SmartServer resolves temperature during `start()` — we store it as mutable state and expose via the config DTO.

- [ ] **Step 1: Write the failing tests**

Add to `src/smart-agent/__tests__/config-endpoints.test.ts`:

```typescript
describe('llmDefaults in config', () => {
  it('GET /v1/config includes llmDefaults', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model', temperature: 0.9 },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'GET', '/v1/config');
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      assert.ok(body.llmDefaults);
      const defaults = body.llmDefaults as Record<string, unknown>;
      assert.equal(defaults.temperature, 0.9);
    } finally {
      await handle.close();
    }
  });

  it('PUT /v1/config updates llmDefaults', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model', temperature: 0.7 },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        llmDefaults: { temperature: 0.3 },
      });
      assert.equal(res.status, 200);
      const body = res.body as Record<string, unknown>;
      const defaults = body.llmDefaults as Record<string, unknown>;
      assert.equal(defaults.temperature, 0.3);
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported llmDefaults fields', async () => {
    const server = new SmartServer({
      llm: { apiKey: 'test', model: 'test-model' },
      skipModelValidation: true,
    });
    const handle = await server.start();
    try {
      const res = await httpRequest(handle.port, 'PUT', '/v1/config', {
        llmDefaults: { topP: 0.9 },
      });
      assert.equal(res.status, 400);
    } finally {
      await handle.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: FAIL — no `llmDefaults` in response

- [ ] **Step 3: Add llmDefaults state to SmartServer.start()**

In `src/smart-agent/smart-server.ts`, inside `start()`, after the LLM resolution block (around line 319, after `helperLlm` is resolved), add mutable state:

```typescript
    // Mutable runtime LLM defaults exposed via /v1/config
    const llmDefaults = {
      temperature: mainTemp,
      maxTokens: Number(
        pipeline?.llm?.main?.maxTokens ?? undefined,
      ) || undefined,
    };
```

Pass `llmDefaults` to `_handle()` — add it as a new parameter. Update the `_handle` method signature:

```typescript
  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    requestLogger: IRequestLogger,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    healthChecker: HealthChecker,
    modelProvider?: IModelProvider,
    adapterMap?: Map<string, ILlmApiAdapter>,
    llmDefaults?: { temperature: number; maxTokens?: number },
  ): Promise<void> {
```

Update the `server = http.createServer(...)` call to pass `llmDefaults`:

```typescript
    const server = http.createServer((req, res) =>
      this._handle(
        req,
        res,
        requestLogger,
        smartAgent,
        chat,
        streamChat,
        log,
        healthChecker,
        modelProvider,
        adapterMap,
        llmDefaults,
      ).catch(/* ... existing error handler ... */),
    );
```

- [ ] **Step 4: Include llmDefaults in GET response**

Update the GET handler in `_handle()`:

```typescript
      if (req.method === 'GET') {
        const models = smartAgent.getActiveConfig();
        const agent = smartAgent.getAgentConfig();
        const body = { models, agent, llmDefaults };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
```

- [ ] **Step 5: Pass llmDefaults to _handleConfigUpdate and handle updates**

Update `_handleConfigUpdate` signature to accept and mutate `llmDefaults`:

```typescript
  private async _handleConfigUpdate(
    req: IncomingMessage,
    res: ServerResponse,
    smartAgent: SmartAgent,
    llmDefaults?: { temperature: number; maxTokens?: number },
  ): Promise<void> {
```

Add llmDefaults validation and whitelist in `_handleConfigUpdate`, after agent validation:

```typescript
    // --- Validate llmDefaults fields ---
    const LLM_DEFAULTS_FIELDS = new Set(['temperature', 'maxTokens']);
    if (body.llmDefaults !== undefined) {
      if (typeof body.llmDefaults !== 'object' || body.llmDefaults === null || Array.isArray(body.llmDefaults)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonError('"llmDefaults" must be a JSON object', 'invalid_request_error'));
        return;
      }
      const fields = body.llmDefaults as Record<string, unknown>;
      const unsupported = Object.keys(fields).filter((k) => !LLM_DEFAULTS_FIELDS.has(k));
      if (unsupported.length > 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          jsonError(
            `Unsupported llmDefaults fields: ${unsupported.join(', ')}`,
            'invalid_request_error',
          ),
        );
        return;
      }
    }
```

Add mutation in the "apply mutations" section:

```typescript
    if (body.llmDefaults && llmDefaults) {
      const fields = body.llmDefaults as Record<string, unknown>;
      if (fields.temperature !== undefined) llmDefaults.temperature = Number(fields.temperature);
      if (fields.maxTokens !== undefined) llmDefaults.maxTokens = Number(fields.maxTokens);
    }
```

Update the response to include llmDefaults:

```typescript
    const models = smartAgent.getActiveConfig();
    const agent = smartAgent.getAgentConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ models, agent, llmDefaults }));
```

Update the PUT handler call site in `_handle()`:

```typescript
      if (req.method === 'PUT') {
        await this._handleConfigUpdate(req, res, smartAgent, llmDefaults);
        return;
      }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/smart-agent/smart-server.ts src/smart-agent/__tests__/config-endpoints.test.ts
git commit -m "feat(#78): add llmDefaults to config DTO and PUT handler"
```

---

### Task 8: Exports and Final Verification

**Files:**
- Modify: `src/index.ts` (verify all exports are in place)

- [ ] **Step 1: Verify all exports**

Check that `src/index.ts` exports:
- `IModelResolver` (added in Task 1)
- `DefaultModelResolver` (added in Task 2)

These should already be exported. If not, add them.

- [ ] **Step 2: Run full build**

Run: `npm run build`
Expected: clean compilation

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors (auto-fix applied if needed)

- [ ] **Step 4: Run all tests**

Run: `npx tsx --test src/smart-agent/__tests__/config-endpoints.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Run existing tests to check for regressions**

Run: `npx tsx --test src/smart-agent/__tests__/reconfigure.test.ts`
Expected: PASS (no regressions)

Run: `npx tsx --test src/smart-agent/__tests__/smart-server-api-adapters.test.ts`
Expected: PASS (no regressions)

- [ ] **Step 6: Commit any final fixes**

```bash
git add -A
git commit -m "chore(#78): final cleanup and export verification"
```
