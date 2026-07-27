# #244 Addendum — Server-libs seams must be namespace-aware

**Status:** design, pending review (review round 2 — revised after the per-session-isolation
and two-snapshot findings). Extends the approved spec `2026-07-26-tool-namespacing-design.md`
(do not restate it — this only covers the `llm-agent-server-libs` gap the original spec's
call-site inventory omitted).

**Goal:** the colliding-tool namespacing #244 delivers in `llm-agent-libs` must also work on
every `llm-agent-server-libs` pipeline — because SmartServer *is* the example — **without
weakening the per-session MCP isolation (#213/#226) those pipelines rely on.**

## 1. The gap (why the original spec was incomplete)

The original spec enumerated the four `toolClientMap` build paths + `coordinator.ts` and
encapsulated the name-strip in the `toolClientMap` value (`bindToolCallName`). But several
server routes do **not** go through that `toolClientMap`. Two are bare-name seams:

- **`buildMcpBridge`** (`smart-server.ts:614-659`): `owns = listed.value.some(t => t.name === name)`
  then `client.callTool(name, …)`. The LLM calls `s0__Search`; `listTools()` reports bare
  `Search` (`bindToolCallName` passes `listTools()` through unchanged, `tool-namespace.ts:35`)
  → no client owns it → `Tool not found: s0__Search`.
- **`makeToolsRagHandle`** (`tools-rag-handle.ts:19-88`): catalog keyed by **bare** `t.name`,
  deduped; `query()` maps the RAG record's now-**namespaced** name → `catalog.get('s0__Search')`
  → miss → the colliding hit is dropped.

Because the builder vectorizes **namespaced** `metadata.name` into the shared `toolsRag`
(`builder.ts:1000-1013`) while `_sharedMcpClients` + both seams speak **bare**, selection and
routing disagree. **Strict regression:** pre-#244 the first server's `Search` was selectable
*and* callable; post-#244 neither colliding tool is, on the server pipelines that use these
seams.

**Which pipelines are affected (verified, `smart-server.ts` / `pipelines/*`):**
- `flat` / `dag` route MCP through the **per-session agent's own internal `McpToolRegistry`**
  (already namespaced by the libs work, over session-local clients) — **not affected, no
  change needed.**
- `controller` builds its **own** `buildMcpBridge(ctx.mcpClients, …)` (`controller.ts:161`)
  over **session-local** `ctx.mcpClients`, and selects via `ctx.toolsRag` (the shared
  `_toolsRagHandle`) — **affected** (routing + selection).
- `linear` / `stepper` route via `ctx.callMcp` → `SmartServer.callMcp` over the **global**
  `_sharedMcpClients` (`smart-server.ts:1899-1909`) — **affected** (routing); they select via
  the shared `_toolsRagHandle` — **affected** (selection).

## 2. The two isolation scopes (the crux the first draft got wrong)

`buildServerCtx` is **per-session** (called from `buildPipelineInstance` per session, and once
for the `'embedded'` pseudo-session). It sets `mcpClients: scope.parts.mcpClients`
(`smart-server.ts:2152`) — under #213 YAML isolation, a **fresh per-session client array**
(`buildSessionMcpClients(cfg.mcp)`), distinct in object identity from the global
`_sharedMcpClients`. But `SmartServer.callMcp` closes over the **global** `_sharedMcpClients`.

So there are two client targets today, and each affected seam has its own:
- the **controller** targets **session-local** `ctx.mcpClients`;
- **`callMcp`** (linear/stepper) targets **global** `_sharedMcpClients`.

**A single global `toolClientMap` threaded into every ctx would drag the controller off its
session-local clients onto the global startup clients — silently bypassing #213 isolation.**
Therefore the routing map is **not** global: **each seam builds its namespaced routing map
over the client list it already targets**, preserving that seam's existing isolation scope. We
change *bare-name matching → namespaced-map routing*, and change **nothing** about which
clients a seam targets.

## 3. Design

Two independent artifacts, on purpose:

### 3a. Selection — a GLOBAL exposed-name catalog (fixes `makeToolsRagHandle`)

The tools-RAG handle's catalog must be keyed by the **exposed** name so a namespaced RAG
record maps back. Names are config-stable (a tool's exposed name depends on its config
`slotIndex` + `label` + collision status + `toolNamespace`, not on a client *instance*), so
this catalog is legitimately **global** — the reviewer's own guidance ("exposed catalog може
бути глобальним").

**Consistency with the RAG store (fixes the two-snapshot divergence):** the catalog must use
the *same* exposed names the builder wrote into `toolsRag`. Rather than have the server do a
SECOND `listTools()` pass (which could see a different tool set / availability than the
builder's vectorize pass — the divergence the reviewer flagged), **surface the builder's
namespaced snapshot** from `build()`:

- Extend `SmartAgentHandle<T>` (`packages/llm-agent/src/interfaces/builder.ts:56`) additively
  with `namespacedTools?: readonly LlmTool[]` (exposed-named tool schemas) and
  `toolProvenance?: ReadonlyMap<string, { slotIndex: number; originalName: string }>` — the
  exact `tools`/`provenance` the builder's `vectorizeMcpTools`→`buildNamespacedTools` already
  computed at vectorize time. (`vectorizeMcpTools` currently returns only a
  `ToolVectorizationSummary`; it must also return, or the builder must capture, the `tools` +
  `provenance` from its internal `buildNamespacedTools` call — an additive return/capture, no
  behavior change.)
- On the yaml-builder path the handle's `namespacedTools` **is** the catalog (same snapshot as
  the RAG → consistent by construction, no second `listTools`).
- On the **seam path** there is **no** `vectorizeMcpTools` and **no** RAG store
  (`buildSharedPipelineInfra` only builds the flat catalog; `toolsRag.query` falls back to the
  catalog slice) — so the catalog is the sole source and cannot diverge from a RAG. There the
  catalog is built from ONE `listTools()` pass over the seam clients via `buildNamespacedTools`
  with config-derived descriptors (§3c). No two-snapshot problem exists on this path.

`makeToolsRagHandle` gains an optional pre-built `{ namespacedTools, provenance }` input; when
present it keys the catalog by exposed name from it; when absent it keeps today's bare
behavior (back-compat).

### 3b. Routing — a PER-SEAM namespaced map (fixes both bridges), isolation-preserving

Replace each bare `buildMcpBridge` with a namespaced-map lookup, built over **that seam's own
clients**:

- **Controller** (`controller.ts:161`): consume a **per-session** routing map. Add
  `IPipelineContext.toolClientMap?: Map<string, IMcpClient>`
  (`packages/llm-agent/src/interfaces/pipeline-plugin.ts`), additive, beside `mcpClients`.
  `buildServerCtx` (`smart-server.ts:2149-2152`) builds it from **`scope.parts.mcpClients`**
  (session-local) via `buildNamespacedTools` with config descriptors (§3c) + the server
  `toolNamespace`, and populates `ctx.toolClientMap`. The controller routes via
  `ctx.toolClientMap.get(name)` instead of building its own bare bridge → session isolation
  preserved (it was already session-local; we only fix the name matching).
- **`SmartServer.callMcp`** (linear/stepper): build its namespaced map over its existing
  **global** `_sharedMcpClients` target and route via `map.get(name)`. Its client target is
  unchanged (global, exactly as today) — we only fix bare→namespaced. (`callMcp` deliberately
  does **not** adopt the session map; changing its target would be an unrelated isolation
  change out of scope here.)

The map value is the `bindToolCallName` wrapper (or the real client when the name is unique),
so `.callTool(exposedName, …)` reaches the right server with the **original** name — the same
`toolClientMap` mechanism the libs paths use. No bespoke server namespacing logic
(Architecture Principles 1 & 2).

### 3c. Descriptors — where each path gets `{ slotIndex, label }` (Fork 2: full fix)

Exposed names + record keys need stable `slotIndex` (config index) + `label`
(`cfg.mcp[].name`). Sources:

- **Yaml-builder path (global catalog + callMcp map):** the builder already has descriptors
  from `IMcpConnectionStrategy.resolve()`. Extend `SmartAgentHandle` additively with
  `mcpClientDescriptors?: readonly McpClientDescriptor[]` and `configuredSlotCount?: number`,
  populated in `builder.ts`'s `return { … }` (`:1289`) — hoist the `resolved` local (scoped in
  the connect `else`, `:975-1017`) to function scope. On the caller-provided-`mcpClients`
  branch `resolved` is undefined, so `configuredSlotCount` is legitimately absent (consumer
  falls back to `clients.length`). The server pairs these with `_sharedMcpClients` for its
  `callMcp` map.
