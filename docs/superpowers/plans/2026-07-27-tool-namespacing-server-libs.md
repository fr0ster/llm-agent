# #244 Server-libs Namespacing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make #244 colliding-tool namespacing work on every `llm-agent-server-libs` pipeline
(controller / linear / stepper; flat / dag already work via the agent's internal registry)
without weakening per-session MCP isolation (#213/#226).

**Architecture:** ONE authoritative namespaced snapshot `{ tools (exposed schemas),
provenance: exposed→{slotIndex, originalName} }` computed once via the existing
`buildNamespacedTools`; the global tools-RAG catalog is keyed by exposed name from it, and every
routing seam **rebinds** that snapshot's provenance onto its own client instances by `slotIndex`
(via `bindToolCallName`) — collision is never recomputed per-session. One shared
`buildNamespacedMcpBridge` preserves the current fail-loud classifier semantics. Full design +
rationale: `docs/superpowers/specs/2026-07-27-tool-namespacing-server-libs-addendum.md` (read it
before starting).

**Tech Stack:** TypeScript (ESM, strict), node:test via `npx tsx --test`, Biome.

## Global Constraints

- All artifacts (code, comments, commit messages) in **English**.
- ESM only — relative imports end in `.js`.
- TypeScript strict; no `any` (Biome warns).
- Biome gate: `npm run lint:check` clean of NEW errors. Build gate: `npm run build` clean before each commit.
- Test: single file `npx tsx --test <path>`; package `npm test --workspace <pkg>`.
- **Additive public API only.** New/changed: `SmartAgentHandle` optional fields; `IPipelineContext.toolClientMap?`;
  `BuildAgentDeps.{connectMcpWithDescriptors?, toolNamespace?}`; new type `McpClientsWithDescriptors`;
  new fn `connectMcpClientsWithDescriptorsFromConfig`; new fn `buildNamespacedMcpBridge`. **UNCHANGED:**
  the exported `connectMcpClientsFromConfig` return type `Promise<IMcpClient[]>` (kept as a compat wrapper);
  the bare `BuildAgentDeps.connectMcp` signature; the `Map<string,IMcpClient>` `toolClientMap` value type;
  single-server / no-collision behaviour (bare names, real-client map value); #213 client-target per seam.
- **Namespace ONLY on a real collision** (≥2 active clients expose a name). Separator `__`; exposed names
  `^[a-zA-Z0-9_-]+$`, ≤64. Exposed names + collision come from the SINGLE authoritative snapshot; seams REBIND.
- **Fail-loud preserved:** an availability failure THROWS; a tool-level error returns `{ isError: true }`.
- **Per-session isolation preserved:** no seam changes which client list it targets.
- Reuse existing exports (`buildNamespacedTools`, `bindToolCallName`, `defaultToolNamespace`,
  `McpClientDescriptor` from `@mcp-abap-adt/llm-agent`). **Verify every line number / signature against
  source before editing** — line numbers below are from investigation-time HEAD and drift.

**Cross-package order (dependency direction):** `llm-agent` → `llm-agent-libs` → `llm-agent-server-libs`.
Task 1 (interface additions in `llm-agent`) lands first so downstream packages can consume it.

---

### Task 1: `llm-agent` interface additions (`SmartAgentHandle`, `IPipelineContext.toolClientMap`)

**Files:**
- Modify: `packages/llm-agent/src/interfaces/builder.ts` (`SmartAgentHandle`, ~:56-85)
- Modify: `packages/llm-agent/src/interfaces/pipeline-plugin.ts` (`IPipelineContext`, add `toolClientMap?` beside `mcpClients?`)
- Test: `packages/llm-agent/src/interfaces/__tests__/smart-agent-handle-namespace.test.ts` (create — a type-shape compile assertion)

**Produces:**
- `SmartAgentHandle<T>` optional fields: `namespacedTools?: readonly LlmTool[];`
  `toolProvenance?: ReadonlyMap<string, { slotIndex: number; originalName: string }>;`
  `mcpClientDescriptors?: readonly McpClientDescriptor[];` `configuredSlotCount?: number;`
- `IPipelineContext.toolClientMap?: Map<string, IMcpClient>;`

- [ ] **Step 1: Write the failing test** — a compile-level assertion that an object literal with the new
  optional fields satisfies `SmartAgentHandle`, and one without them still does (additive). Example:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SmartAgentHandle, IPipelineContext } from '../../index.js';
test('SmartAgentHandle accepts optional namespace fields (additive)', () => {
  const withNs = {} as SmartAgentHandle;
  // @ts-expect-no-error — fields are optional, absence is valid
  assert.equal(withNs.namespacedTools, undefined);
  const ctx = {} as IPipelineContext;
  assert.equal(ctx.toolClientMap, undefined);
});
```

- [ ] **Step 2: Run RED** — `npx tsx --test <path>` fails to compile (fields not declared yet).
- [ ] **Step 3: Implement** — add the four optional fields to `SmartAgentHandle` (import `LlmTool`,
  `McpClientDescriptor` from the correct local modules — VERIFY paths, e.g. `./types.js` / `./mcp-connection-strategy.js`);
  add `toolClientMap?: Map<string, IMcpClient>;` to `IPipelineContext` beside `mcpClients?`. Re-export any new
  name from the barrel if needed (check `interfaces/index.ts` pattern).
- [ ] **Step 4: Run GREEN + `npm run build`** (whole monorepo builds — these are consumed downstream).
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent/src/interfaces/builder.ts packages/llm-agent/src/interfaces/pipeline-plugin.ts packages/llm-agent/src/interfaces/__tests__/smart-agent-handle-namespace.test.ts
git commit -m "feat: SmartAgentHandle namespace snapshot fields + IPipelineContext.toolClientMap (#244)"
```

---

### Task 2: Builder computes + surfaces the authoritative snapshot; `vectorizeMcpTools` consumes a pre-built view

**Files:**
- Modify: `packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts` (accept a pre-built namespaced view instead of building internally)
- Modify: `packages/llm-agent-libs/src/builder.ts` (build the view ONCE unconditionally; surface on the handle)
- Test: `packages/llm-agent-libs/src/mcp/__tests__/vectorize-mcp-tools.test.ts` (append) + `packages/llm-agent-libs/src/__tests__/builder-namespace-snapshot.test.ts` (create)

**Consumes:** `buildNamespacedTools`, `McpClientDescriptor`. **Produces:** the builder always computes
`{ tools, provenance }` when it has MCP clients (independent of RAG writability), surfaces
`namespacedTools`/`toolProvenance`/`mcpClientDescriptors`/`configuredSlotCount` on `SmartAgentHandle`, and
vectorizes (when a writable store exists) from that SAME view — one `listTools` pass, no divergence.

- [ ] **Step 1: Write the failing tests**
  - `vectorizeMcpTools`: assert it accepts a pre-built `{ tools, provenance }` (or `perClient` already
    namespaced) and stores the given exposed `metadata.name` — WITHOUT re-running `buildNamespacedTools`
    internally (assert by passing a view whose exposed names differ from what a fresh namespacing would
    produce, and checking the stored names match the passed view).
  - **Health-status preserved (the regression trap):** the prebuilt-view path must still report a
    partial-catalog failure. Assert that when the builder's single `listTools` pass had a client failure, the
    resulting `ToolVectorizationSummary` has `complete === false` (and `clientFailures > 0`) — i.e. the listing
    outcome is threaded into the summary, NOT hardcoded `complete: true`. (Today Phase-1 listing computes this;
    the refactor must not lose it — it feeds `/health components.toolCatalog: degraded`, v20.8.0.)
  - builder: build a `SmartAgent` via the builder with two embedded clients exposing `Search` AND **no
    writable tools RAG** (omit/readonly store); assert `handle.namespacedTools` contains `s0__Search`/`s1__Search`
    and `handle.toolProvenance.get('s1__Search')` = `{ slotIndex: 1, originalName: 'Search' }` (snapshot exists
    even though nothing was vectorized).
- [ ] **Step 2: Run RED** — vectorize has no such param; handle has no `namespacedTools`.
- [ ] **Step 3: Implement**
  - Refactor `vectorizeMcpTools` (VERIFY current signature at `vectorize-mcp-tools.ts:~113-140`): keep the
    trailing `ns?` object but split responsibilities — the caller passes the already-built view AND the
    listing outcome (the builder does the single `listTools` pass, so it — not vectorize — knows the failures).
    Add to `ns` an optional
    `prebuiltView?: { tools: readonly LlmTool[]; provenance: ReadonlyMap<string, {slotIndex; originalName}>; clientFailures: number; total: number }`;
    when present, skip the internal Phase-1 listing + `buildNamespacedTools`, iterate the given `tools`, key
    records via `provenance`, AND seed `acc.clientFailures`/`acc.total` from the passed values so
    `summary.complete` still reflects a partial-catalog failure (do NOT hardcode `complete: true`). When absent,
    keep today's internal listing+build+failure-accounting (back-compat). The RAG-write early-return (`:126`
    `if (!toolsRag || !writer) return undefined;`) stays — it only skips WRITING. **Note:** when the builder
    surfaces the snapshot but there is no writable RAG, the builder must still publish the catalog status from
    its own listing outcome (it can't rely on vectorize's early-returned `undefined`) — see the builder step.
  - In `builder.ts` (VERIFY at `:975-1017`): hoist `resolved` to function scope; when `mcpClients.length`,
    do the single `listTools()` pass over `mcpClients`, tracking a `clientFailures` count and `total`; build the
    view ONCE: `const { tools, provenance } = buildNamespacedTools(perClient, this._toolNamespace ?? defaultToolNamespace)`
    where `perClient` zips the successfully-listed `mcpClients` + `resolved.clientDescriptors` + listed tools.
    Pass `{ ...ns, prebuiltView: { tools, provenance, clientFailures, total } }` to `vectorizeMcpTools`.
    **Catalog status:** `vectorizeMcpTools` returns `undefined` when there's no writable RAG, so the builder
    must publish the catalog status (`ToolCatalogStatusHolder`, VERIFY at `:1016`) from ITS listing outcome in
    that case — the health signal must not depend on a writable store. Surface on the `return {…}` (`:1289`):
    `namespacedTools: tools`, `toolProvenance: provenance`, `mcpClientDescriptors: resolved?.clientDescriptors`,
    `configuredSlotCount: resolved?.configuredSlotCount` (all conditionally spread; absent on the
    caller-provided-`mcpClients` branch where `resolved` is undefined).
