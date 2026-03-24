# Dynamic Model Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose real LLM provider models via `/v1/models` and support per-request model override in `/v1/chat/completions`, following existing DI patterns with zero breaking changes.

**Architecture:** New `IModelProvider` interface for model discovery (separate from `ILlm`). Per-request model override via `CallOptions.model` propagated through the agent layer to providers. `LlmAdapter` implements both interfaces. SmartServer delegates model listing and selection to the provider.

**Tech Stack:** TypeScript (ESM), Biome, `@sap-ai-sdk/ai-api` (new dependency for SAP model listing)

**Spec:** `docs/superpowers/specs/2026-03-24-dynamic-model-provider-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/smart-agent/interfaces/model-provider.ts` | Create | `IModelProvider`, `IModelInfo` types |
| `src/smart-agent/interfaces/types.ts` | Modify | `CallOptions` + `model?: string` |
| `src/agents/base.ts` | Modify | `AgentCallOptions` + `model?: string` |
| `src/llm-providers/base.ts` | Modify | `LLMProvider.getModels()` return type union |
| `src/llm-providers/openai.ts` | Modify | `getModels()` → `IModelInfo[]`, model override |
| `src/llm-providers/deepseek.ts` | Modify | Same as OpenAI |
| `src/llm-providers/anthropic.ts` | Modify | Same as OpenAI |
| `src/llm-providers/sap-core-ai.ts` | Modify | `getModels()` via SAP AI API, model override, TTL cache |
| `src/smart-agent/adapters/llm-adapter.ts` | Modify | `implements IModelProvider`, options subset extraction, healthCheck normalization |
| `src/smart-agent/llm/token-counting-llm.ts` | Modify | `get inner(): ILlm` accessor |
| `src/smart-agent/builder.ts` | Modify | `.withModelProvider()`, auto-detect, `SmartAgentHandle.modelProvider` |
| `src/smart-agent/smart-server.ts` | Modify | `/v1/models` delegates to provider, model passthrough, response model name |
| `src/index.ts` | Modify | Export `IModelProvider`, `IModelInfo` |
| `package.json` | Modify | `@sap-ai-sdk/ai-api` dependency, version bump |

---

### Task 1: IModelProvider Interface + CallOptions Extension

**Files:**
- Create: `src/smart-agent/interfaces/model-provider.ts`
- Modify: `src/smart-agent/interfaces/types.ts:21-38`
- Modify: `src/index.ts:88-113`

- [ ] **Step 1: Create `IModelProvider` interface file**

```typescript
// src/smart-agent/interfaces/model-provider.ts
import type { CallOptions, LlmError, Result } from './types.js';

export interface IModelInfo {
  id: string;
  owned_by?: string;
}

export interface IModelProvider {
  /** Currently configured (default) model name. */
  getModel(): string;

  /** Fetch available models from the provider. Called on demand. */
  getModels(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;
}
```

- [ ] **Step 2: Add `model` to `CallOptions`**

In `src/smart-agent/interfaces/types.ts`, add to `CallOptions` interface (after `stop?: string[];` at line 28):

```typescript
  /** Per-request model override. Affects only the main LLM. */
  model?: string;
```

- [ ] **Step 3: Export from `src/index.ts`**

Add near the other smart-agent interface exports (after line 91):

```typescript
export type {
  IModelInfo,
  IModelProvider,
} from './smart-agent/interfaces/model-provider.js';
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: PASS (no consumers use the new types yet)

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/interfaces/model-provider.ts src/smart-agent/interfaces/types.ts src/index.ts
git commit -m "feat: add IModelProvider interface and CallOptions.model field"
```

---

### Task 2: AgentCallOptions + LLMProvider Base Type

**Files:**
- Modify: `src/agents/base.ts:27-32`
- Modify: `src/llm-providers/base.ts:24`

- [ ] **Step 1: Add `model` to `AgentCallOptions`**