- **Session-local + seam path (per-session map + seam catalog):** `buildSessionMcpClients`
  (`build-session-mcp-clients.ts`) and the default `connectMcpClientsFromConfig`
  (`smart-server.ts:583`) both build clients from `cfg.mcp` in config order via a hand-rolled
  loop and today ignore `cfg.mcp[].name`. Per the full-fix scope, have each **return
  descriptors alongside the clients** (`slotIndex = config index`, `label = cfg.mcp[i].name`,
  `configuredSlotCount = cfg.mcp.length`) — an `McpConnectionResult`-shaped result. Custom
  consumer connectors: the existing `BuildAgentDeps.connectMcp: () => Promise<IMcpClient[]>`
  seam stays **unchanged** (non-breaking); add an optional parallel
  `connectMcpWithDescriptors?: () => Promise<McpConnectionResult>`. Resolution:
  `connectMcpWithDescriptors` if provided → else `connectMcp` with an **array-index fallback**
  (`{slotIndex:i}`, no label). So a bare custom connector still gets callable colliding tools
  (slot prefixes); the default/config path gets labels.

### 3d. The `toolNamespace` source

Nothing calls `.withToolNamespace(...)` in the server today. Add an optional DI knob
`BuildAgentDeps.toolNamespace?: IToolNamespace` (default `defaultToolNamespace`): the server
(a) passes it to the builder via `.withToolNamespace(ns)` in `buildBaseBuilder`
(`smart-server.ts:2206-2226`) so the yaml catalog uses it, and (b) uses the same instance when
building the per-seam maps. A YAML strategy-name knob is **out of scope** — `mcp[].name`
labels cover the config need; a custom `IToolNamespace` is a DI concern (like
`IToolRecordKey`/`IMcpFailureClassifier`).