- [ ] **Step 4: Run GREEN + full libs suite** (`npm test --workspace @mcp-abap-adt/llm-agent-libs`; baseline was
  911/911 at branch HEAD — confirm no pre-existing test regressed; a test that encoded the old double-list
  behaviour may need an evidence-backed update).
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-libs/src/mcp/vectorize-mcp-tools.ts packages/llm-agent-libs/src/builder.ts packages/llm-agent-libs/src/mcp/__tests__/vectorize-mcp-tools.test.ts packages/llm-agent-libs/src/__tests__/builder-namespace-snapshot.test.ts
git commit -m "feat(agent): builder surfaces authoritative namespaced snapshot; vectorize consumes pre-built view (#244)"
```

---

### Task 3: `McpClientsWithDescriptors` type + rebind helper + shared `buildNamespacedMcpBridge`

**Files:**
- Create: `packages/llm-agent-server-libs/src/smart-agent/mcp/namespaced-bridge.ts` (rebind + bridge)
- Create/modify: a types module for `McpClientsWithDescriptors` (e.g. `packages/llm-agent-server-libs/src/smart-agent/mcp/mcp-clients-with-descriptors.ts`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/namespaced-bridge.test.ts` (create)

**Consumes:** `bindToolCallName`, `McpClientDescriptor`, `IMcpFailureClassifier`, `IMcpClient`. **Produces:**
- `interface McpClientsWithDescriptors { clients: IMcpClient[]; clientDescriptors?: readonly McpClientDescriptor[]; configuredSlotCount?: number }`
- `rebindProvenanceToClients(provenance, clients, descriptors): Map<string, IMcpClient>` — for each
  `[exposedName, { slotIndex, originalName }]`, find the client whose descriptor `slotIndex` matches (or, when
  descriptors absent, the client at array index `slotIndex`); set
  `map[exposedName] = exposedName === originalName ? client : bindToolCallName(client, originalName)`
  — i.e. the real client when the name was NOT namespaced (bare), the wrapper when it WAS, matching
  `build-namespaced-tools.ts:80` (`exposed === t.name`). Do NOT re-`listTools` to discover a "bare name" — the
  discriminator is purely `exposedName === originalName`. **When no client matches a `slotIndex`** (fewer session
  clients than provenance slots, e.g. a slot that never constructed): **skip that entry** (no map key) → a later
  `map.get` miss yields "Tool not found" per §2; never throw.