In `src/agents/base.ts`, add to `AgentCallOptions` interface (after `stop?: string[];` at line 31):

```typescript
  model?: string;
```

- [ ] **Step 2: Update `LLMProvider.getModels` return type**

In `src/llm-providers/base.ts`, add import at the top:

```typescript
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
```

Change line 24 from:

```typescript
  getModels?(): Promise<string[]>;
```

to:

```typescript
  getModels?(): Promise<string[] | IModelInfo[]>;
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agents/base.ts src/llm-providers/base.ts
git commit -m "feat: extend AgentCallOptions with model, update LLMProvider.getModels return type"
```

---

### Task 3: OpenAI Provider — Model Override + getModels

**Files:**
- Modify: `src/llm-providers/openai.ts:46,90,137-140`

- [ ] **Step 1: Update `getModels()` to return `IModelInfo[]`**

In `src/llm-providers/openai.ts`, add import:

```typescript
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
```

Replace `getModels()` (lines 137-140):

```typescript
  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/llm-providers/openai.ts
git commit -m "feat(openai): return IModelInfo from getModels"
```

---

### Task 4: DeepSeek Provider — Model Override + getModels

**Files:**
- Modify: `src/llm-providers/deepseek.ts:44,125,113-116`

- [ ] **Step 1: Update `getModels()` to return `IModelInfo[]`**

In `src/llm-providers/deepseek.ts`, add import:

```typescript
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
```

Replace `getModels()` (lines 113-116):

```typescript
  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/llm-providers/deepseek.ts
git commit -m "feat(deepseek): return IModelInfo from getModels"
```

---

### Task 5: Anthropic Provider — Model Override + getModels

**Files:**
- Modify: `src/llm-providers/anthropic.ts:48,143,79-82`

- [ ] **Step 1: Update `getModels()` to return `IModelInfo[]`**

In `src/llm-providers/anthropic.ts`, add import:

```typescript
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
```

Replace `getModels()` (lines 79-82):

```typescript
  async getModels(): Promise<IModelInfo[]> {
    const response = await this.client.get('/models');
    return (response.data.data as Array<{ id: string; owned_by?: string }>).map(
      (m) => ({ id: m.id, owned_by: m.owned_by }),
    );
  }
```

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/llm-providers/anthropic.ts
git commit -m "feat(anthropic): return IModelInfo from getModels"
```

---

### Task 6: SAP AI Core Provider — getModels via ScenarioApi + TTL Cache

**Files:**
- Modify: `src/llm-providers/sap-core-ai.ts:151-155`
- Modify: `package.json`

- [ ] **Step 1: Install `@sap-ai-sdk/ai-api` as optional peer dependency**

Add to `package.json` `peerDependencies` section:

```json
"@sap-ai-sdk/ai-api": "^1.0.0"
```

And in `peerDependenciesMeta`:

```json
"@sap-ai-sdk/ai-api": { "optional": true }
```

This keeps it optional — consumers who don't use SAP AI Core don't need it. The dynamic `import()` in Step 2 handles the case when it's not installed.

- [ ] **Step 2: Update `getModels()` with ScenarioApi and TTL cache**

In `src/llm-providers/sap-core-ai.ts`, add import at top:

```typescript
import type { IModelInfo } from '../smart-agent/interfaces/model-provider.js';
```

Add private cache fields to the class (after the existing private fields):

```typescript
  private modelsCache: IModelInfo[] | null = null;
  private modelsCacheExpiry = 0;
  private static readonly MODELS_CACHE_TTL_MS = 60_000;