## 4. Fallback + partial-failure algorithm (P2 — make it explicit)

There is exactly **one eager build** per artifact (the catalog at handle-build, each routing
map at its seam-build), no lazy-vs-eager ambiguity:

1. Build `perClient` = one `listTools()` per client (skip a client whose `listTools()` FAILS —
   consistent with today's `vectorizeMcpTools`/`makeToolsRagHandle`, neither aborts the whole
   build; **adopt `vectorizeMcpTools`'s `clientFailures` logging**, not `makeToolsRagHandle`'s
   silent drop, so a dropped client is observable). A client that fails to list is simply
   absent from that build — its tools are unroutable/unselectable until the next rebuild, same
   as today.
2. `const { tools, toolClientMap } = buildNamespacedTools(perClient, toolNamespace)`.
3. **Routing:** always route via `toolClientMap.get(name)`. When no collision occurred every
   exposed name is bare and its map value is the **real client**, so this is behaviourally
   identical to the old scan for the common single-name case — no separate "lazy vs snapshot"
   branch is needed. The old lazy `listTools()`-scan bridge is retained **only** as the
   fallback when a host provides **no** `toolClientMap`/namespaced view at all (e.g. a pipeline
   or embedding context that never built one) — see §5.
4. **Catalog:** keyed by exposed `tools[i].name`; `lookup`/`query` resolve exposed→schema. A
   RAG record whose exposed name is absent from the catalog (e.g. a rare boot-vs-now
   availability flip) is skipped, exactly as an unknown record is skipped today — graceful
   degradation, never a crash. (A stricter per-session re-vectorize to eliminate that flip
   window is a noted follow-up, §7, not required here.)

## 5. Backward-compat guarantees

- No descriptors + no `toolNamespace` + no collision → bare names, real-client map values,
  and (where no map is supplied) the `listTools()`-scan bridge fallback: **byte-for-byte
  today's behavior**.
- A single configured server never collides → all names bare (unchanged).
- **Per-session isolation (#213/#226) is preserved:** the controller keeps routing to
  `scope.parts.mcpClients`; `callMcp` keeps routing to `_sharedMcpClients`. No seam's client
  target changes.
- `SmartAgentHandle`, `IPipelineContext`, `IToolsRagHandle`, `BuildAgentDeps` change **only
  additively** (new optional fields / one new optional parallel seam). The `connectMcp`
  signature and the `Map<string, IMcpClient>` `toolClientMap` value type are untouched.

## 6. Testing strategy (the plan TDDs each)

- **Per-session isolation (the headline risk):** two sessions on the YAML-isolated path, each
  with its own client instances; a namespaced call in session A reaches session A's client
  instance, NOT the global `_sharedMcpClients` nor session B's — asserted by distinct spies
  per session. This is the test that would have caught the first-draft regression.
- **Server e2e per pipeline:** two embedded MCP servers each exposing `Search`, driven through
  the **controller** (session-local map) AND **linear/stepper** (global `callMcp` map) — a RAG
  hit for server-1's `Search` selects `s0__Search`/label and routes to client 1 with the
  **original** `Search`; client 0 not called.
- **Catalog↔RAG consistency:** a namespaced RAG record maps back to the (builder-surfaced)
  catalog (no miss); single-server catalog bare/unchanged.
- **`mcp[].name` labels on both producer paths:** yaml-builder and the default
  session/seam connector each yield `label__Search`; a bare custom `connectMcp` yields
  `s0__Search` (fallback) and is still callable.
- **Partial `listTools()` failure:** one server failing to list drops only its tools (logged),
  the other remains selectable + callable.
- **Regression floor:** pre-existing disjoint-name server tests stay green.

## 7. Out of scope (follow-ups)

- A YAML `toolNamespace:` strategy-name knob (custom strategy via config string).
- Any change to the bare `connectMcp` seam signature (labels for bare custom connectors come
  via the optional `connectMcpWithDescriptors` seam).
- Per-session re-vectorization of the shared `toolsRag` to close the boot-vs-now
  availability-flip window (the frozen-snapshot catalog degrades gracefully without it).

## 8. Architecture-principles check

1. **Build ON components:** reuses `buildNamespacedTools`/`bindToolCallName`; no bespoke
   server-side namespacing. ✓
2. **App is the example:** SmartServer actually demonstrates the feature, on every pipeline. ✓
3. **Interfaces:** consumers still depend on `IToolsRagHandle`/`IPipelineContext`. ✓
4. **ISP:** new focused optional fields + one parallel seam; nothing widened into a god
   interface. ✓
5. **Strategies:** `IToolNamespace` reaches the server via DI, swappable. ✓
6/7. **File size / additive:** no god-file growth; all changes additive/backward-compatible;
   **and it does not regress #213 isolation.** ✓
