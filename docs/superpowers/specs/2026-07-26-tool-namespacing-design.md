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
  unset, `s${clientIndex}` (`s0__Search`), so the bug is fixed regardless of config.
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
  prefix: string;        // server config `name`, else `s${clientIndex}`
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

### 2. Config `name?` — the durable prefix source

Add `name?: string` to `SmartServerMcpConfig` (`smart-server.ts`) and the lower
`MCPClientConfig` (`llm-agent-mcp`). Prefix = `config.name ?? \`s${clientIndex}\``.
**Config-parse validation:** each `name`, if set, must match `^[a-zA-Z0-9_-]+$` (a space
or `:` would yield an illegal tool name) and must be **unique** among the configured MCP
servers (two equal labels would produce equal prefixes → a re-collision). Reject with a
clear error otherwise. The index fallback is inherently charset-safe and unique.

### 3. `buildNamespacedTools` — the single shared builder (used by ALL three map paths)

A pure function in `@mcp-abap-adt/llm-agent`, so the exposure, both refresh paths, and
RAG never drift:

```ts
export function buildNamespacedTools(
  perClient: Array<{ clientIndex: number; label?: string; client: IMcpClient; tools: McpTool[] }>,
  ns: IToolNamespace,
): {
  tools: McpTool[];                        // each with `name` = the exposed name
  toolClientMap: Map<string, IMcpClient>;  // keyed by exposed name (value: see Component 5)
};
```

Behaviour:
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

### 7. `IToolRecordKey` — unchanged

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
- **External (client-provided) tools** → not in `toolClientMap`, never namespaced.
- **Reconnect / re-vectorize** → every rebuild path uses the same builder, so exposed
  names + bindings are consistent.
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
  `ToolNamespaceContext`; the `bindToolCallName` wrapper factory; the pure
  `buildNamespacedTools` (with the global-uniqueness guard).
- `@mcp-abap-adt/llm-agent-mcp` — `name?` on `MCPClientConfig`.
- `@mcp-abap-adt/llm-agent-libs` — `resolve()`, `tool-select`, `tool-loop` refresh, and
  `vectorizeMcpTools` use `buildNamespacedTools`; `SmartAgentBuilder.withToolNamespace`.
  **No call-site or `toolClientMap` type change** — the strip is in the binding.
- `@mcp-abap-adt/llm-agent-server-libs` — `name?` on `SmartServerMcpConfig` + parse +
  label charset/uniqueness validation; wire labels into registry/vectorize.
- Tests (unit + registry + refresh + all-executor strip + end-to-end) and docs.

Additive to the public API (`IToolNamespace`, `bindToolCallName`, `buildNamespacedTools`,
`mcp[].name`); `IToolRecordKey`, `PipelineContext.toolClientMap`'s type, and
single-server behaviour are all unchanged.