- `buildNamespacedMcpBridge(toolClientMap, classifier): (name, args, signal) => Promise<McpCallResult>` — the
  shared bridge from addendum §3c: `map.get(name)` miss → `{ text: 'Tool not found: '+name, isError: true }`;
  else `client.callTool(name, ...)`, classify errors with a healthCheck probe (availability → throw; tool-level →
  `{ isError: true, text: error.message }`); success → `{ text, isError: value.isError ?? false }`.

- [ ] **Step 1: Write the failing tests**
  1. **rebind:** provenance `{ s0__Search→{0,Search}, s1__Search→{1,Search} }` + two fake clients with
     descriptors `[{slotIndex:0},{slotIndex:1}]` → `map.get('s1__Search').callTool('s1__Search', {})` reaches
     client 1 with ORIGINAL `Search`; a unique/bare name maps to the real client (identity ===).
  2. **bridge miss:** unknown name → `{ isError:true, text:/Tool not found/ }`, no client called.
  3. **bridge fail-loud:** a client whose `callTool` errors and the classifier deems `unavailable` → the bridge
     **throws**; a tool-level error → `{ isError:true }` with the message. Use a stub `IMcpFailureClassifier`.
- [ ] **Step 2: Run RED** (module doesn't exist).
- [ ] **Step 3: Implement** the three exports. Model the bridge body on the existing `buildMcpBridge`
  (`smart-server.ts:614-659`) — reuse its probe + classifier logic verbatim, minus the `listTools` ownership scan.
- [ ] **Step 4: Run GREEN + full server-libs suite** (baseline 851/853, 2 pre-existing skips).
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/mcp/namespaced-bridge.ts packages/llm-agent-server-libs/src/smart-agent/mcp/mcp-clients-with-descriptors.ts packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/namespaced-bridge.test.ts
git commit -m "feat(server): McpClientsWithDescriptors + rebindProvenanceToClients + shared buildNamespacedMcpBridge (fail-loud preserved) (#244)"
```

---

### Task 4: Descriptor producers + seam detection + precedence

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts` (add optional descriptor fields to the return; keep `close`)
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (new `connectMcpClientsWithDescriptorsFromConfig`; `connectMcpClientsFromConfig` → compat wrapper; `BuildAgentDeps.connectMcpWithDescriptors?`; `_mcpSeamInjected` at ~:808-809; provisioning precedence at the seam call sites ~:1224/:1950; default `_deps` at ~:831)
- Test: `packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/descriptor-producers.test.ts` (create) + a seam-detection test (append to an existing smart-server test or create)

**Produces:** `buildSessionMcpClients` returns `McpClientsWithDescriptors & { close }`;
`connectMcpClientsWithDescriptorsFromConfig(): Promise<McpClientsWithDescriptors>`;
`connectMcpClientsFromConfig` unchanged export (delegates, returns `.clients`);
`BuildAgentDeps.connectMcpWithDescriptors?` in seam detection + precedence.

- [ ] **Step 1: Write the failing tests**
  - `buildSessionMcpClients(cfg)` with two `mcp:` entries `[{name:'a'},{name:'b'}]` → result has
    `clientDescriptors [{slotIndex:0,label:'a'},{slotIndex:1,label:'b'}]`, `configuredSlotCount 2`, `clients.length 2`,
    and a callable `close`.
  - `connectMcpClientsWithDescriptorsFromConfig` likewise returns descriptors; the compat
    `connectMcpClientsFromConfig` returns a bare `IMcpClient[]` (same as before).
  - **seam detection:** a `SmartServer` constructed with `deps.connectMcpWithDescriptors` ONLY (no `mcpClients`,
    no `connectMcp`) → `_mcpSeamInjected` is true and the server takes the seam path (assert the injected
    callback is invoked, not the YAML-builder path). Precedence: when both `connectMcpWithDescriptors` and
    `connectMcp` are present, the descriptor one wins.
- [ ] **Step 2: Run RED.**
- [ ] **Step 3: Implement** (VERIFY every line number against source):
  - `build-session-mcp-clients.ts`: build descriptors `{ slotIndex: i, label: cfg[i].name }` in the existing
    config-order loop; return `{ clients, clientDescriptors, configuredSlotCount: list.length, close }`.
  - `smart-server.ts`: add `connectMcpClientsWithDescriptorsFromConfig` (the real impl reading `cfg.name`);
    rewrite `connectMcpClientsFromConfig` to `return (await connectMcpClientsWithDescriptorsFromConfig(mcpCfg)).clients`;
    add `connectMcpWithDescriptors?: () => Promise<McpClientsWithDescriptors>` to `BuildAgentDeps` (~:355);
    `_mcpSeamInjected` (~:808) → `deps.mcpClients !== undefined || deps.connectMcp !== undefined || deps.connectMcpWithDescriptors !== undefined`;
    at the provisioning sites (~:1224, ~:1950) resolve `deps.connectMcpWithDescriptors` first (capture its
    descriptors), else `deps.connectMcp` (bare → array-index `{slotIndex:i}` fallback), else the default
    `connectMcpClientsWithDescriptorsFromConfig`. Store the resulting descriptors + `configuredSlotCount` on
    `SmartServer` fields (e.g. `_sharedMcpClientDescriptors`, `_configuredSlotCount`) beside `_sharedMcpClients`
    for Task 6/7.
- [ ] **Step 4: Run GREEN + full server-libs suite.**
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/mcp/build-session-mcp-clients.ts packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/mcp/__tests__/descriptor-producers.test.ts
git commit -m "feat(server): descriptor-aware connectors + buildSessionMcpClients descriptors + connectMcpWithDescriptors seam detection/precedence (#244)"
```

---

### Task 5: `makeToolsRagHandle` exposed-name catalog + stale-record skip

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/tools-rag-handle.ts`
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-namespace.test.ts` (create)

**Consumes:** the authoritative snapshot `{ namespacedTools, provenance }`. **Produces:** the catalog is keyed by
EXPOSED name when a pre-built snapshot is supplied; a RAG record whose exposed name is absent from the catalog is
skipped (stale/foreign); no pre-built snapshot → today's bare behaviour (back-compat).

- [ ] **Step 1: Write the failing tests**
  - Given `namespacedTools = [s0__Search, s1__Search]` + a `toolsRag` returning a record with
    `metadata.name = 's1__Search'` → `query()` returns the `s1__Search` schema (catalog HIT by exposed name).
  - A `toolsRag` record with `metadata.name = 'sX__Ghost'` (no catalog entry) → skipped (not in results), no crash.
  - No `namespacedTools` arg → bare catalog exactly as today.
- [ ] **Step 2: Run RED** (catalog is bare-keyed).
- [ ] **Step 3: Implement** — add an optional param `namespaced?: { namespacedTools: readonly LlmTool[]; }`
  (VERIFY `makeToolsRagHandle` signature at `tools-rag-handle.ts:19`); when present, build `catalog` from
  `namespacedTools` keyed by `t.name` (exposed) instead of listing clients bare; keep the existing
  `toolNameFromRecord`→`catalog.get`→skip-on-miss query logic (already at `:55-58`) — it now hits by exposed name.
- [ ] **Step 4: Run GREEN + full server-libs suite.**
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/tools-rag-handle.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/tools-rag-handle-namespace.test.ts
git commit -m "feat(server): tools-RAG handle catalog keyed by exposed name + stale-record skip (#244)"
```

---

### Task 6: Server obtains the authoritative snapshot (handle or server-side fallback) + `toolNamespace` DI

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`buildToolsRagHandle`/`_buildInfra`
  snapshot resolution; `BuildAgentDeps.toolNamespace?`; `.withToolNamespace` in `buildBaseBuilder` ~:2206-2226;
  new fields to hold the snapshot)