```

Replace `getModels()` (lines 151-155):

```typescript
  async getModels(): Promise<IModelInfo[]> {
    if (this.modelsCache && Date.now() < this.modelsCacheExpiry) {
      return this.modelsCache;
    }
    try {
      const { ScenarioApi } = await import('@sap-ai-sdk/ai-api');
      const result = await ScenarioApi.scenarioQueryModels(
        'foundation-models',
        { 'AI-Resource-Group': this.resourceGroup },
      ).execute();
      const models: IModelInfo[] = (
        result.resources as Array<{
          model: string;
          executableId?: string;
        }>
      ).map((m) => ({
        id: m.model,
        owned_by: m.executableId,
      }));
      this.modelsCache = models;
      this.modelsCacheExpiry = Date.now() + SapCoreAIProvider.MODELS_CACHE_TTL_MS;
      return models;
    } catch {
      // Fallback to configured model if AI API is not available
      return [{ id: this.model }];
    }
  }
```

Note: uses dynamic `import()` so `@sap-ai-sdk/ai-api` is only loaded when `getModels()` is actually called. The `this.resourceGroup` field already exists on the provider.

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/llm-providers/sap-core-ai.ts package.json package-lock.json
git commit -m "feat(sap-ai-core): implement getModels via ScenarioApi with TTL cache"
```

---

### Task 7: Agent Subclasses — Propagate options.model

**Files:**
- Modify: `src/agents/openai-agent.ts:42,46,77,90`
- Modify: `src/agents/deepseek-agent.ts:40,44,118,125`
- Modify: `src/agents/anthropic-agent.ts:44,48,134,143`
- Modify: `src/agents/sap-core-ai-agent.ts:39,44,61,72`

The pattern is the same for OpenAI, DeepSeek, and Anthropic agents: they destructure `model` from `this.llmProvider` and use it in the request body. Override with `options?.model ?? model`.

- [ ] **Step 1: OpenAI Agent — model override**

In `src/agents/openai-agent.ts`:

Line 42: `const { client, model, config } = this.llmProvider;`
Line 46: change `model,` to `model: options?.model ?? model,`

Line 77: `const { model, config } = this.llmProvider;`
Line 90: change `model,` to `model: options?.model ?? model,`

- [ ] **Step 2: DeepSeek Agent — model override**

In `src/agents/deepseek-agent.ts`:

**`callLLMWithTools` (line 30-33) does not accept `options`.** Add it:

```typescript
  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
```

Line 40: `const { client, model, config } = this.llmProvider;`
Line 44: change `model,` to `model: options?.model ?? model,`

**`streamLLMWithTools` (line 114):** rename `_options` to `options`.
Line 118: `const { model, config } = this.llmProvider;`
Line 125: change `model,` to `model: options?.model ?? model,`

- [ ] **Step 3: Anthropic Agent — model override**

In `src/agents/anthropic-agent.ts`:

**`callLLMWithTools` (line 31-34) does not accept `options`.** Add it:

```typescript
  protected async callLLMWithTools(
    messages: Message[],
    tools: unknown[],
    options?: AgentCallOptions,
  ): Promise<{ content: string; raw?: unknown }> {
```

Line 44: `const { client, model, config } = this.llmProvider;`
Line 48: change `model,` to `model: options?.model ?? model,`

Line 134: `const { model, config } = this.llmProvider;`
Line 143: change `model,` to `model: options?.model ?? model,`

- [ ] **Step 4: SAP AI Core Agent — model override**

In `src/agents/sap-core-ai-agent.ts`, the agent delegates to `this.llmProvider.chat()` and `this.llmProvider.streamChat()`. The `LLMProvider` base interface defines `chat(messages, tools?)` — we cannot add a third `model` parameter without breaking the base interface.

Instead, use a setter on the provider to set a temporary model override:

In `src/llm-providers/sap-core-ai.ts`, add a model override field and setter:

```typescript
  private modelOverride?: string;

  /** Set a per-request model override. Cleared after each chat/streamChat call. */
  setModelOverride(model?: string): void {
    this.modelOverride = model;
  }
```

In `createClient()` (line 166), use `this.modelOverride ?? this.model` where model is set.

At the end of `chat()` and `streamChat()`, clear the override:

```typescript
  // In chat(), after getting response:
  this.modelOverride = undefined;
```

