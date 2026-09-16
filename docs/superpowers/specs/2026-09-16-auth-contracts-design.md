# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review · **Date:** 2026-09-16 · **Base:** `main` at `7ea6ea3d` (v26.0.0)

## TL;DR

- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **One decision-maker for admission**, constructed with the caller's identity. It is *asked* in two places — the MCP server instance and the RAG provider — but it holds the only rules.
- **MCP lifetime is a real gap, but a narrow one:** `McpClientFactoryResult.close` already exists and never reaches the session factory.
- **Collections have two axes, not four scopes:** `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Ownership follows scope and is not configurable.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- This file is an **umbrella**: four workstreams (§10), each gets its own plan.

---

## 1. Why this exists

`@mcp-abap-adt/llm-agent` imports nothing from the `@mcp-abap-adt/interfaces*` packages today and declares its own `ILogger` and `IMcpRequestHeadersStrategy`. That was defensible while those contracts lived in one package taking 41 majors, almost all ADT. Since the split (`interfaces-utils`/`-network`/`-auth`/`-adt` 1.0.0; `interfaces` 45.0.0, marked deprecated in its README — not via `npm deprecate`) a contract can be shared without inheriting anyone's release cadence.

What this does **not** do: put authorization policy into llm-agent. Auth stays the consumer's job. This adds the seams through which a consumer supplies it, and removes the places where the library decides on the consumer's behalf.

---

## 2. The two jobs

| job | question | contract | where it lives |
|---|---|---|---|
| **A — prove who we are** | how do we authenticate to OpenAI / AI Core / Qdrant / PostgreSQL / HANA / a foreign MCP? | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | the constructor of the concrete implementation |
| **B — decide what the caller may do** | may *this* consumer call that tool, read that collection, delete it? | `AccessCheck<R>` | built by the consumer with the caller's identity, handed to whoever must ask |

**Data isolation is not a third job.** It is job B's decision, enforced again lower down (§6). One object holds the rules; it may be *asked* in more than one place.

---

## 3. MCP: lifetime and the seam that already exists

### 3.1 What is already there

```ts
// packages/llm-agent/src/interfaces/mcp-connection-strategy.ts
interface McpClientFactoryResult { client: IMcpClient; close?: () => Promise<void> | void }
type McpClientFactory = (config: McpConnectionConfig) => Promise<McpClientFactoryResult>;
interface McpConnectionConfig {
  type: 'http' | 'stdio'; url?; command?; args?; name?;
  headers?; requestHeadersStrategy?; timeout?; toolTimeouts?;
}
```

`close` is implemented (`llm-agent-mcp/src/factory.ts` → `wrapper.disconnect()`) and used by the lazy and periodic connection strategies; `IMcpConnectionStrategy.dispose?()` exists too. So **the library can already close a client**.

### 3.2 The actual gap

`SessionGraphFactoryOptions` (in `@mcp-abap-adt/llm-agent-libs`, `src/session/session-graph-factory.ts`) declares:

```ts
readonly mcpClientFactory: (identity: SessionGraphIdentity) => IMcpClient[];
readonly mcpClientFactoryWithDescriptors?: (identity) => {
  clients: IMcpClient[]; clientDescriptors?: readonly McpClientDescriptor[]; configuredSlotCount?: number;
};
```

Both return **bare clients**. Whatever `close` the factory had is dropped at this seam, so a per-session stdio child is never killed: `onDispose` has no handle on it. That is the whole defect — not a missing concept.

### 3.3 `IMcpServer` absorbs `McpClientFactory`

A per-MCP wrapper that holds its own credential cannot be a `McpClientFactory`, because that takes a generic `McpConnectionConfig` and has nowhere to put a credential typed per target. So the contract becomes an object, and the existing function becomes one way to build it:

```ts
interface IMcpServer {
  readonly descriptor?: McpClientDescriptor;   // slotIndex + label, so pairing survives
  start(): Promise<IMcpClient>;
  stop(): Promise<void>;                        // what `close` was
}