- Test: append to a smart-server infra test (create `packages/llm-agent-server-libs/src/smart-agent/__tests__/server-namespace-snapshot.test.ts`)

**Produces:** the server holds an authoritative `{ namespacedTools, provenance }` + descriptors:
- yaml-builder path: from `agentHandle.namespacedTools/toolProvenance/mcpClientDescriptors/configuredSlotCount`.
- seam / consumer-builder path (no handle snapshot): server builds ONCE via `buildNamespacedTools` over
  `_sharedMcpClients` + the descriptors captured in Task 4 + the server `toolNamespace`.
- `buildToolsRagHandle` passes `{ namespacedTools }` into `makeToolsRagHandle` (Task 5).

- [ ] **Step 1: Write the failing tests**
  - yaml path: server exposes the handle's `namespacedTools` (assert the tools-RAG handle catalog resolves
    `s1__Search`).
  - seam path (inject `connectMcpWithDescriptors` returning two colliding `Search` clients, no builder snapshot):
    server builds the snapshot itself → catalog resolves `s0__Search`/`s1__Search`.
  - `BuildAgentDeps.toolNamespace` (custom, e.g. `PRIMARY__`) reaches the yaml snapshot (assert prefix).
- [ ] **Step 2: Run RED.**
- [ ] **Step 3: Implement** (VERIFY line numbers):
  - Destructure `namespacedTools`/`toolProvenance`/`mcpClientDescriptors`/`configuredSlotCount` from
    `agentHandle` (`~:1303-1313`); store on server fields (`_namespacedTools`, `_toolProvenance`, and reuse the
    descriptor fields from Task 4).
  - Add a private `resolveAuthoritativeSnapshot()`: if the handle carried `toolProvenance`, use it; else
    `buildNamespacedTools(perClient over _sharedMcpClients + descriptors, this._toolNamespace)` ONCE, memoized.
  - `BuildAgentDeps.toolNamespace?: IToolNamespace` (default `defaultToolNamespace`); `buildBaseBuilder`
    (`~:2206-2226`) calls `.withToolNamespace(this._toolNamespace)`; the same instance feeds the server-side
    fallback build.
  - `buildToolsRagHandle` (`~:1983-1994`) passes `{ namespacedTools }` to `makeToolsRagHandle`.