Then in `src/agents/sap-core-ai-agent.ts`:

Line 39: rename `_options` to `options`

Before the `this.llmProvider.chat()` call:
```typescript
    if (options?.model) {
      this.llmProvider.setModelOverride(options.model);
    }
```

Line 61: rename `_options` to `options`, same pattern for `streamChat`.

Note: this is not thread-safe, but the agent processes requests sequentially per instance.

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/agents/openai-agent.ts src/agents/deepseek-agent.ts src/agents/anthropic-agent.ts src/agents/sap-core-ai-agent.ts src/llm-providers/sap-core-ai.ts
git commit -m "feat: propagate options.model through agent subclasses to providers"
```

---

### Task 8: LlmAdapter — IModelProvider + Options Subset Extraction

**Files:**
- Modify: `src/smart-agent/adapters/llm-adapter.ts:241-244,246-250,271,328-351`

- [ ] **Step 1: Update `LlmAdapterProviderInfo` return type**

In `src/smart-agent/adapters/llm-adapter.ts`, add import:

```typescript
import type {
  IModelInfo,
  IModelProvider,
} from '../interfaces/model-provider.js';
```

Change `LlmAdapterProviderInfo` (lines 241-244):

```typescript
export interface LlmAdapterProviderInfo {
  model: string;
  getModels?(): Promise<string[] | IModelInfo[]>;
}
```

- [ ] **Step 2: Add normalization helper**

Add before the `LlmAdapter` class:

```typescript
function normalizeModelEntry(entry: string | IModelInfo): IModelInfo {
  return typeof entry === 'string' ? { id: entry } : entry;
}
```

- [ ] **Step 3: Implement `IModelProvider` on `LlmAdapter`**

Change class declaration (line 246):

```typescript
export class LlmAdapter implements ILlm, IModelProvider {
```

Add methods to the class:

```typescript
  getModel(): string {
    return this.provider?.model ?? 'unknown';
  }

