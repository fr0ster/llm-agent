# Call-path namespacing for colliding MCP tools — design

Issue: [#244](https://github.com/fr0ster/llm-agent/issues/244) (follow-up to #240)

## Problem

Two MCP servers can expose a tool with the same name (e.g. `Search`). #240 fixed the
**storage** layer — `IToolRecordKey` keys the two records apart
(`tool:0:Search`, `tool:1:Search`) so both survive in the tools RAG and recall sees
both. It deliberately did NOT make a specific colliding tool **callable**. This is that
call-path work.

### The gap (verified in source)

- `McpToolRegistry.resolve()` (`mcp/tool-registry.ts:86-103`) dedupes the exposed tool
  list by name: `if (!toolClientMap.has(t.name)) { … }`. The first `Search` wins; the
  second server's client is dropped.
- `vectorizeMcpTools` stores `metadata: { name: t.name }` (`vectorize-mcp-tools.ts:227`)
  — bare `Search` for both records, so `toolNameFromRecord` returns `Search` for either.
- Every executor routes and calls by name via `toolClientMap.get(tc.name)` then
  `client.callTool(tc.name, …)`.

So a RAG hit for the second server's `Search` decodes to bare `Search`, and the
executor calls the **first** server. The record-level disambiguation never reaches the
call path.

### Why it is not a one-line fix

LLM tool-calling APIs require **unique** tool names, constrained to `^[a-zA-Z0-9_-]+$`
(so `:` — used in the storage key — is illegal in an exposed name). Making the LLM able
to pick a specific server's tool means **renaming** the tools it sees (namespacing),
consistently across exposure, RAG, and **every** executor — and there is more than one
executor and more than one place that builds the tool→client map (mapped below).

## Decisions (brainstorm)

- **Namespace only on an actual collision.** A name exposed by exactly one client stays
  bare — the single-server case is byte-for-byte unchanged.
- **Prefix = a config server label**, falling back to the client index. A new optional
  `name?` on the MCP config gives a durable, readable prefix (`primary__Search`); when
  unset, `s${slotIndex}` (`s0__Search`) — the STABLE configured slot, not the runtime
  array position (Component 2) — so the bug is fixed regardless of config.
- **Separator `__`** — within the LLM tool-name charset.
- **Consumer-owned strategy** (`IToolNamespace`), mirroring `IToolRecordKey`.
- `IToolRecordKey` (#240, released) is **unchanged**.

## Topology this design must cover (mapped from source)

- **Tool→client map is built/rebuilt in three own-`listTools` paths** (each fans out
  over ALL clients, so each can see a collision): `McpToolRegistry.resolve()`
  (`tool-registry.ts:86-103`), the lazy first-load in `tool-select.ts:43-52`, and the
  per-iteration refresh in `tool-loop.ts:203-221` (`clear()` + rebuild). A fourth path,
  `agent.ts:868-871`, rebuilds from `resolve()` (already covered). All three own paths
  currently dedupe by bare name — the second colliding tool is dropped in each.
- **The real MCP call happens at four sites, all resolving the client via
  `toolClientMap.get(name)` and passing that same `name` to `client.callTool`:**
  `tool-loop-core.ts:281` (+ the health-probe at `:351`), `mixed-tool-call-handler.ts:51`,
  and the coordinator `buildCallTool` closure `coordinator.ts:307-313` (which backs
  `ICoordinatorContext.callTool`, used by `self.ts:137`). A namespaced name would be sent
  to the server verbatim at every one of these unless the original is recovered.

## Components

### 1. `IToolNamespace` — consumer-owned exposed-name strategy

New in `@mcp-abap-adt/llm-agent` (beside `IToolRecordKey`):

```ts
export interface ToolNamespaceContext {
  toolName: string;      // original name the server exposes
  prefix: string;        // resolved by the builder: config `name`, else `s${slotIndex}`
  colliding: boolean;    // name exposed by >1 active client
}
export interface IToolNamespace {
  /** Name the LLM sees / RAG stores. Must match `^[a-zA-Z0-9_-]+$`. */
  expose(ctx: ToolNamespaceContext): string;
}
export const defaultToolNamespace: IToolNamespace = {
  expose: ({ toolName, prefix, colliding }) =>
    colliding ? `${prefix}__${toolName}` : toolName,
};
```

Swappable via `SmartAgentBuilder.withToolNamespace`, like `withToolRecordKey`.

### 2. Config `name?` + a STABLE runtime client identity (the prefix source)

**The prefix must derive from a stable identity, not the runtime array position.** The
connection strategy returns a bare `IMcpClient[]` (`McpConnectionResult.clients`), and
`LazyConnectionStrategy` FILTERS OUT unhealthy slots
(`lazy-connection-strategy.ts:123-125`), so a client's array index ≠ its configured
position — if server 0 is down, server 1 becomes index 0 and an index-based prefix
silently shifts `s1__` → `s0__`. The label is likewise unrecoverable at runtime: no
`name` exists on any config layer and no client carries a config back-reference. So an
`s${arrayIndex}` prefix is NOT stable. Two coordinated changes fix this:

- **`name?: string` on every config layer** it must flow through:
  `SmartServerMcpConfig` (`smart-server.ts`) → `BuilderMcpConfig`
  (`builder-types.ts`) / `McpConnectionConfig` (`mcp-connection-strategy.ts`) →
  `MCPClientConfig` (`llm-agent-mcp`). Parse-time validation: each `name`, if set, must
  match `^[a-zA-Z0-9_-]+$` and be **unique** among the configured MCP servers (equal
  labels → equal prefixes → re-collision). The index fallback is charset-safe and unique.
- **A stable per-client descriptor on `McpConnectionResult`.** Add (additive)
  `clientDescriptors?: readonly { slotIndex: number; label?: string }[]`, aligned by
  index with `clients`. `slotIndex` is the client's ORIGINAL configured-array position
  (stable across reconnect and independent of which slots are currently healthy);
  `label` is that slot's config `name`. `LazyConnectionStrategy` already keeps a
  `Slot[]` 1:1 with configs (`:40-44`) — it populates a descriptor from each surviving
  slot's index + config. `PeriodicConnectionStrategy` forwards it. Strategies that never
  filter (Eager/Noop/Embedded — array position already equals config position) may omit
  it; consumers then fall back to the array index.

`McpToolRegistry` stores `activeClientDescriptors` beside `activeClients`
(`resolveActiveClients`, `:50-56`) and passes `{ client, slotIndex, label }` per active
client into `buildNamespacedTools`. Prefix = `label ?? \`s${slotIndex}\``. Because
`slotIndex`/`label` come from the config-stable slot, the prefix is stable across
reconnect and across a peer server going down.

### 3. `buildNamespacedTools` — the single shared builder (used by ALL three map paths)

A pure function in `@mcp-abap-adt/llm-agent`, so the exposure, both refresh paths, and
RAG never drift:

```ts
export function buildNamespacedTools(
  perClient: Array<{ slotIndex: number; label?: string; client: IMcpClient; tools: McpTool[] }>,
  ns: IToolNamespace,
): {
  tools: McpTool[];                        // each with `name` = the exposed name
  toolClientMap: Map<string, IMcpClient>;  // keyed by exposed name (value: see Component 5)
};
```

Behaviour:
- `prefix = label ?? \`s${slotIndex}\`` (the stable identity from Component 2).
- collision = a tool name present in ≥2 clients' `tools`.
- for each (client, tool): `exposed = ns.expose({ toolName, prefix, colliding })`;
  push `{ ...tool, name: exposed }`; set `toolClientMap[exposed]` to a client bound to the
  ORIGINAL name (Component 5).
- **Global-uniqueness guard (P1c):** the FINAL exposed set — renamed AND bare — must be
  unique. If `ns.expose` ever produces a name already used (a generated `s0__Search`
  clashing with a real bare `s0__Search`; two custom-strategy outputs colliding; a
  non-colliding bare name equal to another's generated name), throw a clear error naming
  the conflicting (server, originalName, exposedName) triples and advising distinct
  `mcp[].name` labels. This holds for the default AND any custom strategy — the builder
  validates the strategy's output, never trusts it.

### 4. Exposure + both refresh paths consume the shared builder

- `McpToolRegistry.resolve()` (`tool-registry.ts`): replace the inline dedupe loop with
  `buildNamespacedTools(...)`; return its `tools` + `toolClientMap`. `agent.ts:868-871`
  (which copies `resolve()`'s map) follows automatically.
- `tool-select.ts:43-52` (lazy first-load) and `tool-loop.ts:203-221` (refresh): replace
  their own `!has(name)` dedupe loops with `buildNamespacedTools(...)` over the same
  `ctx.mcpClients` they already fan out over, writing the returned map into
  `ctx.toolClientMap` and the exposed tools into `ctx.mcpTools`. Both already load ALL
  clients, so the collision set is complete at each. This removes the drop-second-tool
  behaviour from EVERY path, not just `resolve()`.

### 5. The original-name strip is ENCAPSULATED in the binding (no public type change, un-missable)

The public, re-exported `PipelineContext.toolClientMap` (`context.ts:128`) and
`ToolRegistryResult` keep their value type `Map<string, IMcpClient>` — **unchanged**, so
this is not a breaking API change. The strip lives inside the value:

- For a **bare** (non-renamed) tool, the value is the real client — unchanged.
- For a **renamed** tool, the value is a thin `IMcpClient` wrapper bound to the ORIGINAL
  name: its `callTool(_ignoredExposedName, args, opts)` delegates to
  `realClient.callTool(originalName, args, opts)`; every other `IMcpClient` method
  proxies straight through. Wrapping `IMcpClient` is idiomatic here (McpClientAdapter,
  connection strategies).

Because the strip is in the binding, **no call site and no signature changes**:
`tool-loop-core.ts:281/351`, `mixed-tool-call-handler.ts:51`, and the coordinator
`buildCallTool` closure (`coordinator.ts:309`) already do
`toolClientMap.get(name).callTool(name, …)` — for a renamed tool they now transparently
reach the real server with the real name, and any FUTURE executor added later is correct
by construction (it cannot forget to strip). This directly closes the "reverse mapping
only in tool-loop-core" gap without threading a side-map that a new site could ignore.

The wrapper factory (e.g. `bindToolCallName(client, originalName): IMcpClient`) lives in
`@mcp-abap-adt/llm-agent` beside `buildNamespacedTools`, which uses it. Routing
(`toolClientMap.has(tc.name)`, `.keys()`) stays keyed by the exposed name — correct.

> Alternative considered: change the map value to `{ client, callName }` and strip at
> each call site. Rejected — it is a breaking change to the re-exported `PipelineContext`
> and pushes the strip onto every (present and future) call site. The wrapper keeps the
> public type stable and the strip un-missable.

### 6. RAG — store the exposed name (same builder)

`vectorizeMcpTools` presents the SAME exposed names before storing
`metadata: { name: t.name }` (`vectorize-mcp-tools.ts:227`): it already iterates all
clients' tools, so it runs them through `buildNamespacedTools` (same `IToolNamespace` +
labels) and stores each exposed name. `toolNameFromRecord` returns a non-empty
`meta.name` verbatim, so selection → LLM → executor all agree.

### 7. Internal↔external tool-name collision — a checked merge (the FINAL LLM list must be unique)

`buildNamespacedTools` guarantees the internal MCP set is unique, but the list offered
to the LLM is `[...internalTools, ...externalTools]` (client-provided per-request tools),
concatenated with NO de-dup at ~6 sites (`tool-select.ts:119`, `tool-loop.ts:222/339`,
`agent.ts:873/981`, `rag-orchestrator.ts:236`, subagent/cyclic executors). An external
tool can be named `Search`, `primary__Search`, or `s0__Search` — colliding with a bare
OR a generated internal name. `classifyToolCalls` (`tool-loop-core.ts:44-65`) then
partitions by INDEPENDENT membership (`toolClientMap.has` vs `externalToolNames.has`), so
a both-member name is dispatched as internal AND surfaced as external in the same turn.
No reserved-name check exists today.

A shared helper `mergeOfferedTools(internalTools, externalTools)` replaces the bare
concat at every merge site: it concatenates and, on any name present in BOTH sets,
**fail-fasts with a clear diagnostic** (`tool "<name>" is both an internal MCP tool
(exposed name) and a client-provided external tool — rename the external tool`). This
guarantees the offered list is unique, so `classifyToolCalls` can never double-classify.
It closes the collision for a bare internal name AND a generated namespace equally, and
centralizes the rule the way `buildNamespacedTools` centralizes exposure. (`injectToolPriority`'s
"prefer internal" prompt hint is advisory only and does not prevent the collision.)

### 8. `IToolRecordKey` — unchanged

Record id stays `tool:${clientIndex}:${name}` (original name + index); the exposed name
lives in `metadata.name`. Independent concerns.

## Data flow

```
Clients: 0 "primary" and 1 "secondary", both expose `Search`.

boot / re-vectorize:
  vectorizeMcpTools → buildNamespacedTools → metadata.name = "primary__Search" / "secondary__Search"

request (resolve OR tool-select first-load OR tool-loop refresh — all via buildNamespacedTools):
  tools: [{name:"primary__Search"}, {name:"secondary__Search"}]
  toolClientMap: { "primary__Search":   bind(client0,"Search"),   // IMcpClient wrapper
                   "secondary__Search": bind(client1,"Search") }
  RAG hit "secondary__Search" → LLM calls "secondary__Search"
  executor (any of the 4 sites): get("secondary__Search").callTool("secondary__Search", …)
     → wrapper delegates → client1.callTool("Search", …)  ✅

Single server / unique name: value is the real client; callTool(name) sends the same name — unchanged.
Pathological: a real bare tool literally named "s0__Search" alongside a generated one
  → buildNamespacedTools throws a clear error (set distinct mcp[].name labels).
```

## Error handling / edge cases

- **Illegal / duplicate label** → config-parse error (Component 2).
- **Generated name clashes with a real bare name, or custom-strategy output collides**
  → `buildNamespacedTools` fail-fast with a diagnostic (Component 3). The strip is never
  by parsing the separator, so a real tool named `Foo__Bar` is fine unless it actually
  produces a duplicate exposed name (then it fails fast like any collision).
- **External (client-provided) tool collides with a bare or generated internal name**
  → `mergeOfferedTools` fail-fasts (Component 7); the final LLM list is always unique and
  `classifyToolCalls` never double-classifies.
- **A peer server is down / reconnect** → the prefix comes from the stable `slotIndex`
  (config position) + `label`, NOT the filtered array position, so a colliding tool's
  exposed name does not shift when another server drops (Component 2). Every rebuild path
  uses the same builder over the same stable descriptors.
- **Three-way collision** → each client gets its own prefix; all survive; uniqueness
  guard still applies.

## Testing

- **Unit `IToolNamespace` default:** bare when unique; `${prefix}__${name}` on collision.
- **Unit `buildNamespacedTools`:** two clients same name → both renamed with prefix, and
  each map value's `callTool` delegates to the real client with the ORIGINAL name; a
  unique name → the value is the real client (sends the same name); label vs
  index-fallback prefix; **global-uniqueness fail-fast** — a generated name equal to a
  real bare name throws; a custom strategy returning a duplicate throws.
- **Unit wrapper (`bindToolCallName`):** `callTool(anyName, args)` → real client's
  `callTool(originalName, args)`; other `IMcpClient` methods proxy unchanged.
- **Registry `resolve()`:** two embedded clients both exposing `Search` → both exposed
  names present, both bindings; single-server registry byte-for-byte unchanged.
- **Refresh paths:** after a `tool-loop` refresh AND a `tool-select` first-load with two
  colliding clients, both exposed tools + bindings survive (namespacing does NOT vanish
  on refresh; the second is not re-dropped).
- **Executor strip — EVERY path:** a call for `secondary__Search` reaches
  `client.callTool("Search", …)` via (a) `tool-loop-core`, (b) `mixed-tool-call-handler`
  (mixed/external-resume), and (c) the coordinator `buildCallTool`/self-dispatch path.
  Assert the ORIGINAL name is sent and the CORRECT client is used; the other client is
  not called.
- **Stable identity across a dropped peer:** clients 0/1/2 all expose `Search`; client 1
  is unhealthy so the strategy returns clients 0 and 2. Their exposed prefixes stay
  `s0`/`s2` (or their labels) — NOT `s0`/`s1` — proving the prefix follows `slotIndex`,
  not the filtered array position.
- **Internal↔external collision fail-fast:** `mergeOfferedTools` throws when an external
  tool is named (a) the same as a bare internal MCP tool, and (b) the same as a generated
  namespace (`s0__Search`) — both with a clear diagnostic.
- **End-to-end (issue acceptance):** two embedded MCP servers, same tool name, distinct
  behaviours; a RAG hit for server 1's tool drives a call that reaches **client 1**.
- **RAG agreement:** `vectorizeMcpTools` stores exposed `metadata.name`;
  `toolNameFromRecord` round-trips it.
- **Regression:** existing single-server tool-loop / tool-select / tool-registry /
  vectorize tests stay green.

## Documentation

- **CHANGELOG / TROUBLESHOOTING:** colliding MCP tools are now individually callable via
  namespaced names (`primary__Search`); set `mcp[].name` for durable, readable prefixes,
  else the client index is used; single-server unchanged; a real tool whose name equals a
  generated namespace fails fast with guidance to set labels.
- **ARCHITECTURE / INTEGRATION:** the `IToolNamespace` strategy (swappable via the
  builder), `mcp[].name`, and the UX note — the model sees namespaced names ONLY on a
  collision, so a skill/prompt referencing a bare colliding tool name must account for
  the prefix.

## Delivery

One PR:

- `@mcp-abap-adt/llm-agent` — `IToolNamespace` + `defaultToolNamespace` +
  `ToolNamespaceContext`; `bindToolCallName` wrapper factory; the pure
  `buildNamespacedTools` (global-uniqueness guard); `mergeOfferedTools`; `name?` on
  `McpConnectionConfig`; `clientDescriptors?` on `McpConnectionResult`.
- `@mcp-abap-adt/llm-agent-mcp` — `name?` on `MCPClientConfig`; `LazyConnectionStrategy`
  populates `clientDescriptors` from its `Slot[]` (config-stable `slotIndex` + `label`);
  `PeriodicConnectionStrategy` forwards it.
- `@mcp-abap-adt/llm-agent-libs` — `McpToolRegistry` stores `activeClientDescriptors` and
  passes `{ client, slotIndex, label }` to `buildNamespacedTools`; `resolve()`,
  `tool-select`, `tool-loop` refresh, and `vectorizeMcpTools` use `buildNamespacedTools`;
  all ~6 internal+external concat sites use `mergeOfferedTools`;
  `SmartAgentBuilder.withToolNamespace`. **No call-site or `toolClientMap` type change** —
  the strip is in the binding.
- `@mcp-abap-adt/llm-agent-server-libs` — `name?` on `SmartServerMcpConfig` +
  `BuilderMcpConfig` + parse + label charset/uniqueness validation; thread the label into
  the connection config.
- Tests (unit + registry + refresh + all-executor strip + stable-identity +
  internal↔external + end-to-end) and docs.

Additive to the public API (`IToolNamespace`, `bindToolCallName`, `buildNamespacedTools`,
`mergeOfferedTools`, `McpConnectionResult.clientDescriptors`, `mcp[].name`);
`IToolRecordKey`, `PipelineContext.toolClientMap`'s type, and single-server behaviour are
all unchanged.