- [ ] **Step 4: Run GREEN + full server-libs suite.**
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/server-namespace-snapshot.test.ts
git commit -m "feat(server): authoritative snapshot resolution (handle or server-side build) + toolNamespace DI (#244)"
```

---

### Task 7: Wire routing — `ctx.toolClientMap` (per-session), `callMcp`, and the controller through the shared bridge

**Files:**
- Modify: `packages/llm-agent-server-libs/src/smart-agent/smart-server.ts` (`buildServerCtx` populates
  `ctx.toolClientMap` from `scope.parts.mcpClients`; `callMcp` rebinds over `_sharedMcpClients` + shared bridge)
- Modify: `packages/llm-agent-server-libs/src/pipelines/controller.ts` (~:161 — consume `ctx.toolClientMap` via the shared bridge instead of `buildMcpBridge(ctx.mcpClients,…)`)
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/server-routing-namespace.test.ts` (create)

**Produces:** namespaced calls route to the correct server with the original name on ALL affected pipelines,
with isolation + fail-loud preserved.

- [ ] **Step 1: Write the failing tests**
  - **Controller session-local:** build the server; a controller run where the LLM calls `s1__Search` reaches
    the SESSION's client-1 instance (not the global `_sharedMcpClients`), with original `Search`.
  - **`callMcp` (linear/stepper):** `ctx.callMcp('s1__Search', …)` reaches server 1 with `Search`.
  - **Down-server fail-loud:** in a session where server 1's client is present but its server is unavailable, a
    `s1__Search` call THROWS (classifier availability) — not `isError`, not "Tool not found".