  async getModels(
    options?: CallOptions,
  ): Promise<Result<IModelInfo[], LlmError>> {
    if (!this.provider?.getModels) {
      return {
        ok: true,
        value: [{ id: this.provider?.model ?? 'unknown' }],
      };
    }
    try {
      const modelsPromise = this.provider.getModels();
      const raw = options?.signal
        ? await withAbort(
            modelsPromise,
            options.signal,
            () => new LlmError('Aborted', 'ABORTED'),
          )
        : await modelsPromise;
      return { ok: true, value: raw.map(normalizeModelEntry) };
    } catch (err) {
      if (err instanceof LlmError) return { ok: false, error: err };
      return {
        ok: false,
        error: new LlmError(String(err), 'MODEL_LIST_FAILED'),
      };
    }
  }
```

- [ ] **Step 4: Extract options subset in `chat()` and `streamChat()`**

In the `chat()` method, before calling `this.agent.callWithTools()` (around line 271), extract the agent-compatible subset:

```typescript
      const agentOptions = options
        ? {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            topP: options.topP,
            stop: options.stop,
            model: options.model,
          }
        : undefined;
```

Then pass `agentOptions` instead of `options` to `callWithTools()`:

```typescript
      const raw = await withAbort(
        this.agent.callWithTools(messages, mcpTools, agentOptions) as Promise<{
```

Do the same in `streamChat()` (around line 304).

- [ ] **Step 5: Update `healthCheck()` to handle union type**

In `healthCheck()` (lines 328-351), change the model comparison (line 342):

From:
```typescript
      const found = models.some((m) => m === model || m.includes(model));
```

To:
```typescript
      const found = models
        .map(normalizeModelEntry)
        .some((m) => m.id === model || m.id.includes(model));
```

- [ ] **Step 6: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/smart-agent/adapters/llm-adapter.ts
git commit -m "feat: LlmAdapter implements IModelProvider with options subset extraction"
```

---

### Task 9: TokenCountingLlm — Inner Accessor

**Files:**
- Modify: `src/smart-agent/llm/token-counting-llm.ts:40`

- [ ] **Step 1: Add `inner` getter**

In `src/smart-agent/llm/token-counting-llm.ts`, after the private field `private readonly inner: ILlm;` (line 40), add:

```typescript
  /** Expose wrapped ILlm for auto-detection of IModelProvider. */
  get wrappedLlm(): ILlm {
    return this.inner;
  }
```

Note: using `wrappedLlm` instead of `inner` to avoid shadowing the private field and to be more descriptive.

- [ ] **Step 2: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/smart-agent/llm/token-counting-llm.ts
git commit -m "feat: add wrappedLlm accessor to TokenCountingLlm"
```

---

### Task 10: SmartAgentBuilder — withModelProvider + Auto-detect

**Files:**
- Modify: `src/smart-agent/builder.ts:108-129,139,726-738`

- [ ] **Step 1: Add import and type guard**

In `src/smart-agent/builder.ts`, add import:

```typescript
import type {
  IModelProvider,
} from './interfaces/model-provider.js';
import { TokenCountingLlm } from './llm/token-counting-llm.js';
```

Add the type guard function (before the class):

```typescript
function isModelProvider(obj: unknown): obj is IModelProvider {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof (obj as IModelProvider).getModels === 'function' &&
    typeof (obj as IModelProvider).getModel === 'function'
  );
}
```

- [ ] **Step 2: Add `modelProvider` to `SmartAgentHandle`**

In the `SmartAgentHandle` interface (lines 108-129), add:

```typescript
  /** Model provider for discovery. Undefined when not available. */
  modelProvider?: IModelProvider;
```

- [ ] **Step 3: Add fluent setter and private field**

Add to class fields (near line 139):

```typescript
  private _modelProvider?: IModelProvider;
```

Add fluent setter method:

```typescript
  /** Set a model provider for model discovery and metadata. */
  withModelProvider(provider: IModelProvider): this {
    this._modelProvider = provider;
    return this;
  }
```

- [ ] **Step 4: Add auto-detection and expose in `build()` return**

In the `build()` method, before the final `return` (around line 726), add auto-detection:

```typescript
    // ---- Model provider auto-detection ------------------------------------
    let modelProvider: IModelProvider | undefined = this._modelProvider;
    if (!modelProvider) {
      // Unwrap TokenCountingLlm to find LlmAdapter (which implements IModelProvider)
      const candidate =
        mainLlm instanceof TokenCountingLlm ? mainLlm.wrappedLlm : mainLlm;
      if (isModelProvider(candidate)) {
        modelProvider = candidate;
      }
    }
```

Add `modelProvider` to the returned handle object (around line 726-738):

```typescript
    return {
      agent,
      chat: ...,
      streamChat: ...,
      getUsage: ...,
      close: ...,
      circuitBreakers,
      ragStores,
      modelProvider,
    };
```

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/builder.ts
git commit -m "feat: SmartAgentBuilder.withModelProvider with auto-detection from LlmAdapter"
```

---

### Task 11: SmartServer — Dynamic /v1/models + Model Passthrough

**Files:**
- Modify: `src/smart-agent/smart-server.ts:549,589-598,614-633,909,952,986`

- [ ] **Step 1: Pass modelProvider to _handle**

In `src/smart-agent/smart-server.ts`, add import:

```typescript
import type { IModelProvider } from './interfaces/model-provider.js';
```

After `builder.build()` (around line 442-450), extract `modelProvider`:

```typescript
    const {
      agent: smartAgent,
      chat,
      streamChat,
      close: closeAgent,
      circuitBreakers,
      ragStores,
      modelProvider,
    } = agentHandle;
```

Update the `server` creation (around line 548-549) to pass `modelProvider`:

```typescript
    const server = http.createServer((req, res) =>
      this._handle(
        req,
        res,
        getUsage,
        smartAgent,
        chat,
        streamChat,
        log,
        healthChecker,
        modelProvider,
      ).catch(...)
```

- [ ] **Step 2: Update `_handle` signature**

Update `_handle` method signature (line 589) to accept `modelProvider`:

```typescript
  private async _handle(
    req: IncomingMessage,
    res: ServerResponse,
    getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    chat: SmartAgentHandle['chat'],
    streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    healthChecker: HealthChecker,
    modelProvider?: IModelProvider,
  ): Promise<void> {
```

- [ ] **Step 3: Update GET /v1/models handler**

Replace the hardcoded response (lines 614-633):

```typescript
    if (
      req.method === 'GET' &&
      (urlPath === '/v1/models' || urlPath === '/models')
    ) {
      let data: Array<Record<string, unknown>> = [
        { id: 'smart-agent', object: 'model', owned_by: 'smart-agent' },
      ];
      if (modelProvider) {
        const result = await modelProvider.getModels();
        if (result.ok) {
          data = result.value.map((m) => ({
            id: m.id,
            object: 'model',
            owned_by: m.owned_by ?? 'unknown',
          }));
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data }));
      return;
    }
```

- [ ] **Step 4: Pass modelProvider to _handleChat**

Update `_handleChat` call (around line 653) to pass `modelProvider`:

```typescript
      await this._handleChat(
        req,
        res,
        getUsage,
        smartAgent,
        chat,
        streamChat,
        log,
        modelProvider,
      );
```

Update `_handleChat` signature (around line 670):

```typescript
  private async _handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    _getUsage: () => TokenUsage,
    smartAgent: SmartAgent,
    _chat: SmartAgentHandle['chat'],
    _streamChat: SmartAgentHandle['streamChat'],
    log: (e: Record<string, unknown>) => void,
    modelProvider?: IModelProvider,
  ): Promise<void> {
```

- [ ] **Step 5: Extract body.model and pass through options**

In `_handleChat`, add `model` to the parsed body type (around line 703):

```typescript
    const body = parsed as {
      messages: Array<{...}>;
      model?: string;
      tools?: unknown[];
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
```

In the `opts` object (around line 787), add model:

```typescript
    const opts = {
      stream: body.stream,
      externalTools,
      sessionId,
      trace: { traceId },
      sessionLogger,
      model: body.model,
    };
```

- [ ] **Step 6: Replace hardcoded 'smart-agent' model name in responses**

Compute the response model name once (add before the streaming/non-streaming branch):

```typescript
    const responseModel =
      body.model ?? modelProvider?.getModel() ?? 'smart-agent';
```

Replace all occurrences of `model: 'smart-agent'` with `model: responseModel`:

- Line 909: `model: 'smart-agent',` → `model: responseModel,`
- Line 952: `model: 'smart-agent',` → `model: responseModel,`
- Line 986: `model: 'smart-agent',` → `model: responseModel,`

- [ ] **Step 7: Build to verify**

Run: `npm run build`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/smart-agent/smart-server.ts
git commit -m "feat: SmartServer delegates /v1/models to IModelProvider, passes model per request"
```

---

### Task 12: Final — Lint, Build, Smoke Test

**Files:**
- All modified files

- [ ] **Step 1: Lint**

Run: `npm run lint`
Fix any issues reported by Biome.

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: PASS with zero errors

- [ ] **Step 3: Verify exports**

Quick check that the public API exports compile:

```bash
node -e "import('@mcp-abap-adt/llm-agent').then(m => console.log('IModelProvider' in m ? 'OK' : 'MISSING'))"
```

Or check in the dist output:

```bash
grep -r 'IModelProvider' dist/
```

- [ ] **Step 4: Commit lint fixes if any**

```bash
git add -A
git commit -m "chore: lint fixes"
```

---

### Task 13: Version Bump

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version to 3.2.0**

In `package.json`, change `"version"` to `"3.2.0"`.

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 3.2.0"
```
