# Colliding-MCP-tool call-path namespacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A specific colliding MCP tool becomes individually callable — colliding tools are renamed on exposure (`primary__Search`) from a stable server identity, kept consistent across RAG/exposure/all executors/all refresh paths, and the real MCP call always uses the original name.

**Architecture:** One pure `buildNamespacedTools` (collision-only rename, per-name validity + global-uniqueness guards) is the single builder used by exposure, both refresh paths, and RAG. The original-name strip is ENCAPSULATED in the tool→client map value: a renamed tool's value is a thin `IMcpClient` wrapper (`bindToolCallName`) — so no call site and no public `toolClientMap` type changes. The prefix comes from a stable `{ slotIndex, label }` descriptor carried on `McpConnectionResult` (config-array position + `mcp[].name`), not the runtime array index. A shared `mergeOfferedTools` fail-fasts on an internal↔external name collision.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 22, `node:test` via `tsx`, Biome.

**Spec:** `docs/superpowers/specs/2026-07-26-tool-namespacing-design.md`

**Issue:** [#244](https://github.com/fr0ster/llm-agent/issues/244)

## Global Constraints

- All artifacts (code, comments, commit messages) in **English**.
- ESM only — relative imports end in `.js`.
- TypeScript strict; avoid `any` (Biome warns).
- Biome gate: `npm run lint:check` (a **check**, not `format`) clean of NEW errors.
- Build gate: `npm run build` clean before each commit.
- Test: single file `npx tsx --test <path>`; package `npm test --workspace <pkg>`.
- **Additive public API only.** New: `IToolNamespace`, `ToolNamespaceContext`, `defaultToolNamespace`, `bindToolCallName`, `buildNamespacedTools`, `mergeOfferedTools`, `McpConnectionResult.clientDescriptors?` + `configuredSlotCount?`, `McpConnectionConfig.name?`, `MCPClientConfig.name?`, `BuilderMcpConfig.name?`, `SmartServerMcpConfig.name?`, `PipelineContext.mcpClientDescriptors?`. **UNCHANGED:** the `IToolRecordKey` INTERFACE (its `ToolKeyContext` inputs are stabilized to `slotIndex`/`configuredSlotCount`, a value change that fixes a latent #240 bug but does not alter single-server ids), the `Map<string, IMcpClient>` value type of `toolClientMap`, and single-server behaviour.
- **`toolsChanged` becomes bidirectional** (fire on active-slot gain OR loss) — required for the peer-outage re-vectorize.
- **Separator `__`; exposed names must match `^[a-zA-Z0-9_-]+$`, non-empty, ≤ 64 chars.**
- Namespace ONLY on a real collision (a name exposed by ≥2 currently-active clients). A unique name stays bare (`exposed === original`, value === real client).

## Packages touched (4 of 6)

- `@mcp-abap-adt/llm-agent` — contracts + pure helpers.
- `@mcp-abap-adt/llm-agent-mcp` — MCP config + connection strategies.
- `@mcp-abap-adt/llm-agent-libs` — registry, pipeline, agent, builder.
- `@mcp-abap-adt/llm-agent-server-libs` — SmartServer config parse.

---

### Task 1: `IToolNamespace` strategy + `bindToolCallName` wrapper (pure, contracts)

**Files:**
- Create: `packages/llm-agent/src/interfaces/tool-namespace.ts`
- Create: `packages/llm-agent/src/interfaces/tool-namespace.test.ts`
- Modify: `packages/llm-agent/src/index.ts` (re-export)

**Interfaces produced:** `ToolNamespaceContext`, `IToolNamespace`, `defaultToolNamespace`, `bindToolCallName`.

- [ ] **Step 1: Write the failing test**

Create `tool-namespace.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, McpTool } from './mcp-client.js';
import { bindToolCallName, defaultToolNamespace } from './tool-namespace.js';

describe('defaultToolNamespace', () => {
  it('bare when not colliding', () => {
    assert.equal(
      defaultToolNamespace.expose({ toolName: 'Search', prefix: 's0', colliding: false }),
      'Search',
    );
  });
  it('prefixed with `__` when colliding', () => {
    assert.equal(
      defaultToolNamespace.expose({ toolName: 'Search', prefix: 'primary', colliding: true }),
      'primary__Search',
    );
  });
});

describe('bindToolCallName', () => {
  it('callTool always uses the original name, ignoring the exposed name passed in', async () => {
    const calls: string[] = [];
    const real = {
      async listTools() { return { ok: true, value: [] as McpTool[] }; },
      async callTool(name: string) { calls.push(name); return { ok: true, value: { content: name } }; },
    } as unknown as IMcpClient;
    const bound = bindToolCallName(real, 'Search');
    await bound.callTool('primary__Search', {});
    assert.deepEqual(calls, ['Search']); // original, not the exposed name
  });
  it('proxies listTools (and healthCheck when present) unchanged', async () => {
    let listed = false;
    const real = {
      async listTools() { listed = true; return { ok: true, value: [] as McpTool[] }; },
      async callTool() { return { ok: true, value: { content: '' } }; },
    } as unknown as IMcpClient;
    await bindToolCallName(real, 'X').listTools();
    assert.equal(listed, true);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --test packages/llm-agent/src/interfaces/tool-namespace.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `tool-namespace.ts`:

```ts
import type { IMcpClient } from './mcp-client.js';

export interface ToolNamespaceContext {
  /** Original tool name the server exposes. */
  toolName: string;
  /** Prefix source resolved by the builder: the server's config `name`, else `s${slotIndex}`. */
  prefix: string;
  /** True when this tool name is exposed by more than one currently-active client. */
  colliding: boolean;
}

export interface IToolNamespace {
  /** Name the LLM sees / RAG stores. Must be non-empty, `^[a-zA-Z0-9_-]+$`, <= 64 chars.
   *  The builder validates this output — an invalid name fails fast. */
  expose(ctx: ToolNamespaceContext): string;
}

/** Bare when unique; `${prefix}__${toolName}` on a collision. */
export const defaultToolNamespace: IToolNamespace = {
  expose: ({ toolName, prefix, colliding }): string =>
    colliding ? `${prefix}__${toolName}` : toolName,
};

/**
 * Wrap an MCP client so `callTool` always targets `originalName`, whatever
 * (exposed) name the caller passes. All other IMcpClient methods proxy straight
 * through. This encapsulates the namespace strip in the tool→client map value,
 * so no executor call site needs to know about namespacing.
 */
export function bindToolCallName(client: IMcpClient, originalName: string): IMcpClient {
  return {
    listTools: (options) => client.listTools(options),
    callTool: (_exposedName, args, options) => client.callTool(originalName, args, options),
    ...(client.healthCheck
      ? { healthCheck: (options) => client.healthCheck?.(options) }
      : {}),
  } as IMcpClient;
}
```

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --test packages/llm-agent/src/interfaces/tool-namespace.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-export from the barrel**

In `packages/llm-agent/src/index.ts`, add beside the `IToolRecordKey` export:

```ts
export {
  bindToolCallName,
  defaultToolNamespace,
  type IToolNamespace,
  type ToolNamespaceContext,
} from './interfaces/tool-namespace.js';
```

- [ ] **Step 6: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent/src/interfaces/tool-namespace.ts packages/llm-agent/src/interfaces/tool-namespace.test.ts packages/llm-agent/src/index.ts
git commit -m "feat(agent): IToolNamespace strategy + bindToolCallName wrapper (#244)"
```

---

### Task 2: `buildNamespacedTools` — the shared builder (pure, contracts)

**Files:**
- Create: `packages/llm-agent/src/interfaces/build-namespaced-tools.ts`
- Create: `packages/llm-agent/src/interfaces/build-namespaced-tools.test.ts`
- Modify: `packages/llm-agent/src/index.ts`

**Consumes:** `IToolNamespace`, `bindToolCallName`, `IMcpClient`, `McpTool` (Task 1 / existing).
**Produces:** `buildNamespacedTools(perClient, ns) → { tools: McpTool[]; toolClientMap: Map<string, IMcpClient> }`.

- [ ] **Step 1: Write the failing test**

Create `build-namespaced-tools.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpClient, McpTool } from './mcp-client.js';
import { buildNamespacedTools } from './build-namespaced-tools.js';
import { defaultToolNamespace } from './tool-namespace.js';

const tool = (name: string): McpTool => ({ name, description: '', inputSchema: {} }) as McpTool;
const fakeClient = (id: string): IMcpClient =>
  ({ id, async listTools() { return { ok: true, value: [] }; },
     async callTool() { return { ok: true, value: { content: '' } }; } }) as unknown as IMcpClient;

describe('buildNamespacedTools', () => {
  it('renames colliding tools with the prefix; bindings call the original name', async () => {
    const c0 = fakeClient('c0'); const c1 = fakeClient('c1');
    const captured: Array<{ id: string; name: string }> = [];
    const spy = (id: string, c: IMcpClient): IMcpClient =>
      ({ ...c, callTool: async (name: string) => { captured.push({ id, name }); return { ok: true, value: { content: '' } }; } }) as unknown as IMcpClient;
    const { tools, toolClientMap } = buildNamespacedTools(
      [
        { slotIndex: 0, label: 'primary', client: spy('c0', c0), tools: [tool('Search')] },
        { slotIndex: 1, label: 'secondary', client: spy('c1', c1), tools: [tool('Search')] },
      ],
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((t) => t.name).sort(), ['primary__Search', 'secondary__Search']);
    await toolClientMap.get('secondary__Search')!.callTool('secondary__Search', {});
    assert.deepEqual(captured, [{ id: 'c1', name: 'Search' }]); // original name, correct client
  });

  it('unique names stay bare; value is the real client', () => {
    const c0 = fakeClient('c0');
    const { tools, toolClientMap } = buildNamespacedTools(
      [{ slotIndex: 0, client: c0, tools: [tool('OnlyHere')] }],
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((t) => t.name), ['OnlyHere']);
    assert.equal(toolClientMap.get('OnlyHere'), c0);
  });

  it('prefix falls back to s${slotIndex} when no label', () => {
    const { tools } = buildNamespacedTools(
      [
        { slotIndex: 0, client: fakeClient('a'), tools: [tool('Go')] },
        { slotIndex: 3, client: fakeClient('b'), tools: [tool('Go')] },
      ],
      defaultToolNamespace,
    );
    assert.deepEqual(tools.map((t) => t.name).sort(), ['s0__Go', 's3__Go']);
  });

  it('fail-fast: a generated name equal to a real bare name', () => {
    assert.throws(() =>
      buildNamespacedTools(
        [
          { slotIndex: 0, client: fakeClient('a'), tools: [tool('Search')] },
          { slotIndex: 1, client: fakeClient('b'), tools: [tool('Search')] },
          { slotIndex: 2, client: fakeClient('c'), tools: [tool('s0__Search')] },
        ],
        defaultToolNamespace,
      ),
    /* diagnostic */ /s0__Search|unique|collision/i);
  });

  it('fail-fast: custom strategy returns a provider-invalid name', () => {
    const bad = { expose: () => 'server:Search' };
    assert.throws(() =>
      buildNamespacedTools([{ slotIndex: 0, client: fakeClient('a'), tools: [tool('Search')] },
                            { slotIndex: 1, client: fakeClient('b'), tools: [tool('Search')] }], bad),
    /invalid|\^\[a-zA-Z0-9_-\]/i);
  });

  it('fail-fast: custom strategy returns an empty name', () => {
    const bad = { expose: () => '' };
    assert.throws(() =>
      buildNamespacedTools([{ slotIndex: 0, client: fakeClient('a'), tools: [tool('X')] }], bad),
    /invalid|empty/i);
  });
});
```

- [ ] **Step 2: Run RED** — `npx tsx --test packages/llm-agent/src/interfaces/build-namespaced-tools.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `build-namespaced-tools.ts`:

```ts
import type { IMcpClient, McpTool } from './mcp-client.js';
import { bindToolCallName, type IToolNamespace } from './tool-namespace.js';

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

export interface NamespaceClientInput {
  slotIndex: number;
  label?: string;
  client: IMcpClient;
  tools: McpTool[];
}

export function buildNamespacedTools(
  perClient: NamespaceClientInput[],
  ns: IToolNamespace,
): { tools: McpTool[]; toolClientMap: Map<string, IMcpClient> } {
  // Collision = a tool name present in >= 2 clients.
  const counts = new Map<string, number>();
  for (const pc of perClient)
    for (const t of pc.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const tools: McpTool[] = [];
  const toolClientMap = new Map<string, IMcpClient>();
  const owner = new Map<string, { slotIndex: number; toolName: string }>(); // exposed → source

  for (const pc of perClient) {
    const prefix = pc.label ?? `s${pc.slotIndex}`;
    for (const t of pc.tools) {
      const colliding = (counts.get(t.name) ?? 0) > 1;
      const exposed = ns.expose({ toolName: t.name, prefix, colliding });

      // Per-name validity guard — the builder is the trust boundary for the strategy.
      if (typeof exposed !== 'string' || exposed.length === 0 || exposed.length > 64 || !VALID_TOOL_NAME.test(exposed))
        throw new Error(
          `IToolNamespace produced an invalid tool name ${JSON.stringify(exposed)} ` +
            `for tool "${t.name}" on server slot ${pc.slotIndex}${pc.label ? ` (${pc.label})` : ''}; ` +
            `must be non-empty, /^[a-zA-Z0-9_-]+$/, <= 64 chars.`,
        );
      // Global-uniqueness guard — the final exposed set (renamed AND bare) must be unique.
      const prev = owner.get(exposed);
      if (prev)
        throw new Error(
          `Tool name collision: "${exposed}" is produced by both ` +
            `slot ${prev.slotIndex} tool "${prev.toolName}" and slot ${pc.slotIndex} tool "${t.name}". ` +
            `Set distinct mcp[].name labels.`,
        );
      owner.set(exposed, { slotIndex: pc.slotIndex, toolName: t.name });

      tools.push({ ...t, name: exposed });
      toolClientMap.set(exposed, exposed === t.name ? pc.client : bindToolCallName(pc.client, t.name));
    }
  }
  return { tools, toolClientMap };
}
```

- [ ] **Step 4: Run GREEN** — all cases pass.

- [ ] **Step 5: Re-export** — in `index.ts`:

```ts
export { buildNamespacedTools, type NamespaceClientInput } from './interfaces/build-namespaced-tools.js';
```

- [ ] **Step 6: Build + lint, commit**

```bash
npm run build && npm run lint:check
git add packages/llm-agent/src/interfaces/build-namespaced-tools.ts packages/llm-agent/src/interfaces/build-namespaced-tools.test.ts packages/llm-agent/src/index.ts
git commit -m "feat(agent): buildNamespacedTools — collision rename + validity/uniqueness guards (#244)"
```

---

### Task 3: `mergeOfferedTools` — internal↔external collision fail-fast (pure, contracts)

**Files:**
- Create: `packages/llm-agent/src/interfaces/merge-offered-tools.ts`
- Create: `packages/llm-agent/src/interfaces/merge-offered-tools.test.ts`
- Modify: `packages/llm-agent/src/index.ts`

**Produces:** `mergeOfferedTools(internal: LlmTool[], external: readonly LlmTool[]): LlmTool[]`.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmTool } from './llm.js';
import { mergeOfferedTools } from './merge-offered-tools.js';

const t = (name: string): LlmTool => ({ name, description: '', inputSchema: {} }) as LlmTool;

describe('mergeOfferedTools', () => {
  it('concats when names are disjoint', () => {
    assert.deepEqual(
      mergeOfferedTools([t('primary__Search')], [t('web_fetch')]).map((x) => x.name),
      ['primary__Search', 'web_fetch'],
    );
  });
  it('fail-fast when an external name equals a bare internal name', () => {
    assert.throws(() => mergeOfferedTools([t('Search')], [t('Search')]), /Search|both.*internal.*external/i);
  });
  it('fail-fast when an external name equals a generated namespace', () => {
    assert.throws(() => mergeOfferedTools([t('s0__Search')], [t('s0__Search')]), /s0__Search/);
  });
});
```

> Confirm the exact import path for `LlmTool` (e.g. `./llm.js`) against `packages/llm-agent/src/index.ts` exports; adjust if it lives elsewhere.

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement** `merge-offered-tools.ts`:

```ts
import type { LlmTool } from './llm.js';

/**
 * Concatenate internal (MCP, already namespace-unique) and external
 * (client-provided) tools for the LLM. Fail-fast on any name in BOTH sets:
 * the offered list must be unique so classifyToolCalls cannot double-classify.
 */
export function mergeOfferedTools(
  internal: readonly LlmTool[],
  external: readonly LlmTool[],
): LlmTool[] {
  const internalNames = new Set(internal.map((x) => x.name));
  for (const x of external)
    if (internalNames.has(x.name))
      throw new Error(
        `tool "${x.name}" is both an internal MCP tool (exposed name) and a ` +
          `client-provided external tool — rename the external tool.`,
      );
  return [...internal, ...external];
}
```

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Re-export** `mergeOfferedTools` from `index.ts`.

- [ ] **Step 6: Build + lint, commit**

```bash
git add packages/llm-agent/src/interfaces/merge-offered-tools.ts packages/llm-agent/src/interfaces/merge-offered-tools.test.ts packages/llm-agent/src/index.ts
git commit -m "feat(agent): mergeOfferedTools — internal/external name-collision fail-fast (#244)"
```

---

### Task 4: `name?` config field (all layers) + `clientDescriptors?` on `McpConnectionResult`

**Files:**
- Modify: `packages/llm-agent/src/interfaces/mcp-connection-strategy.ts` (`McpConnectionConfig.name?`, `McpConnectionResult.clientDescriptors?`)
- Modify: `packages/llm-agent-mcp/src/client.ts` (`MCPClientConfig.name?`, ~line 60)
- Modify: `packages/llm-agent-libs/src/builder-types.ts` (`BuilderMcpConfig.name?`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`SmartServerMcpConfig.name?`)

**Produces:** `interface McpClientDescriptor { slotIndex: number; label?: string }` and `McpConnectionResult.clientDescriptors?: readonly McpClientDescriptor[]`; `name?: string` on the four config interfaces.

- [ ] **Step 1: Add the types (compiles clean — all additive optional)**

In `mcp-connection-strategy.ts`, add above `McpConnectionResult` and extend it:

```ts
export interface McpClientDescriptor {
  /** Original configured-array position — stable across reconnect / peer outage. */
  slotIndex: number;
  /** The server's config `name`, if set. */
  label?: string;
}
export interface McpConnectionResult {
  clients: IMcpClient[];
  toolsChanged: boolean;
  /** Per-client stable identity, aligned by index with `clients`. Optional:
   *  strategies that never filter may omit it (array index === config index). */
  clientDescriptors?: readonly McpClientDescriptor[];
  /** Total configured servers (not the active count) — stabilizes the record-key
   *  form under a filtered active set. Optional; defaults to clients.length. */
  configuredSlotCount?: number;
}
```

Add `name?: string;` to `McpConnectionConfig` (same file), `MCPClientConfig` (client.ts), `BuilderMcpConfig` (builder-types.ts), `SmartServerMcpConfig` (smart-server.ts), each with a one-line doc: `/** Stable, human-readable label used as the namespace prefix for this server's colliding tools. */`.

- [ ] **Step 2: Build (clean — optional fields break nothing)**

Run: `npm run build 2>&1 | tail -3` → clean.

- [ ] **Step 3: Commit**

```bash
git add packages/llm-agent/src/interfaces/mcp-connection-strategy.ts packages/llm-agent-mcp/src/client.ts packages/llm-agent-libs/src/builder-types.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts
git commit -m "feat: add mcp[].name + McpConnectionResult.clientDescriptors types (#244)"
```

---

### Task 5: `LazyConnectionStrategy` populates `clientDescriptors`; `Periodic` forwards

**Files:**
- Modify: `packages/llm-agent-mcp/src/strategies/lazy-connection-strategy.ts` (~`:40-44` Slot, `:123-125` filter/return)
- Modify: `packages/llm-agent-mcp/src/strategies/periodic-connection-strategy.ts` (~`:67-71` return)
- Test: `packages/llm-agent-mcp/src/strategies/__tests__/lazy-connection-strategy.test.ts` (append, or create if none — verify path first)

**Consumes:** `McpClientDescriptor` (Task 4). **Produces:** a `McpConnectionResult` with (a) `clientDescriptors[i]` = `{ slotIndex: <config index of clients[i]>, label: <slot config.name> }`, (b) `configuredSlotCount` = total configured slots, and (c) a **bidirectional** `toolsChanged` (fires on a slot gained OR lost).

- [ ] **Step 1: Write the failing tests**

Model on the existing lazy-connection-strategy test harness (read it first for the exact `Slot`/config stub shape). Assert:
1. **Descriptors + stable slotIndex:** 3 configured servers, slot 1 unhealthy → `resolve()` returns 2 clients, `clientDescriptors = [{slotIndex:0,label:cfg0.name},{slotIndex:2,label:cfg2.name}]` (original config indices 0 and 2, NOT 0/1), and `configuredSlotCount === 3`.
2. **`toolsChanged` on gain / loss / same-slot reconnect:** from two healthy slots — (a) one goes unhealthy → `toolsChanged === true` (a DROP); (b) it returns healthy → `true`; (c) a slot whose client is found unhealthy then RECONNECTS with a new client (different tools) in the SAME resolve → `true` even though the healthy-slot-index set is unchanged; (d) no client change → `false`.

- [ ] **Step 2: Run RED** — `clientDescriptors`/`configuredSlotCount` undefined; `toolsChanged` stays `false` on a drop (current `anyNewlyHealthy` only) and on a same-slot reconnect (set-diff misses it).

- [ ] **Step 3: Implement**

The `Slot` is built 1:1 with configs, so its index in `this._slots` IS the config index. At the return (`:123-127`):

```ts
const surviving = this._slots
  .map((s, slotIndex) => ({ s, slotIndex }))
  .filter(({ s }) => s.healthy && s.client !== undefined);
const clients = surviving.map(({ s }) => s.client as IMcpClient);
const clientDescriptors = surviving.map(({ s, slotIndex }) => ({
  slotIndex,
  ...(s.config?.name ? { label: s.config.name } : {}),
}));
const configuredSlotCount = this._slots.length;

// Change detection over (slotIndex → client generation). A NEW client for a slot
// bumps its generation, so gain, loss, AND same-slot reconnect (client replaced,
// possibly different tools) all change the signature — a set-only diff would miss
// the reconnect.
const sig = surviving.map(({ s, slotIndex }) => `${slotIndex}:${s.generation ?? 0}`).join(',');
const changed = sig !== (this._prevSig ?? '<init>');
this._prevSig = sig;
const toolsChanged = changed && !this._skipRevectorize;
// return { clients, toolsChanged, clientDescriptors, configuredSlotCount }
```

Add `private _prevSig?: string;` and a `generation: number` field on `Slot` (init 0),
incremented at EVERY site that assigns a new client to a slot (the connect AND the
reconnect branches — grep the file for `slot.client =` / `.client =`). Adjust
`s.config?.name` to the exact `Slot` config field. `PeriodicConnectionStrategy` forwards
`clientDescriptors` + `configuredSlotCount` (it already forwards `clients`/`toolsChanged`).
This replaces the old `anyNewlyHealthy`-only signal (a new client bumps generation → the
signature changes, so gains are still covered).

- [ ] **Step 4: Run GREEN.**

- [ ] **Step 5: Full mcp suite + build + lint, commit**

```bash
npm run build && npm run lint:check
npm test --workspace @mcp-abap-adt/llm-agent-mcp 2>&1 | grep -E "^ℹ (tests|pass|fail)"
git add packages/llm-agent-mcp/src/strategies/
git commit -m "feat(mcp): LazyConnectionStrategy emits stable clientDescriptors (slotIndex+label) (#244)"
```

---

### Task 6: `McpToolRegistry.resolve()` uses `buildNamespacedTools` + stores `activeClientDescriptors`

**Files:**
- Modify: `packages/llm-agent-libs/src/mcp/tool-registry.ts` (`:26` field, `:50-56` resolveActiveClients, `:83-104` resolve)
- Test: `packages/llm-agent-libs/src/mcp/tool-registry.test.ts` (create or append — verify)

**Consumes:** `buildNamespacedTools`, `McpClientDescriptor`. **Produces:** `resolve()` returns namespaced `tools` + a `toolClientMap` whose renamed values are bound wrappers; a single-server registry is unchanged.

- [ ] **Step 1: Write the failing test** — two embedded/fake clients both exposing `Search`, resolve() → `tools` has `s0__Search` + `s1__Search` (or labels if provided), `toolClientMap.get('s1__Search').callTool('s1__Search', …)` reaches client 1 with `Search`; a single-client registry → bare `Search`, value === real client.

- [ ] **Step 2: Run RED** (current resolve dedupes by name → only one `Search`).

- [ ] **Step 3: Implement**

- Add field `private activeClientDescriptors: readonly McpClientDescriptor[] = [];`.
- In `resolveActiveClients` (`:50-56`), after `this.activeClients = result.clients;` add
  `this.activeClientDescriptors = result.clientDescriptors ?? this.activeClients.map((_, i) => ({ slotIndex: i }));`
  (fallback: array index when the strategy omits descriptors).
- Rewrite `resolve()` (`:83-104`): after `await this.resolveActiveClients(opts)`, fan out `listTools` per active client (as today), then:

```ts
    const perClient = settled.flatMap((e, i) =>
      e.status === 'fulfilled' && e.value.result.ok
        ? [{
            slotIndex: this.activeClientDescriptors[i]?.slotIndex ?? i,
            label: this.activeClientDescriptors[i]?.label,
            client: e.value.client,
            tools: e.value.result.value,
          }]
        : [],
    );
    const { tools, toolClientMap } = buildNamespacedTools(perClient, this.toolNamespace);
    return { tools, toolClientMap };
```

> `settled` currently maps over `this.activeClients`; ensure the index `i` aligns with `activeClientDescriptors` (same order — both derive from `resolveActiveClients`). Add a constructor-injected `private toolNamespace: IToolNamespace = defaultToolNamespace` (Task 10 wires the builder's override; default here keeps existing callers working).

- [ ] **Step 4: Run GREEN + full libs suite (baseline-diff any pre-existing failure vs main).**

- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src/mcp/tool-registry.ts packages/llm-agent-libs/src/mcp/tool-registry.test.ts
git commit -m "feat(agent): registry resolve() namespaces colliding tools + keeps descriptors (#244)"
```

---

### Task 7: `PipelineContext.mcpClientDescriptors` + `tool-select` / `tool-loop` refresh use the builder

**Files:**
- Modify: `packages/llm-agent-libs/src/pipeline/context.ts` (`:128` area — add field)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-select.ts` (`:43-52`)
- Modify: `packages/llm-agent-libs/src/pipeline/handlers/tool-loop.ts` (`:203-221`)
- Modify: the pipeline setup that populates `ctx.mcpClients` (grep `mcpClients:` assignment; likely `default-pipeline.ts`) to also set `mcpClientDescriptors` from the connection result.
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-stream.test.ts` (append) or the tool-select test.

**Consumes:** `buildNamespacedTools`, `McpClientDescriptor`. **Produces:** both refresh paths namespace collisions using the stable descriptors; the second colliding tool is never dropped on refresh.

- [ ] **Step 1: Write the failing test** — a `makeCtx` with two `mcpClients` both exposing `Search` and `mcpClientDescriptors [{slotIndex:0},{slotIndex:1}]`; run the `tool-select` first-load (and separately the `tool-loop` refresh) → `ctx.mcpTools` has both `s0__Search`/`s1__Search`, `ctx.toolClientMap` has both; a dropped-slot descriptor `[{slotIndex:0},{slotIndex:2}]` yields `s0`/`s2` prefixes (not `s0`/`s1`).

- [ ] **Step 2: Run RED** (current loops dedupe by bare name).

- [ ] **Step 3: Implement**

- `context.ts`: add `mcpClientDescriptors?: readonly McpClientDescriptor[];` beside `mcpClients`.
- `tool-select.ts:43-52`: replace the `for (const t …) if (!has) { push; set }` loop with: collect `perClient = [{ slotIndex, label, client, tools }]` from the settled `listTools` results zipped with `ctx.mcpClientDescriptors` (fallback `{slotIndex:i}`), then `const { tools, toolClientMap } = buildNamespacedTools(perClient, ctx.toolNamespace ?? defaultToolNamespace)`; push `tools` into `ctx.mcpTools` and copy entries into `ctx.toolClientMap`.
- `tool-loop.ts:203-221`: same, after `ctx.toolClientMap.clear()`.
- Populate `ctx.mcpClientDescriptors` where `ctx.mcpClients` is set (grep to find it).

> If `ctx.toolNamespace` is not a context field, thread it from the agent/builder in Task 10; for now default to `defaultToolNamespace` and leave a `// TODO(Task 10): use ctx.toolNamespace`.

- [ ] **Step 4: Run GREEN + full libs suite.**

- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src/pipeline/
git commit -m "feat(agent): tool-select/tool-loop refresh namespace via shared builder + descriptors (#244)"
```

---

### Task 8: `vectorizeMcpTools` stores the exposed name (same builder + descriptors)

**Files:**
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (signature + the tool list it stores; `:227` `metadata: { name }`)
- Modify: its caller(s) (grep `vectorizeMcpTools(`) to pass `descriptors`.
- Test: `packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts` (append)

**Produces:** each stored `metadata.name` is the exposed name; the record **id** uses the STABLE `slotIndex` + `configuredSlotCount` (not the runtime active index/count), so ids don't re-map or flip to bare when a peer drops.

- [ ] **Step 1: Write the failing test** — vectorize over two clients both exposing `Search` (+ descriptors `[{slotIndex:0},{slotIndex:1}]`, `configuredSlotCount:2`) → the two records carry `metadata.name` `s0__Search`/`s1__Search` AND record ids `tool:0:Search`/`tool:1:Search`. Then vectorize with only the slot-2 client active (`descriptors [{slotIndex:2}]`, `configuredSlotCount:2`) → `metadata.name` bare `Search` (no collision) BUT record id stays `tool:2:Search` (stable slotIndex, configured count keeps the multi-server form — NOT `tool:0:Search` nor bare `tool:Search`). Assert record IDs, not only names.

- [ ] **Step 2: Run RED** (current code passes runtime `clientIndex`/`clientCount = clients.length` → wrong ids under filtering).

- [ ] **Step 3: Implement** — add `descriptors?: readonly McpClientDescriptor[]` and `configuredSlotCount?: number` parameters. (a) run the per-client tool lists through `buildNamespacedTools(perClient, ns)` and use the returned `tools` (exposed names) for `text`/`metadata.name`; (b) build the `ToolKeyContext` with the STABLE values — replace `clientIndex` (the loop position, `:134`) with `descriptors[i]?.slotIndex ?? i`, and `clientCount = clients.length` (`:132`) with `configuredSlotCount ?? clients.length`. Pass both new params from the caller (sourced from the connection result).

- [ ] **Step 4: Run GREEN + full libs suite.**

- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts packages/llm-agent-libs/src/__tests__/vectorize-mcp-tools.test.ts
git commit -m "feat(agent): vectorizeMcpTools stores exposed (namespaced) tool names (#244)"
```

---

### Task 9: `mergeOfferedTools` at all internal+external concat sites

**Files:**
- Modify (replace `[...internal, ...external]` with `mergeOfferedTools(internal, external)`):
  `tool-select.ts:119`, `tool-loop.ts:222` & `:339`, `agent.ts:873` & `:981`,
  `agent/rag-orchestrator.ts:236`, and the subagent / cyclic-react executor merge
  (`smart-agent-subagent.ts`, `cyclic-react-executor.ts:210-212`).
- Test: `packages/llm-agent-libs/src/pipeline/handlers/__tests__/tool-loop-external.test.ts` (append)

**Consumes:** `mergeOfferedTools` (Task 3). **Produces:** an internal↔external name collision fail-fasts at the merge, on every path.

- [ ] **Step 1: Write the failing test** — drive a tool-loop with an external tool named the same as an internal MCP tool (bare) AND, separately, the same as a generated `s0__Search` → the run throws the `mergeOfferedTools` diagnostic. (Model external-tool wiring on `tool-loop-external.test.ts`.)

- [ ] **Step 2: Run RED** (current concat silently double-classifies).

- [ ] **Step 3: Implement** — at each site, `import { mergeOfferedTools } from '@mcp-abap-adt/llm-agent'` and replace the spread concat. Preserve internal-first order (mergeOfferedTools keeps it).

- [ ] **Step 4: Run GREEN + full libs suite (existing external-tool tests with DISJOINT names stay green).**

- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src
git commit -m "feat(agent): fail-fast on internal/external tool-name collision at all merge sites (#244)"
```

---

### Task 10: `SmartAgentBuilder.withToolNamespace` + wire the strategy through; server config parse

**Files:**
- Modify: `packages/llm-agent-libs/src/builder.ts` (mirror `withToolRecordKey` at `:186/:479/:984/:1213`); thread `IToolNamespace` into the registry + pipeline (`ctx.toolNamespace`) + vectorize.
- Modify: `packages/llm-agent-server-libs/src/smart-agent/resolve-config-sections.ts` (or the mcp-config parse) — read `mcp[].name`, validate charset `^[a-zA-Z0-9_-]+$` + uniqueness among servers, thread into the connection config.
- Test: `packages/llm-agent-libs/src/__tests__/` builder test (append) + a server-libs config-parse test.

**Produces:** a consumer can swap the namespace strategy; a labeled multi-server config yields `label__tool`; an invalid/duplicate label is rejected at parse.

- [ ] **Step 1: Write the failing tests** — (a) builder: `withToolNamespace(custom)` reaches the registry (a custom strategy that uppercases the prefix changes the exposed name in a resolve()); (b) server-libs: `mcp: [{name: 'a b'}]` (space) and two servers both `name: 'x'` each throw a clear config error; a valid `mcp[].name` threads to the connection config.

- [ ] **Step 2: Run RED.**

- [ ] **Step 3: Implement** — add `_toolNamespace?: IToolNamespace`, `withToolNamespace(s): this`, and pass it to `McpToolRegistry` (constructor arg) + into `PipelineContext.toolNamespace` + `vectorizeMcpTools`. In server-libs, parse/validate `mcp[].name` and set it on the connection config. Default everywhere = `defaultToolNamespace`.

- [ ] **Step 4: Run GREEN + both suites.**

- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src/builder.ts packages/llm-agent-server-libs/src/smart-agent/
git commit -m "feat: withToolNamespace + mcp[].name parse/validation, threaded end-to-end (#244)"
```

---

### Task 11: End-to-end acceptance test + docs + cleanup

**Files:**
- Test: `packages/llm-agent-libs/src/__tests__/tool-namespacing-e2e.test.ts` (create)
- Modify: `CHANGELOG.md`, `docs/TROUBLESHOOTING.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`
- Delete: the spec and this plan (controller/finish may defer — follow the executing skill's convention).

- [ ] **Step 1: End-to-end test (the issue's acceptance)** — two embedded MCP servers (use the `embedded` transport / in-memory test doubles) each exposing a `Search` with DISTINCT behaviour; vectorize + resolve; a RAG hit / selection for **server 1's** `Search` drives a tool call that reaches **client 1** (assert client 1's `callTool` received `Search` and client 0's was NOT called). Also assert the executor path via `mixed-tool-call-handler` and the coordinator `buildCallTool` both send the original name (three spies).

- [ ] **Step 2: Run it → PASS.**

- [ ] **Step 3: Docs** — CHANGELOG (`### Added`/`### Fixed` under the held v20.9.0): colliding MCP tools individually callable via namespaced names; `mcp[].name` for durable prefixes; `IToolNamespace` swappable; internal↔external collision fail-fast. TROUBLESHOOTING: symptom (two servers, only one `Search` reachable) → fix. ARCHITECTURE/INTEGRATION: the strategy + config + UX note (model sees namespaced names only on collision).

- [ ] **Step 4: Verify claims** — `grep -n "buildNamespacedTools\|mergeOfferedTools\|withToolNamespace" packages/*/src -r | grep -v dist | grep -v test`.

- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-libs/src/__tests__/tool-namespacing-e2e.test.ts CHANGELOG.md docs/
git commit -m "test+docs: #244 e2e colliding-tool routing + documentation (#244)"
```

---

## Final Verification

- [ ] `npm run build` — clean.
- [ ] `npm run lint:check` — no NEW errors (baseline vs main).
- [ ] `npm test --workspace @mcp-abap-adt/llm-agent`, `…-mcp`, `…-libs`, `…-server-libs` — `fail 0` (baseline-diff any pre-existing).
- [ ] Manual/live (maintainer): two real MCP servers with a same-named tool → the model can call each; a labeled config yields readable `label__tool` names.
- [ ] External code review; merge only on the maintainer's explicit word. Folds into the held v20.9.0.