- [ ] **Step 2: Run RED** (routing still bare / controller builds its own bare bridge).
- [ ] **Step 3: Implement**
  - `buildServerCtx` (`~:2149-2152`): `toolClientMap: rebindProvenanceToClients(this._toolProvenance ?? <resolve>,
    scope.parts.mcpClients, <session descriptors>)` (session descriptors = config-derived; the session build is
    dense/config-order so array index == slotIndex). Populate `ctx.toolClientMap`.
  - `callMcp` (`~:1899-1909`): build (memoized) `rebindProvenanceToClients(snapshot.provenance, this._sharedMcpClients,
    this._sharedMcpClientDescriptors)` and serve via `buildNamespacedMcpBridge(map, this._mcpFailureClassifier)`.
  - `controller.ts` (`~:161`): if `ctx.toolClientMap` is present, `const mcpBridge = buildNamespacedMcpBridge(ctx.toolClientMap, ctx.mcpFailureClassifier)`;
    else fall back to today's `buildMcpBridge(ctx.mcpClients, …)` (no map supplied = no namespacing).
- [ ] **Step 4: Run GREEN + full server-libs suite.**
- [ ] **Step 5: Build + lint, commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/smart-server.ts packages/llm-agent-server-libs/src/pipelines/controller.ts packages/llm-agent-server-libs/src/smart-agent/__tests__/server-routing-namespace.test.ts
git commit -m "feat(server): per-session ctx.toolClientMap + callMcp + controller route via shared namespaced bridge (#244)"
```

---

### Task 8: End-to-end acceptance + docs

**Files:**
- Test: `packages/llm-agent-server-libs/src/smart-agent/__tests__/server-namespacing-e2e.test.ts` (create)
- Modify: `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATION.md`, `docs/TROUBLESHOOTING.md`

- [ ] **Step 1: e2e acceptance tests** (embedded MCP servers; drive through real SmartServer pipelines). Cover
  every §6 case: session-availability (server 1 down in session → `s0__Search` routes to healthy server 0,
  `s1__Search` → fail-loud throw); per-session isolation (two sessions, distinct instances); no-writable-RAG
  deployment still namespaces; stale/foreign RAG record skipped; controller AND linear/stepper each route
  server-1's tool with the original name (client 0 not called); `mcp[].name` labels on both producer paths;
  partial `listTools()` failure drops only the failing server; fail-loud availability vs tool-level isError
  through the shared bridge.
- [ ] **Step 2: Run → PASS.**
- [ ] **Step 3: Docs** — CHANGELOG under the existing held `## [20.9.0]` (add server-libs coverage to the #244
  entry; do NOT create a new heading). ARCHITECTURE/INTEGRATION: the server routes colliding tools via the
  authoritative snapshot + per-seam rebind, isolation-preserving, fail-loud-preserving; `mcp[].name` labels;
  `BuildAgentDeps.{connectMcpWithDescriptors, toolNamespace}` seams. TROUBLESHOOTING: "two MCP servers, one
  tool uncallable on the server pipelines" → fixed; note the frozen-snapshot accepted consequence. **Verify
  every documented name/signature against source before writing.**
