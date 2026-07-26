# Call-path namespacing for colliding MCP tools — design

Issue: [#244](https://github.com/fr0ster/llm-agent/issues/244) (follow-up to #240)

## Problem

Two MCP servers can expose a tool with the same name (e.g. `Search`). #240 fixed the
**storage** layer — `IToolRecordKey` keys the two records apart
(`tool:0:Search`, `tool:1:Search`) so both survive in the tools RAG and recall sees
both. It deliberately did NOT make a specific colliding tool **callable**. This is that
call-path work.

### The gap (verified in source)

- `McpToolRegistry.resolve()` (`mcp/tool-registry.ts:93-103`) dedupes the exposed tool
  list by name: `if (!toolClientMap.has(t.name)) { … }`. The first `Search` wins; the
  second server's client is dropped from `toolClientMap`.
- `vectorizeMcpTools` stores `metadata: { name: t.name }` (`vectorize-mcp-tools.ts:227`)
  — bare `Search` for both records, so `toolNameFromRecord` returns `Search` for either.
- The executor routes and calls by name: `toolClientMap.has(tc.name)` /
  `.get(tc.name)` (`tool-loop-core.ts:51`, `mixed-tool-call-handler.ts:47`) and
  `client.callTool(tc.name, …)` (`tool-loop-core.ts:281`).

So a RAG hit for the second server's `Search` decodes to bare `Search`, and the
executor calls the **first** server. The record-level disambiguation never reaches the
call path.

### Why it is not a one-line fix

LLM tool-calling APIs (OpenAI, Anthropic) require **unique** tool names in the offered
list, constrained to `^[a-zA-Z0-9_-]+$` (so `:` — used in the storage key — is illegal
in an exposed name). Making the LLM able to pick a specific server's tool means
**renaming** the tools it sees (namespacing), consistently across exposure, RAG, and
the executor.

## Decisions (brainstorm)

- **Namespace only on an actual collision.** A name exposed by exactly one client stays
  bare — the common single-server case is byte-for-byte unchanged (no prompt/skill
  churn).
- **Prefix = a config server label**, falling back to the client index. A new optional
  `name?` on the MCP config gives a durable, readable prefix (`primary__Search`); when
  unset, the prefix is `s${clientIndex}` (`s0__Search`) so the bug is fixed regardless
  of whether the consumer configures labels.
- **Separator `__`** — within the LLM tool-name charset.
- **Consumer-owned strategy** (`IToolNamespace`), mirroring `IToolRecordKey`.
- `IToolRecordKey` (#240, released) is **unchanged** — the record id and the exposed
  name are separate concerns.

## Scope

- **In scope:** colliding MCP tools become individually callable — exposure renaming,
  `toolClientMap` keyed by the exposed name, RAG `metadata.name` = the exposed name, and
  the executor stripping the namespace before the real `callTool`. Plus the config
  `name?` field, the `IToolNamespace` strategy + default, an end-to-end test, and docs.
- **Out of scope:** changing `IToolRecordKey`'s record-id scheme; any change to
  single-server behavior; multiplexing a single tool call across servers.

## Components

### 1. `IToolNamespace` — consumer-owned exposed-name strategy

New interface in `@mcp-abap-adt/llm-agent` (beside `IToolRecordKey`):

```ts
export interface ToolNamespaceContext {
  /** The tool's original name as the server exposes it. */
  toolName: string;
  /** The prefix source: the server's config `name`, else `s${clientIndex}`. */
  prefix: string;
  /** True when this tool name is exposed by more than one active client. */
  colliding: boolean;
}

export interface IToolNamespace {
  /** The name the LLM sees / RAG stores. MUST be stable for a given
   *  (toolName, prefix, colliding) and match `^[a-zA-Z0-9_-]+$`. */
  expose(ctx: ToolNamespaceContext): string;
}

/** Default: bare when unique, `${prefix}__${toolName}` on a collision. */
export const defaultToolNamespace: IToolNamespace = {
  expose: ({ toolName, prefix, colliding }) =>
    colliding ? `${prefix}__${toolName}` : toolName,
};
```

The consumer can swap it (e.g. a different separator or scheme), consistent with
`SmartAgentBuilder.withToolRecordKey`.

### 2. Config `name?` — the durable prefix source

Add `name?: string` to `SmartServerMcpConfig` (`smart-server.ts`) and the lower
`MCPClientConfig` (`llm-agent-mcp`). It is the prefix for that server's colliding tools.
The prefix used by the default strategy is `config.name ?? \`s${clientIndex}\``. Charset:
the label is used verbatim in an LLM tool name, so it must match `^[a-zA-Z0-9_-]+$`;
validate at config parse and warn/reject otherwise (a label with a space or `:` would
produce an illegal tool name).

### 3. Collision detection + a shared "compute exposed names" helper

A pure helper in `@mcp-abap-adt/llm-agent` (beside `defaultToolNamespace`; llm-agent-libs
consumes it, so no cycle), applied identically at exposure and RAG so the two never drift:

```ts
// input: per active client, its index, its config label, and its listTools() names.
// output: for each (clientIndex, originalName) → the exposed name (via IToolNamespace),
//         PLUS the reverse map exposed→original for the renamed ones.
computeExposedNames(clients: Array<{ index; label?; toolNames: string[] }>,
                    ns: IToolNamespace): {
  exposed: (clientIndex: number, toolName: string) => string;
  toRealName: Map<string, string>; // exposed → original, only for renamed tools
}
```

Collision = a tool name present in ≥2 clients' `toolNames`.

### 4. `McpToolRegistry.resolve()` — rename instead of dedupe-by-name

`resolve()` (`tool-registry.ts:83-104`) stops dropping the second colliding tool.
Instead, after collecting all clients' tools, it computes exposed names and:

- pushes each tool into `tools` with `name` = the exposed name (a colliding tool now
  appears once per client, renamed; a unique tool stays bare),
- keys `toolClientMap` by the exposed name → the owning client (both survive),
- returns an added `toolCallNames: Map<string, string>` (exposed → original), populated
  only for renamed tools.

`ToolRegistryResult` (and `IMcpToolRegistry.resolve`) gains `toolCallNames`.

### 5. Executor strip — recover the original name at `callTool`

The routing (`toolClientMap.has(tc.name)` / `.get(tc.name)`) stays keyed by the exposed
name — correct, since `tc.name` from the LLM IS the exposed name. Only the real MCP call
needs the original:

- Thread `toolCallNames` through the pipeline context (`pipeline/context.ts:128` beside
  `toolClientMap`) — the same places `toolClientMap` is threaded.
- At `tool-loop-core.ts:281`: `client.callTool(toolCallNames.get(tc.name) ?? tc.name,
  tc.arguments, options)`. `??` keeps the bare/unique path unchanged.

This is additive (an optional map, defaulting to identity), so the existing
`toolClientMap: Map<string, IMcpClient>` type is unchanged — minimal blast radius, and
no fragile string parsing of the separator.

### 6. RAG — store the exposed name

`vectorizeMcpTools` must present the SAME exposed names before storing
`metadata: { name: t.name }` (`vectorize-mcp-tools.ts:227`). It already iterates all
clients' tools; apply `computeExposedNames` (with the same `IToolNamespace` + labels) so
each stored `metadata.name` is the exposed name. `toolNameFromRecord` then returns the
exposed name (`tool-record-key.ts` — it already returns a non-empty `meta.name`
verbatim), so selection → LLM → executor all agree.

### 7. `IToolRecordKey` — unchanged

The record id stays `tool:${clientIndex}:${name}` (original name + index). The exposed
name lives in `metadata.name`. The two are independent; no change to #240's contract.

## Data flow

```
Two clients, both expose `Search`; client 0 label "primary", client 1 label "secondary":

boot / re-vectorize:
  vectorizeMcpTools → computeExposedNames → stores metadata.name =
    "primary__Search" (client 0 record), "secondary__Search" (client 1 record)

request:
  resolve() → tools: […, {name:"primary__Search"}, {name:"secondary__Search"}]
            → toolClientMap: {"primary__Search"→client0, "secondary__Search"→client1}
            → toolCallNames: {"primary__Search"→"Search", "secondary__Search"→"Search"}
  RAG hit for "secondary__Search" → offered to LLM → LLM calls "secondary__Search"
  executor: toolClientMap.get("secondary__Search") = client1
            client1.callTool(toolCallNames.get("secondary__Search")="Search", …)  ✅

Single server (no collision): everything stays bare — unchanged.
```

## Error handling / edge cases

- **Illegal label** (space, `:`, etc.) → config parse warns/rejects (would otherwise
  produce an LLM-illegal tool name). Index fallback (`s0`) is always charset-safe.
- **A real tool name already contains `__`** → harmless: strip is via the
  `toolCallNames` map (exact key), never by parsing off a separator, so a real
  `Foo__Bar` is unaffected unless it actually collides (then it is renamed like any
  other).
- **External (client-provided) tools** → not in `toolClientMap`, never namespaced (they
  are not MCP tools; routing already separates them).
- **Reconnect / re-vectorize** (`agent.ts:868-871` rebuilds `toolClientMap`) → applies
  the same strategy, so exposed names and `toolCallNames` are rebuilt consistently.
- **Three-way collision** → each of the ≥2 clients gets its own prefix; all survive.
- **A label that duplicates another server's label** → two servers with the same
  `name` would produce the same exposed prefix and re-collide. Detect and warn at config
  parse (labels must be unique among configured MCP servers); the index fallback is
  inherently unique.

## Testing

- **Unit `IToolNamespace` / default:** bare when `colliding:false`; `${prefix}__${name}`
  when true; the prefix-from-label-else-index selection.
- **Unit `computeExposedNames`:** two clients same name → both renamed with their
  prefixes + `toRealName` maps both back; a unique name → bare, absent from `toRealName`;
  label vs index fallback.
- **Registry `resolve()`:** two clients (embedded) both exposing `Search` → `tools` has
  both exposed names, `toolClientMap` has both clients, `toolCallNames` maps both to
  `Search`; a single-server registry is byte-for-byte unchanged (no `toolCallNames`
  entries).
- **End-to-end (the issue's acceptance test):** two embedded MCP servers, same tool
  name, distinct behaviors; a RAG hit for **server 1's** tool drives a tool call that
  reaches **client 1** (assert via a spy on each client's `callTool` receiving the
  original `Search`). Confirm client 0 is NOT called.
- **Executor strip:** a tool call for `secondary__Search` invokes
  `client.callTool("Search", …)` (original), not `"secondary__Search"`.
- **RAG agreement:** `vectorizeMcpTools` stores `metadata.name` = the exposed name;
  `toolNameFromRecord` round-trips it; selection offers the exposed name.
- **Regression:** existing single-server tool-loop / tool-registry / vectorize tests
  stay green.

## Documentation

- **CHANGELOG / TROUBLESHOOTING:** colliding MCP tools are now individually callable via
  namespaced names (`primary__Search`); set `mcp[].name` for durable, readable prefixes,
  else the client index is used; single-server is unchanged.
- **ARCHITECTURE / INTEGRATION:** the `IToolNamespace` strategy (consumer-swappable via
  the builder, like `IToolRecordKey`), the `mcp[].name` config, and the UX note — the
  model sees namespaced names ONLY on a collision, so a skill/prompt that references a
  bare colliding tool name must account for the prefix.

## Delivery

One PR:

- `@mcp-abap-adt/llm-agent` — `IToolNamespace` + `defaultToolNamespace` +
  `ToolNamespaceContext`; the pure `computeExposedNames` helper.
- `@mcp-abap-adt/llm-agent-mcp` — `name?` on `MCPClientConfig`.
- `@mcp-abap-adt/llm-agent-libs` — `resolve()` renaming + `toolCallNames`;
  `vectorizeMcpTools` exposed names; thread `toolCallNames` through pipeline context;
  executor strip at `callTool`; `SmartAgentBuilder.withToolNamespace`.
- `@mcp-abap-adt/llm-agent-server-libs` — `name?` on `SmartServerMcpConfig` + parse +
  label charset/uniqueness validation; wire the labels into the registry/vectorize.
- Tests (unit + registry + end-to-end) and docs.

Additive; `IToolRecordKey` and single-server behavior unchanged. The only public surface
additions are `IToolNamespace`, `toolCallNames` on the registry result, and `mcp[].name`.