// adapter, so nothing is rewritten at once
declare function mcpServerFromFactory(factory: McpClientFactory, config: McpConnectionConfig): IMcpServer;
```

One implementation per way of starting: **stdio** spawns a child; **http** starts nothing and owns a connection; **embedded** runs in-process (cloud-llm-hub's `EmbeddableMcpServer`). The name says "server" because it owns a server's lifetime from our side; for http that lifetime is a connection.

Each implementation demands in **its own constructor** exactly the credential its target needs, so the compiler answers "must I pass something?" without generics in the shared contract.

### 3.4 The per-session seam

```ts
readonly mcpServerFactory?: (identity: SessionGraphIdentity) => IMcpServer[];
```

The session factory starts them, pairs descriptors from `IMcpServer.descriptor` (falling back to array position, exactly as today), hands the clients to `SessionAgentParts.mcpClients`, and calls `stop()` on each in `onDispose`.

`mcpClientFactory` and `mcpClientFactoryWithDescriptors` stay for **one major**, deprecated, with `mcpServerFactory` taking precedence when set — the same courtesy `mcpClientFactoryWithDescriptors` itself received. `PipelineContext.mcpClients` does not change: the pipeline uses injected clients and knows nothing about authentication.

### 3.5 stdio credentials: the gap this closes

```ts
// packages/llm-agent-mcp/src/client.ts:317, today
new StdioClientTransport({ command: this.config.command, args: this.config.args || [] });
```

No `env`, no `cwd`. The SDK then uses `getDefaultEnvironment()` — a sanitized subset of the **host's** environment — so every child of every session gets the same one, and per-consumer credentials for stdio are impossible. The stdio implementation passes its own `env` (never `args`: those are visible in `ps`).

`McpConnectionConfig` stops being the contract and becomes the default implementation's configuration. `IMcpRequestHeadersStrategy` stays what its docstring says — extra headers — not the authentication seam.

---

## 4. Credentials name the protocol the accepting side speaks

`IApiKeyCredential { kind: 'api-key'; secret() }`, `IBearerCredential { kind: 'bearer'; token() }`, `ISecretLoginCredential { kind: 'secret-login'; principal; secret() }`. A contract never says whether the secret is a static password, a rotated key or a fresh token — that is the implementation behind it. The `kind` literal is what makes the check real: without it, api-key and bearer are structurally identical.

| seam | today | contract |
|---|---|---|
| `LLMProviderConfig.apiKey?: string` (openai, anthropic, deepseek, ollama) | a string, with a comment admitting it cannot describe SAP AI Core | `IApiKeyCredential` |
| `EmbedderFactoryConfig.apiKey?: string` | a second, separate key seam | `IApiKeyCredential` |
| `sap-aicore-llm`, `sap-aicore-embedder` | `clientId` + `clientSecret`, **or** the `AICORE_SERVICE_KEY` env fallback | `IBearerCredential` — see §9.2 |
| `qdrant-rag` | `url` + `apiKey?: string` | `IApiKeyCredential` |
| `pg-vector-rag`, `hana-vector-rag` | `host`/`port`/`user`/`password`/`database`, **or** `connectionString` | `ISecretLoginCredential` |
| an http MCP implementation | `headers` | whatever its server speaks |

**Where they live.** Decision 26 of `@mcp-abap-adt/interfaces` — *"a contract lives in the package that accepts it"* — with the threshold being **several packages**, not several families. `ISecretLoginCredential` is accepted by `pg-vector-rag` and `hana-vector-rag`; `IApiKeyCredential` by four providers and `qdrant-rag`. So they go to `@mcp-abap-adt/interfaces-auth`, as the credential spec already states, and llm-agent takes a **type-only** dependency on it. (Decision 11 is a different rule — *a member is added because someone needs it* — and it is what keeps these unwritten until an acceptor exists.)

---

## 5. Admission: one decision-maker, asked in two places

```ts
type AccessCheck<R> = (request: R) => Promise<boolean>;   // interfaces-auth
type CollectionRequest = { action: 'read' | 'write' | 'create' | 'delete'; attributes: unknown };
```

There is no separate `ICollectionAccess`: it is `AccessCheck<CollectionRequest>`. The consumer builds it once with the caller's identity and hands the same object to the per-session MCP server instance **and** to the RAG provider. The provider has no rules of its own — it asks. One decision-maker, two call sites (§6.3).

The instance never reads ambient request context. cloud-llm-hub shows both patterns side by side today:

- ABAP tools: `assertToolAllowed(toolName, toolExposition, allowed)` in `srv/lib/tool-authorization.ts`, deny by default; the caller's roles come from request options *or* an async-local store, because — as `srv/agent-manager.ts:348` explains — the pipeline runs tool selection twice per request and the second pass rebuilds its own options.
- RAG collection tools: a module-level `dispatchRagTool(registry, name, body)` deriving identity per call from `cds.context?.user?.id ?? 'anonymous'`.

An instance built with identity needs neither the async-local fallback nor the `'anonymous'` default: no call path reaches it without a caller.

**Consequence for the hub.** RAG collection tools move off the external `body.tools` channel into a per-session embedded MCP server, wired as a pipeline step the way the ABAP MCP already is. The external channel is reserved for tools the **client** brings. This supersedes the earlier decision that RAG editing tools belong to the external channel.

**What llm-agent contributes:** `buildRagCollectionToolEntries({ registry })` returns entries whose handler takes `RagToolContext { sessionId?, userId? }` and has no consumer today. Either the hub mounts them in its per-session server, or llm-agent drops them.

---

## 6. RAG: whom does the store see?

### 6.1 Two axes, not four scopes

| axis | values |
|---|---|
| **scope** | `session` · `user` · `global` |
| **authorization** | `public` · `owner` · `role` |

`owner` is **implied by scope and not configurable**: a `user` collection is reachable by its owner, a `session` collection by its owner within that session. No setting opens someone else's collection to a role — ownership and role answer different questions, and mixing them would let a role read private material. Configurable policy therefore applies to `global` collections only: `public` or `role`-gated.

This replaces the earlier "fourth scope for roles" idea, which conflated the two axes. `RagCollectionScope` (`'session' | 'user' | 'global'`) needs no new member; the authorization axis lives in the opaque attributes (§6.3).

**Skills are an ordinary collection**, governed by the same two axes — not a special "configuration" kind. (This supersedes cloud-llm-hub's `2026-09-10-rag-collection-model-design.md`, which exempted them.)

### 6.2 Service or delegated identity

A credential on a RAG provider proves who **we** are to the store; it says nothing about the caller. Whether the store can judge the caller is a separate, typed choice:

```ts
interface ISharedRagProviderSource   { readonly identityMode: 'service';   create(): IRagProvider }
interface IPerIdentityRagProviderSource { readonly identityMode: 'delegated'; createFor(identity: SessionGraphIdentity): IRagProvider }
type RagProviderSource = ISharedRagProviderSource | IPerIdentityRagProviderSource;
```

The mode decides **who must filter**: under `service` the instance's filter is the *only* line of defence; under `delegated` the store enforces too, and our filter is the second. A seam that requires delegation declares `IPerIdentityRagProviderSource` and will not accept a shared source — a compile error, not a silent downgrade.

| store | sees today | to see the caller |
|---|---|---|
| PostgreSQL | the service user of a shared `pg.Pool` | a connection per identity, or `SET LOCAL` in a transaction with RLS policies reading it |
| HANA | the `uid`/`pwd` from configuration | the caller's JWT — supported by HANA; **which client connection properties carry it is unverified** |
| Qdrant | the holder of one `api-key` | a claim-restricted token; our client sends only `api-key` — **unverified** |
| OpenAI, Anthropic, AI Core | the service, always | impossible — our users do not exist there |

Because `SessionGraphIdentity` types `createFor`, `RagProviderSource` lives in `@mcp-abap-adt/llm-agent-libs` beside the session factory, unless that identity type moves down into `@mcp-abap-adt/llm-agent` first (§9.3).

### 6.3 Attributes are opaque to the provider, and must be persisted

```ts
// the provider stores the blob it was given and hands it back; only the check reads it
const ok = await access({ action: 'read', attributes: stored.attributes });
```

A provider must not depend on whether identity is `scope`/`sessionId`/`userId` or something we have not thought of. Two things follow:

1. **Attributes must be persisted by the provider.** `IRagProvider.createCollection(name, { scope, sessionId?, userId? })` receives them today and stores them nowhere — pg and qdrant use them only for `checkScope` and the id strategy. A provider that keeps nothing decides nothing after a restart or in a second instance.
2. **`scope` splits.** It carries two unrelated things: lifetime (a provider genuinely cannot make an in-memory collection outlive a session — that is what `supportedScopes` is for) and ownership (not the provider's business). Lifetime stays in the provider's vocabulary; ownership moves into the blob.

### 6.4 Where the registry stands

`SimpleRagRegistry` is shared across per-session builds and receives providers through `setProviderRegistry` (`llm-agent-libs/src/builder.ts:855`); its own comment says the registry is reused, which is why some collections opt into idempotent registration. A `delegated` source therefore cannot work through today's wiring: the registry outlives the identity. Either the registry becomes per-identity for delegated sources, or it holds the `RagProviderSource` and resolves a provider per call — **open (§9.4)**.

---

## 7. One job, one contract: the logger

`@mcp-abap-adt/llm-agent` declares `ILogger { log(event: LogEvent) }` (10 event kinds, 22 non-test source files reference it); `@mcp-abap-adt/interfaces-utils` declares `ILogger { info/warn/error/debug(message, meta?) }`. Same job, two contracts — and cloud-llm-hub pays for it today:

```ts
// srv/lib/errorUtils.ts:106
logger: ILogger | { error: (message: string, meta?: unknown) => void }
// srv/connections/BtpOnPremDestinationConnection.ts:14
// ILogger doesn't include csrfToken and tlsConfig, so we use loggerAdapter from lib/logger
```

**Direction:** llm-agent adopts the `interfaces-utils` contract as a **type-only** dependency and keeps `LogEvent` as the payload. Mapping rule: `message = event.type`, `meta = event`. The text shape is the general one — a structured event fits in `meta`, a closed union cannot carry arbitrary text. `interfaces-utils` needs no change; the major is llm-agent's.

---

## 8. What changes, and where

| package | change | breaking |
|---|---|---|
| `@mcp-abap-adt/llm-agent` | `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated; opaque collection attributes; `ILogger` from `interfaces-utils` | yes — one major |
| `@mcp-abap-adt/llm-agent-libs` | `mcpServerFactory` beside the two deprecated factories; stops servers on dispose; `RagProviderSource`; registry/identity wiring (§9.4) | yes |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`; `IMcpServer` implementations for stdio and http | yes |
| `llm-agent-rag`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | credentials in constructors; persist the attribute blob; ask the access check | yes |
| LLM and embedder providers | credential contracts replace `apiKey?: string`, keeping the AI Core env fallback question open | yes |
| `@mcp-abap-adt/interfaces-auth` | gains `AccessCheck` and the three credential contracts (decision 26: several packages accept them) | minor |
| cloud-llm-hub | per-session MCP server for collection tools; supplies `mcpServerFactory`, the access check and credentials | its own work |

---

## 9. Open questions

1. **HANA and Qdrant delegation.** Which `@sap/hana-client` properties carry a JWT; whether our Qdrant version supports claim-restricted tokens (§6.2).
2. **SAP AI Core.** Whether the SDK accepts a token source at all; if it does not, `IBearerCredential` cannot be mandatory there, and the `AICORE_SERVICE_KEY` fallback must survive.
3. **`SessionGraphIdentity`'s home.** It lives in `llm-agent-libs`. Moving it into `@mcp-abap-adt/llm-agent` lets `RagProviderSource` live with the other contracts; leaving it keeps the union in `llm-agent-libs`.
4. **The registry under delegation.** Per-identity registry, or a shared registry holding `RagProviderSource` (§6.4).
5. **PostgreSQL identity.** A pool per identity, or one pool with `SET LOCAL` and RLS.
6. **A marker on authenticated clients.** Should `mcpServerFactory`'s clients carry a type a hand-built client cannot fake, so a pipeline seam can refuse an unauthenticated one? Precedent for the risk: cloud-llm-hub PR #236 (`fix(security): stop caching MCP tool results across callers`, open) — a `ToolCache` shared by every caller of a destination returned one user's ABAP result to another within 30 s, below the role check and below their own SAP connection. The type was right; the behaviour was not.
7. **`buildRagCollectionToolEntries`.** Mounted by the hub's per-session server, or deleted.
8. **The server's YAML `mcp:` block.** Injection already outranks it. Keep it for the standalone CLI, or drop it so nothing in the library builds a client from configuration — noting stdio genuinely requires spawning, so "never start anything" is not an option.

---

## 10. Workstreams

This umbrella covers four independent changes. Each gets its own plan; all land in one major.

1. **MCP lifetime** — `IMcpServer`, `mcpServerFactory`, stop-on-dispose, stdio `env`.
2. **Credential contracts** — write them in `interfaces-auth`, adopt them in providers and implementations.
3. **RAG identity and attributes** — `RagProviderSource`, opaque persisted attributes, the two axes, registry wiring.
4. **Logger convergence** — one contract, `LogEvent` as payload.

---

## 11. Out of scope

- Writing any contract before a package accepts it (decision 11).
- cloud-llm-hub's implementation: its per-session graph, XSUAA-backed access check and collection levels are its own spec.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