- [ ] **Step 4: Verify** — `grep -rn "buildNamespacedMcpBridge\|connectMcpWithDescriptors\|rebindProvenanceToClients" packages/*/src | grep -v test`.
- [ ] **Step 5: Commit**

```bash
git add packages/llm-agent-server-libs/src/smart-agent/__tests__/server-namespacing-e2e.test.ts CHANGELOG.md docs/
git commit -m "test+docs: #244 server-libs namespacing e2e + documentation (#244)"
```

---

## Final Verification

- [ ] `npm run build` clean.
- [ ] `npm run lint:check` no NEW errors.
- [ ] `npm test --workspace @mcp-abap-adt/llm-agent`, `…-libs`, `…-server-libs` — `fail 0` (baseline-diff any pre-existing).
- [ ] Whole-branch review (opus) of the full #244 branch (original + this addendum) — the same broad review that
  found this gap re-run against the completed work.
- [ ] Live gate (maintainer): two real MCP servers with a same-named tool through a server pipeline → the model
  can call each; a labeled config yields `label__tool`.
- [ ] External review; merge only on the maintainer's explicit word. Folds into the held v20.9.0.

## Self-review notes (spec coverage)

- §2 authoritative snapshot → Tasks 2 (build/surface) + 6 (server obtains/fallback).
- §3a decouple-from-RAG-writability → Task 2. §3b exposed-name catalog + stale skip → Task 5.
- §3c shared bridge + rebind + per-seam maps → Tasks 3 (bridge/rebind) + 7 (wire). §3d descriptors/types/seam
  detection/compat wrapper → Tasks 1 (types) + 4. §3e toolNamespace DI → Task 6.
- §4 partial-failure + routing/selection semantics → Tasks 3/5/7. §6 tests → distributed per task + Task 8 e2e.
- Down-vs-unknown (§2) → Tasks 3 (bridge miss) + 7 (fail-loud) + 8 (e2e). Isolation (#213) → Tasks 6/7 + 8.
