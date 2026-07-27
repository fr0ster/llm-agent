# #244 Addendum — Server-libs seams must be namespace-aware

**Status:** design, pending review. Extends the approved spec
`2026-07-26-tool-namespacing-design.md` (do not restate it — this only covers the
`llm-agent-server-libs` gap the original spec's call-site inventory omitted).

**Goal:** the colliding-tool namespacing #244 delivers in `llm-agent-libs` must also
work on every `llm-agent-server-libs` pipeline (flat / linear / dag / stepper /
controller) — because SmartServer *is* the example. Today it regresses there.

## 1. The gap (why the original spec was incomplete)

The original spec enumerated the four `toolClientMap` build paths + `coordinator.ts` and
encapsulated the name-strip in the `toolClientMap` value (`bindToolCallName`). But the
server pipelines do **not** route through `toolClientMap`. They use two bare-name seams:

- **`buildMcpBridge`** (`smart-server.ts:614-659`): finds the owning client with
  `owns = listed.value.some(t => t.name === name)` then `client.callTool(name, …)`.
  The LLM calls `s0__Search`; every client's `listTools()` reports bare `Search`
  (`bindToolCallName` passes `listTools()` through unchanged, `tool-namespace.ts:35`) →
  no client "owns" it → `Tool not found: s0__Search`.
- **`makeToolsRagHandle`** (`tools-rag-handle.ts:19-88`): catalog keyed by **bare**
  `t.name`, deduped first-seen; `query()` maps the RAG record's now-**namespaced** name
  (`toolNameFromRecord(record.metadata)` = `s0__Search`) → `catalog.get('s0__Search')` →
  miss → the colliding hit is dropped (or an arbitrary bare slice is returned).

Because the shared builder now vectorizes **namespaced** `metadata.name` into `toolsRag`
(`builder.ts:1000-1013`) while `_sharedMcpClients` + both seams speak **bare**, the RAG
catalog and the routing disagree. **This is a strict regression**: pre-#244 the first
server's `Search` was selectable *and* callable; post-#244 neither colliding tool is, on
every server pipeline.

## 2. Design — one namespaced view, consumed by both seams

Build the **same** namespaced view the libs paths use — once, at infra-build time — over
`_sharedMcpClients`, and route both server seams through it:

```
perClient = clients.map((client, i) => ({
  slotIndex: descriptors[i]?.slotIndex ?? i,
  label:     descriptors[i]?.label,
  client,
  tools:     <await client.listTools()>,   // eager, once
}))
const { tools, toolClientMap } = buildNamespacedTools(perClient, toolNamespace)
```

- `tools` (exposed names, `s0__Search` on collision, bare when unique) → the tools-RAG
  handle **catalog is keyed by exposed name**, so `toolNameFromRecord(record.metadata)`
  (namespaced) maps back. `lookup(name)` and `query()` both use this map.
- `toolClientMap` → **routing is a `toolClientMap.get(name)` lookup**, not a `listTools()`
  rescan. The value is the `bindToolCallName` wrapper (or the real client when unique), so
  `.callTool(exposedName, …)` reaches the right server with the **original** name for free.
  This is the same reuse as the registry/pipeline paths — no bespoke server logic.

`buildNamespacedTools`, `bindToolCallName`, `McpClientDescriptor`, `defaultToolNamespace`
are the existing `@mcp-abap-adt/llm-agent` exports; no new pure logic is invented — the
server merely *consumes* the library builder (Architecture Principle 1 & 2).

**Single-server / no-collision is unchanged:** `buildNamespacedTools` returns bare names
and the real client as the map value; the catalog and routing behave exactly as today.

**Live tool-list change tolerance:** `buildMcpBridge` today re-lists per call, tolerating a
mid-session tool-list change. The namespaced view is a snapshot — but so is what it sits
beside: `makeToolsRagHandle`'s `catalogCache` (`tools-rag-handle.ts:26-42`) is already a
**startup snapshot that never refreshes**, and the server's shared `_sharedMcpClients` are
never re-vectorized after boot (`smart-server.ts:1741,1799` — the shared clients are
explicitly *not* re-vectorized; the only `toolsChanged` re-vectorize lives in the
per-session **internal** registry `llm-agent-libs/mcp/tool-registry.ts:86-87`, which never
touches `_sharedMcpClients` or `_toolsRagHandle`). So the namespaced view and the catalog
are **both frozen at build time and stay mutually consistent by construction** — the only
property lost versus the lazy `buildMcpBridge` is tolerance of a mid-session tool-list
change, which the server-side RAG catalog never had anyway. A no-namespace / single-client
deployment keeps the current lazy path (see §5 fallback), so nothing regresses for the
common case. **Plan task (verify, not assume):** confirm no per-session registry
live-re-vectorizes the *shared* server `toolsRag` underneath the frozen catalog; if a live
refresh is ever genuinely wanted, it must be a *built* rebuild hook, not assumed here.

## 3. Surfacing the stable descriptors (two producer paths, one consumer)

The consumer code (§2) needs `{ clients, clientDescriptors, configuredSlotCount }` +
`toolNamespace`. The two ways `_sharedMcpClients` is produced each supply that triple
differently; both then converge on the same consumption code.

### 3a. Yaml-builder path (`_sharedMcpClients = agentHandle.mcpClients`)

The builder computes `resolved.clientDescriptors`/`configuredSlotCount` but drops them.
**Extend `SmartAgentHandle<T>`** (`packages/llm-agent/src/interfaces/builder.ts:56`) with
additive optional fields:

```ts
mcpClientDescriptors?: readonly McpClientDescriptor[];
configuredSlotCount?: number;
toolNamespace?: IToolNamespace;
```

Populate them in `builder.ts`'s `return { … }` (`:1289`). The `resolved` local is scoped
inside the connect `else` branch (`:975-1017`) and must be **hoisted to function scope** so
`configuredSlotCount` survives to the return (`mcpClientDescriptors` is already
function-scoped). Note: on the caller-provided-`mcpClients` branch `resolved` is undefined,
so `configuredSlotCount` is legitimately absent there — populate via optional chaining
(`resolved?.configuredSlotCount`) and treat its absence as "unknown slot count" (the
consumer falls back to `clients.length`). Additive, backward-compatible (Principle 7).

**Cross-package ordering:** this `SmartAgentHandle` change (in `llm-agent`) must land before
`llm-agent-server-libs` can consume the descriptors — so the interface additions are the
first plan task (order: `llm-agent` → `llm-agent-libs` → `llm-agent-server-libs`).

### 3b. DI/seam path (`connectMcpClientsFromConfig` / custom `deps.connectMcp`) — **full fix**

`connectMcpClientsFromConfig` (`smart-server.ts:583-611`) never reads `cfg.name` and returns
bare `IMcpClient[]`. Per the chosen full-fix scope, `mcp[].name` labels must work here too.

- **Default connector:** rewrite `connectMcpClientsFromConfig` to build, alongside the
  clients, `clientDescriptors[i] = { slotIndex: i, label: cfg[i].name }` and
  `configuredSlotCount = cfg.length`, returned as an `McpConnectionResult`-shaped value.
- **Custom connectors — additive, non-breaking:** the existing
  `BuildAgentDeps.connectMcp: (…) => Promise<IMcpClient[]>` seam is **kept as-is** (no
  breaking signature change). Add an optional parallel seam
  `connectMcpWithDescriptors?: (mcp) => Promise<McpConnectionResult>`. Resolution order at
  the call site: `connectMcpWithDescriptors` if provided → else `connectMcp` (bare) with an
  **array-index fallback** (`{slotIndex:i}`, no label). So a consumer who injects only the
  bare seam still gets callable colliding tools (slot-index prefixes), and can opt into
  labels via the new seam. The default path (most deployments) gets labels outright.

### 3c. The `toolNamespace` source

Today nothing calls `.withToolNamespace(...)` in the server. Add an optional DI knob
`BuildAgentDeps.toolNamespace?: IToolNamespace` (default `defaultToolNamespace`). The server
(a) passes it into the builder via `.withToolNamespace(ns)` in `buildBaseBuilder`
(`smart-server.ts:2206-2226`) so the yaml path uses it, and (b) uses the same instance when
building the namespaced view on the seam path. A YAML strategy-name knob is **out of scope**
— `mcp[].name` labels cover the config-driven need; a custom `IToolNamespace` is a
programmatic/DI concern (consistent with `IToolRecordKey`/`IMcpFailureClassifier`).

## 4. The controller's second bridge (Fork 1 — `toolClientMap` via `IPipelineContext`)

`ControllerFactory.build` (`pipelines/controller.ts:161`) builds its **own**
`buildMcpBridge(ctx.mcpClients, …)`, bypassing `SmartServer.callMcp`. Chosen resolution:

- **Add `IPipelineContext.toolClientMap?: Map<string, IMcpClient>`**
  (`packages/llm-agent/src/interfaces/pipeline-plugin.ts`), additive/optional, beside
  `mcpClients`.
- `buildServerCtx` (`smart-server.ts:2149-2151`) populates it from the server's namespaced
  view, alongside the existing `callMcp`/`mcpClients`.
- Both bridge builders route via `toolClientMap.get(name)` when present, falling back to the
  current `listTools()` scan when absent (no map = no namespacing = today's behavior, e.g. a
  host that doesn't build the view). `ControllerFactory` consumes `ctx.toolClientMap`
  instead of constructing a bare bridge from `ctx.mcpClients`.

One shared routing seam, additive, ISP-clean; the controller stops special-casing.

## 5. Fallback / backward-compat guarantees

- No descriptors + no toolNamespace + no collision → bare names, real-client map values,
  `listTools()`-scan bridge fallback: **byte-for-byte today's behavior**.
- A single configured server never collides → all names bare (unchanged).
- `IToolsRagHandle`, `IPipelineContext`, `SmartAgentHandle`, `BuildAgentDeps` all change
  **only additively** (new optional fields / a new optional parallel seam). The existing
  `connectMcp` signature is untouched. `toolClientMap` value type stays
  `Map<string, IMcpClient>`.

## 6. Testing strategy (the plan will TDD each)

- **Server e2e (the real gap):** two embedded MCP servers each exposing `Search`, driven
  through an actual SmartServer pipeline (controller AND one flat/stepper) — a RAG hit for
  server-1's `Search` selects `s0__Search`/label, `callMcp`/`ctx.toolClientMap` routes to
  client 1 with the **original** `Search`, client 0 not called. This is the assertion the
  current `llm-agent-libs` e2e could not make (it never exercises `buildMcpBridge` /
  `makeToolsRagHandle`).
- **`mcp[].name` labels on BOTH producer paths:** yaml-builder and the default
  `connectMcpClientsFromConfig` seam each yield `label__Search`; a bare custom `connectMcp`
  yields `s0__Search` (slot fallback) and is still callable.
- **Tools-RAG handle:** a namespaced RAG record maps back to a catalog entry (no miss);
  single-server catalog is bare/unchanged.
- **Regression floor:** the pre-existing disjoint-name server tests stay green.

## 7. Out of scope (follow-ups)

- A YAML `toolNamespace:` strategy-name knob (custom strategy via config string).
- Any change to the `connectMcp` **bare** seam signature (kept stable; labels for custom
  bare connectors come via the optional `connectMcpWithDescriptors` seam).

## 8. Architecture-principles check

1. **Build ON components:** reuses `buildNamespacedTools`/`bindToolCallName`; no bespoke
   server-side namespacing. ✓
2. **App is the example:** the fix makes SmartServer actually demonstrate the feature. ✓
3. **Interfaces:** consumers still depend on `IToolsRagHandle`/`IPipelineContext`. ✓
4. **ISP:** new focused optional fields + one parallel seam; nothing widened into a god
   interface. ✓
5. **Strategies:** `IToolNamespace` reaches the server via DI, swappable. ✓
6/7. **File size / additive:** no god-file growth; all changes additive/backward-compatible. ✓
