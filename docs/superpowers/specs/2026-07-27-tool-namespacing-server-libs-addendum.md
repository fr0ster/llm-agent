# #244 Addendum — Server-libs seams must be namespace-aware

**Status:** design, pending review (round 3 — revised after the collision-not-config-stable,
RAG-writability, and stale-store findings). Extends the approved spec
`2026-07-26-tool-namespacing-design.md` (do not restate it — this only covers the
`llm-agent-server-libs` gap the original spec's call-site inventory omitted).

**Goal:** the colliding-tool namespacing #244 delivers in `llm-agent-libs` must also work on
every `llm-agent-server-libs` pipeline — because SmartServer *is* the example — **without
weakening the per-session MCP isolation (#213/#226) those pipelines rely on.**

## 1. The gap (why the original spec was incomplete)

The original spec enumerated the four `toolClientMap` build paths + `coordinator.ts` and
encapsulated the name-strip in the `toolClientMap` value (`bindToolCallName`). Several server
routes do **not** go through that map. Two are bare-name seams:

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

**Affected pipelines (verified):** `flat`/`dag` route MCP through the **per-session agent's own
internal `McpToolRegistry`** (already namespaced by the libs work, over session-local clients)
— **not affected**. `controller` builds its own `buildMcpBridge(ctx.mcpClients,…)`
(`controller.ts:161`, session-local) and selects via `ctx.toolsRag` — **affected**.
`linear`/`stepper` route via `ctx.callMcp` → `SmartServer.callMcp` (global `_sharedMcpClients`)
and select via the shared handle — **affected**.

## 2. The spine — ONE authoritative namespaced snapshot; per-seam maps only *rebind* it

The crux the earlier drafts got wrong: **an exposed name is NOT purely config-derived.**
`buildNamespacedTools` sets `colliding` from the tools present in *one specific `listTools()`
snapshot* (`build-namespaced-tools.ts`), so recomputing namespacing over a *different* active
set yields *different* names. Concretely: at startup two servers answer → catalog/RAG hold
`s0__Search`/`s1__Search`; in a session server 1 is momentarily down → a per-session recompute
sees one `Search` → emits **bare** `Search` → the name selected from the catalog (`s0__Search`)
is now unroutable **even for the healthy server 0**. This is the real session-availability
break.

**Therefore exposed names + collision are computed exactly ONCE**, over a single authoritative
snapshot, and every consumer reuses that mapping verbatim:

- **Authoritative snapshot** = `{ tools: readonly LlmTool[]  // exposed-named schemas,
  provenance: ReadonlyMap<string, { slotIndex: number; originalName: string }> }` — the exact
  `tools`/`provenance` a single `buildNamespacedTools(perClient, toolNamespace)` produces over
  the configured/boot client set with config descriptors (`slotIndex` = config index, `label` =
  `cfg.mcp[].name`).
- **Selection** (global catalog) is keyed by the snapshot's exposed names.
- **Routing** (every seam) does NOT recompute namespacing. It takes the snapshot's
  `provenance` — `exposedName → { slotIndex, originalName }` — and **rebinds** each exposed
  name to *its own* client instance at that `slotIndex`:
  `map.set(exposedName, bindToolCallName(clientAtSlot[slotIndex], originalName))`. Collision
  status is inherited from the snapshot, never re-derived from the seam's own `listTools()`.

So the global catalog, the RAG records, the controller's session map, and the `callMcp` map
**all speak the identical exposed names by construction**, regardless of which servers a given
session sees. A slot whose client is down at call time fails at call time with `isError`
(tool known, server unavailable) — never a silent bare-name divergence.

## 3. Design

### 3a. The authoritative snapshot — built UNCONDITIONALLY (decoupled from RAG writability)

`vectorizeMcpTools` **returns early before any listing** when there is no writable tools store
(`vectorize-mcp-tools.ts:126`: `if (!toolsRag || !writer) return undefined;`). So the snapshot
must **not** be a by-product of vectorization — a no-RAG / read-only-RAG deployment would
otherwise get no snapshot and silently fall back to bare, losing collisions again.

- **Yaml-builder path:** the builder computes the namespaced view via `buildNamespacedTools`
  **whenever it has MCP clients**, independent of whether it then writes them to `toolsRag`
  (the RAG *write* stays gated on a writable store; the *view* does not). It surfaces the view
  on `SmartAgentHandle<T>` (`packages/llm-agent/src/interfaces/builder.ts:56`, additive) as
  `namespacedTools?: readonly LlmTool[]` + `toolProvenance?: ReadonlyMap<string,{slotIndex,originalName}>`
  + `mcpClientDescriptors?` + `configuredSlotCount?`. When it also vectorizes, it does so from
  the **same** view → catalog and RAG are the same snapshot by construction (no second
  `listTools`). (`vectorizeMcpTools` today returns only a `ToolVectorizationSummary`; the
  builder captures the `tools`/`provenance` from its `buildNamespacedTools` call — additive.)
- **Server-side fallback (defensive + seam path):** when the handle carries no
  `toolProvenance` (a consumer builder, or the seam path where no builder runs), the server
  performs **one** `buildNamespacedTools` pass over `_sharedMcpClients` with config descriptors
  (§3c) to produce the same authoritative snapshot. This is the single server-side build the
  P2 finding asked for — never a per-seam re-list.

### 3b. Selection — global catalog keyed by exposed names (fixes `makeToolsRagHandle`)

`makeToolsRagHandle` gains an optional pre-built `{ namespacedTools, provenance }` input; when
present it keys the catalog by exposed name from the authoritative snapshot; when absent it
keeps today's bare behavior (back-compat).

**Stale / foreign RAG records (P2):** the seam path *does* pass the configured `toolsRag` into
the handle (`smart-server.ts:1955` → `buildToolsRagHandle` → `makeToolsRagHandle`), and a
**persistent** store may hold records from a prior run (possibly namespaced, possibly under a
now-absent server). `query()` still reads them. Rule: **a RAG record whose exposed name is not
in the current authoritative catalog is skipped** (exactly as an unknown record is skipped
today, `tools-rag-handle.ts:55-58`) — a stale/foreign namespaced record never routes and never
crashes; ranking proceeds over the records that *do* map. This must be explicitly tested (a
persisted namespaced record with no matching catalog entry → skipped, not surfaced, not
called).

### 3c. Routing — per-seam rebinding, isolation-preserving

Replace each bare `buildMcpBridge` with a `toolClientMap.get(name)` lookup whose map is the
snapshot's `provenance` **rebound to that seam's own clients** (§2). Each seam keeps the client
target it has today — **no seam changes which clients it targets**, so #213 isolation is
untouched:

- **Controller** (session-local): add `IPipelineContext.toolClientMap?: Map<string, IMcpClient>`
  (`packages/llm-agent/src/interfaces/pipeline-plugin.ts`, additive, beside `mcpClients`).
  `buildServerCtx` (`smart-server.ts:2149-2152`) rebinds the authoritative `provenance` onto
  **`scope.parts.mcpClients`** (session-local) by `slotIndex` and populates `ctx.toolClientMap`.
  The controller routes via `ctx.toolClientMap.get(name)` instead of its own bare bridge.
- **`SmartServer.callMcp`** (linear/stepper): its clients (`_sharedMcpClients`) *are* the
  snapshot's clients, so it uses the authoritative snapshot's `toolClientMap` directly. Its
  target stays global exactly as today.

Rebinding needs `slotIndex → client instance`. Session/seam clients are produced from `cfg.mcp`
in config order and (per Fork 2, below) **paired with their descriptors**, so each carries its
`slotIndex`; rebinding matches `provenance.slotIndex` to the session client with that
`slotIndex`. A slot absent from a session (its server not built/healthy) simply has no map
entry → `map.get` miss → `{ text: "Tool not found: <name>", isError: true }`, byte-identical to
today's `buildMcpBridge` miss (`smart-server.ts:158`).

### 3d. Descriptors — where each path gets `{ slotIndex, label }` (Fork 2: full fix)

- **Yaml-builder path:** descriptors come from `IMcpConnectionStrategy.resolve()`, surfaced on
  `SmartAgentHandle` (§3a). Hoist the `resolved` local (scoped in the connect `else`,
  `builder.ts:975-1017`) to function scope so `configuredSlotCount` survives to the `return`;
  on the caller-provided-`mcpClients` branch `resolved` is undefined so `configuredSlotCount`
  is legitimately absent (fall back to `clients.length`).
- **Session-local + seam path:** `buildSessionMcpClients` (`build-session-mcp-clients.ts`) and
  the default `connectMcpClientsFromConfig` (`smart-server.ts:583`) build clients from `cfg.mcp`
  in config order and today ignore `cfg.mcp[].name`. Have each **return descriptors paired with
  the clients** (`slotIndex = config index`, `label = cfg.mcp[i].name`, `configuredSlotCount =
  cfg.mcp.length`) — an `McpConnectionResult`-shaped result — so §3c can rebind by `slotIndex`
  and labels work on these paths. Descriptors are always `cfg.mcp`-derived, independent of
  producer, so exposed names agree with the builder's snapshot even on the isolation-OFF path
  (session clients == global clients). Custom consumer connectors: the existing
  `BuildAgentDeps.connectMcp: () => Promise<IMcpClient[]>` seam stays **unchanged**
  (non-breaking); add an optional parallel `connectMcpWithDescriptors?: () =>
  Promise<McpConnectionResult>`. Resolution: `connectMcpWithDescriptors` if provided → else
  `connectMcp` with an **array-index fallback** (`{slotIndex:i}`, no label) — a bare custom
  connector still gets callable colliding tools.

### 3e. The `toolNamespace` source

Add an optional DI knob `BuildAgentDeps.toolNamespace?: IToolNamespace` (default
`defaultToolNamespace`): the server passes it to the builder via `.withToolNamespace(ns)` in
`buildBaseBuilder` (`smart-server.ts:2206-2226`) so the yaml snapshot uses it, and uses the
same instance for the server-side fallback build (§3a). A YAML strategy-name knob is out of
scope; `mcp[].name` labels cover the config need.

## 4. Fallback + partial-failure algorithm (P2)

- **One authoritative build** of `{ tools, provenance }` (builder or server-side fallback,
  §3a). Per-seam maps are pure rebindings of it — no seam re-lists to recompute names.
- **Partial `listTools()` failure** in the authoritative build: skip the failing client (as
  today's `vectorizeMcpTools`/`makeToolsRagHandle` do — neither aborts the whole build), and
  **log it via `vectorizeMcpTools`'s `clientFailures` reporting** rather than
  `makeToolsRagHandle`'s silent drop. A skipped client's tools are absent from the snapshot
  (unroutable/unselectable until the next build), same as today.
- **Routing:** always `toolClientMap.get(name)`; miss → `{isError, "Tool not found"}` (never a
  throw). The old lazy `listTools()`-scan bridge is retained **only** as the fallback when a
  host supplies **no** namespaced view at all (an embedding/pipeline context that never built
  one) — see §5. No path both eager-builds and lazy-scans the same clients.
- **Selection:** catalog keyed by exposed name; a RAG record absent from the catalog (unknown,
  stale, foreign, or an availability flip) is skipped — graceful, never a crash.

## 5. Backward-compat guarantees

- No descriptors + no `toolNamespace` + no collision → bare names, real-client map values, and
  (where no view is supplied) the `listTools()`-scan bridge fallback: **byte-for-byte today's
  behavior**.
- A single configured server never collides → all names bare.
- **Per-session isolation (#213/#226) preserved:** the controller keeps routing to
  `scope.parts.mcpClients`; `callMcp` keeps routing to `_sharedMcpClients`. No seam retargets.
- `SmartAgentHandle`, `IPipelineContext`, `IToolsRagHandle`, `BuildAgentDeps` change **only
  additively**; the `connectMcp` signature and the `Map<string,IMcpClient>` `toolClientMap`
  value type are untouched.

## 6. Testing strategy (the plan TDDs each)

- **Session-availability (the P1 headline):** boot vectorizes `s0__Search`/`s1__Search`; a
  session where server 1 is DOWN must still route `s0__Search` to the healthy server 0 (name
  from the authoritative snapshot, rebound to the session's server-0 instance), and `s1__Search`
  → `isError` "Tool not found" — **not** a bare-`Search` collapse. This is the test that pins
  the collision-not-config-stable fix.
- **Per-session isolation:** two sessions with distinct client instances; a namespaced call in
  session A reaches A's instance, not the global clients nor B's — distinct spies per session.
- **No-writable-RAG deployment:** with `toolsRag` absent/read-only, two colliding servers still
  get namespaced, selectable, callable tools (snapshot built independent of RAG write).
- **Stale/foreign RAG record:** a persisted namespaced record with no matching catalog entry is
  skipped — not surfaced, not called.
- **Server e2e per pipeline:** controller (session map) AND linear/stepper (global `callMcp`
  map) each route server-1's `Search` to client 1 with the **original** name; client 0 not
  called.
- **`mcp[].name` labels on both producer paths;** partial `listTools()` failure drops only the
  failing server (logged); disjoint-name regression floor stays green.

## 7. Out of scope (follow-ups)

- A YAML `toolNamespace:` strategy-name knob.
- Any change to the bare `connectMcp` seam signature (labels for bare custom connectors come via
  the optional `connectMcpWithDescriptors` seam).
- Per-session re-vectorization of the shared `toolsRag` (the frozen catalog + skip-on-miss
  degrades gracefully without it).
- **Cost note:** rebinding the provenance per session is a cheap map walk (no `listTools`
  round-trip — the authoritative snapshot is built once); memoizing per distinct client-set is a
  later optimization if ever needed.

## 8. Architecture-principles check

1. **Build ON components:** reuses `buildNamespacedTools`/`bindToolCallName`; the one snapshot
   feeds catalog + every seam. No bespoke server namespacing. ✓
2. **App is the example:** SmartServer demonstrates the feature on every pipeline, under
   isolation, with or without a RAG store. ✓
3. **Interfaces:** consumers still depend on `IToolsRagHandle`/`IPipelineContext`. ✓
4. **ISP:** focused optional fields + one parallel seam. ✓
5. **Strategies:** `IToolNamespace` reaches the server via DI, swappable. ✓
6/7. **File size / additive:** additive/backward-compatible; **does not regress #213
   isolation** and **does not couple correctness to RAG writability**. ✓
