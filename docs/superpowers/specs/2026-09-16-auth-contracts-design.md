# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review round 2 · **Date:** 2026-09-16 · **Base:** `main` at `abf10310` (v26.0.0)

## TL;DR

- **This is a framework, not an application.** Every seam below is **offered**; a consumer may decline it and keep what it has. Nothing here decides policy on anyone's behalf.
- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **One decision-maker for admission**, built by the consumer with the caller's identity, asked wherever it must be — never a second set of rules.
- **MCP lifetime and identity are today app-local glue**, written once in `llm-agent-server-libs` and differently in cloud-llm-hub. The seam moves to `SmartAgentBuilder`, where every assembly already passes.
- **Collections have two axes**: `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Lifetime keys stay typed; only owner and role become opaque.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- Umbrella: four workstreams (§10), each gets its own plan, all in one major.

---

## 1. The framework's position

`@mcp-abap-adt/llm-agent` is a framework for assembling agents and pipelines of arbitrary shape. It does not know who assembles them: `llm-agent-server` is one assembly, cloud-llm-hub is another, and the next one is unknown. **It offers capabilities and adapts to nobody.**

Three rules follow, and every section below is bound by them:

1. **Declinable.** A new seam left unused changes nothing. No credential is mandatory, no access check is mandatory, no lifetime contract is mandatory.
2. **No default policy.** Where the framework cannot know the answer, it holds no opinion — it does not invent one. An absent access check means the framework does not judge, not that it permits on someone's behalf.
3. **No privileged topology.** Per-session, shared, single-user, multi-tenant — all are assemblies, and none is the reference.

The framework also imports nothing from `@mcp-abap-adt/interfaces*` today and declares its own `ILogger` and `IMcpRequestHeadersStrategy`. Where that changes below, the dependency is **type-only**, and the contracts are plain shapes with `kind` literals, so a consumer can satisfy them without importing anything.

---

## 2. The two jobs

| job | question | contract | supplied by |
|---|---|---|---|
| **A — prove who we are** | how do we authenticate to OpenAI / AI Core / Qdrant / PostgreSQL / HANA / a foreign MCP? | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | whoever constructs the concrete implementation |
| **B — decide what the caller may do** | may *this* caller use that tool, read that collection, delete it? | `AccessCheck<R>` | the consumer, built with the caller's identity |

**Data isolation is not a third job.** It is job B's decision, enforced again lower down (§6). One object holds the rules; it may be *asked* in more than one place.

---

## 3. MCP: lifetime and identity belong to the framework, not to each assembly

### 3.1 What already exists

```ts
// packages/llm-agent/src/interfaces/mcp-connection-strategy.ts
interface McpClientFactoryResult { client: IMcpClient; close?: () => Promise<void> | void }
type McpClientFactory = (config: McpConnectionConfig) => Promise<McpClientFactoryResult>;
interface McpConnectionConfig {
  type: 'http' | 'stdio'; url?; command?; args?; name?;
  headers?; requestHeadersStrategy?; timeout?; toolTimeouts?;
}
```

`close` is implemented (`llm-agent-mcp/src/factory.ts` → `wrapper.disconnect()`) and used by the lazy and periodic connection strategies; `IMcpConnectionStrategy.dispose?()` exists. `SmartAgentHandle.close()` already awaits `connectionStrategy?.dispose?.()` and a list of `closeFns`.

### 3.2 The real defect

Nothing leaks in the shipped server: `llm-agent-server-libs` captures `built.close` in a `closeBySession` map and awaits it on dispose (`smart-agent/session-lifecycle/index.ts`). But:

- that lifetime wiring is **glue inside one assembly** — `SessionGraphFactory` accepts `(identity) => IMcpClient[]`, so it cannot own `close`, and every other assembly writes its own variant. cloud-llm-hub wrote a different one: one `EmbeddableMcpServer` per SAP connection handed to `SmartAgentBuilder.withMcpClients([...])`.
- `opts.buildPerSessionMcpClients()` **takes no identity**, so per-caller credentials cannot reach the clients it builds at all.

So the framework offers no way to say "here is how an MCP server of mine is started, stopped, and told who is asking". Three assemblies, three answers, and the third one does not exist yet.

### 3.3 `IMcpServer`

```ts
interface IMcpServer {
  readonly descriptor?: McpClientDescriptor;   // slotIndex + label, so pairing survives
  start(): Promise<IMcpClient>;
  stop(): Promise<void>;
}

// the existing function becomes one way to build one
declare function mcpServerFromFactory(factory: McpClientFactory, config: McpConnectionConfig): IMcpServer;
```

One implementation per way of starting: **stdio** spawns a child; **http** owns a connection; **embedded** runs in-process. The credential a target needs is demanded by **that implementation's own constructor**, typed per target — which is why a bare `McpClientFactory` cannot express it: its single parameter is a generic `McpConnectionConfig` with nowhere to put a typed credential.

`start()` is called once per instance; **reconnection stays with `IMcpConnectionStrategy`**, which already owns outage handling, `toolsChanged` and revectorization. An implementation that cannot be restarted after `stop()` throws; the framework never restarts one on its own.

### 3.4 Where the seam lives

Every assembly passes through `SmartAgentBuilder`, so the seam is there:

```ts
builder.withMcpServers(servers: IMcpServer[]): this;   // beside withMcpClients, never replacing it
```

`build()` starts them, pushes each `stop()` into the `closeFns` the handle already awaits, and pairs descriptors. `SessionGraphFactory` and `llm-agent-server-libs` become **consumers** of that seam rather than owners of their own glue; cloud-llm-hub may adopt it without adopting `SessionGraphFactory`. An optional `mcpServerFactory?: (identity) => IMcpServer[]` on the session factory gives the per-session case the identity that `buildPerSessionMcpClients` never had.

Nothing is removed. `withMcpClients`, `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient` and `closeBySession` stay for **one major**, deprecated, with the new seam taking precedence when set — the same courtesy `mcpClientFactoryWithDescriptors` received in #244. A consumer that declines the seam keeps exactly today's behaviour.

**Descriptors.** They come from `IMcpServer.descriptor`, and the existing invariant holds unchanged (`assert-client-descriptors.ts`): descriptors are **all or none** (their count must equal the client count), `slotIndex` values are unique non-negative integers, and `configuredSlotCount`, when given, must be **strictly greater than the largest `slotIndex`**. When no server carries a descriptor, array position is the pairing, exactly as today.

**Dispose order.** The pipeline closes first, then the RAG registry's `closeSession`, and `stop()` runs **last** — the pipeline still holds the clients until it is done with them.

### 3.5 stdio credentials

```ts
// packages/llm-agent-mcp/src/client.ts:317, today
new StdioClientTransport({ command: this.config.command, args: this.config.args || [] });
```

No `env`, no `cwd`. The SDK then uses `getDefaultEnvironment()` — a sanitized subset of the **host's** environment — so every child of every session gets the same one, and per-caller credentials for stdio are impossible. The stdio implementation passes its own `env` (never `args`: visible in `ps`).

`McpConnectionConfig` remains the default implementation's configuration. `IMcpRequestHeadersStrategy` stays what its docstring says — extra headers — not the authentication seam.

---

## 4. Credentials name the protocol the accepting side speaks

`IApiKeyCredential { kind: 'api-key'; secret() }`, `IBearerCredential { kind: 'bearer'; token() }`, `ISecretLoginCredential { kind: 'secret-login'; principal; secret() }`. A contract never says whether the secret is a static password, a rotated key or a fresh token. The `kind` literal is what makes the check real: without it, api-key and bearer are structurally identical.

| seam | today | contract |
|---|---|---|
| `LLMProviderConfig.apiKey?: string` (openai, anthropic, deepseek, ollama) | a string, with a comment admitting it cannot describe SAP AI Core | `IApiKeyCredential` |
| `EmbedderFactoryConfig.apiKey?: string` | a second, separate key seam | `IApiKeyCredential` |
| `sap-aicore-llm`, `sap-aicore-embedder` | `clientId` + `clientSecret`, **or** the `AICORE_SERVICE_KEY` env fallback | `IBearerCredential` — §9.2 |
| `qdrant-rag` | `url` + `apiKey?: string` | `IApiKeyCredential` |
| `pg-vector-rag`, `hana-vector-rag` | `host`/`port`/`user`/`password`/`database`, **or** `connectionString` | `ISecretLoginCredential` |
| an http MCP implementation | `headers` | whatever its server speaks |

Every one of these is **optional**: a provider constructed the old way keeps working through the deprecation major.

**Where they live.** Decision 26 of `@mcp-abap-adt/interfaces` places a contract in the package that accepts it: several acceptors on the SAP side share `interfaces-adt`; contracts accepted **across families** go to `interfaces-auth`, `-network` or `-utils`.

- `AccessCheck<R>` is cross-family by construction — decision 26 names llm-agent and the hub as its acceptors — so `interfaces-auth` is its home.
- The three credential contracts are, today, accepted only inside this monorepo. They go to `interfaces-auth` because the agreed credential spec (`mcp-abap-adt-interfaces`, 2026-09-16) put them there, with `@mcp-abap-adt/connection` rebuilding `BasicAuthProvider`/`TokenAuthProvider` on them as the expected second family. If that second acceptor does not materialise, their home is `@mcp-abap-adt/llm-agent` and the credential spec must say so.

(Decision 11 — *a member is added because someone needs it* — is what keeps all of them unwritten until an acceptor exists.)

---

## 5. Admission: one decision-maker, no framework opinion

```ts
type AccessCheck<R> = (request: R) => Promise<boolean>;            // interfaces-auth
type CollectionRequest = { action: 'read' | 'write' | 'create' | 'delete'; attributes: unknown };
```

There is no separate collection-access contract: it is `AccessCheck<CollectionRequest>`. The consumer builds it once with the caller's identity and hands the same object wherever it must be asked — the MCP server instance it constructs, and the RAG provider (§6.3). The provider has no rules of its own; it asks.

**Absent means absent.** A framework that has not been given a check does not judge and does not pretend to permit: it simply has no admission step, exactly as today. Enforcement is the consumer's, and so is its absence.

cloud-llm-hub shows what an assembly does with it, and what happens without it:

- ABAP tools: `assertToolAllowed(toolName, toolExposition, allowed)` in `srv/lib/tool-authorization.ts`, deny by default; roles come from request options *or* an async-local store, because — per `srv/agent-manager.ts:348` — tool selection runs twice per request and the second pass rebuilds its own options.
- RAG collection tools: a module-level `dispatchRagTool(registry, name, body)` deriving identity per call from `cds.context?.user?.id ?? 'anonymous'`.

An instance built with identity needs neither the async-local fallback nor the `'anonymous'` default.

**What llm-agent contributes:** `buildRagCollectionToolEntries({ registry })` returns entries whose handler takes `RagToolContext { sessionId?, userId? }` and has no consumer today (§9.7).

---

## 6. RAG: whom does the store see?

### 6.1 Two axes

| axis | values |
|---|---|
| **scope** | `session` · `user` · `global` |
| **authorization** | `public` · `owner` · `role` |

`owner` is **implied by scope and not configurable**: a `user` collection is reachable by its owner, a `session` collection by its owner within that session. No setting opens someone else's collection to a role — ownership and role answer different questions. Configurable policy therefore applies to `global` collections only.

| scope | valid authorization | invalid |
|---|---|---|
| `session` | `owner` | `public`, `role` |
| `user` | `owner` | `public`, `role` |
| `global` | `public` or `role` | `owner` |

`RagCollectionScope` needs no new member: the earlier "fourth scope for roles" conflated the two axes. **Skills are an ordinary collection** under the same axes, not an exempt "configuration" kind — this supersedes cloud-llm-hub's collection-model spec, retired in hub commit `ae1e0e4b`.

### 6.2 Service or delegated identity

A credential on a RAG provider proves who **we** are to the store; it says nothing about the caller. Whether the store can judge the caller is a separate, typed, optional choice:

```ts
interface ISharedRagProviderSource      { readonly identityMode: 'service';   create(): IRagProvider }
interface IPerIdentityRagProviderSource { readonly identityMode: 'delegated'; createFor(identity: SessionGraphIdentity): IRagProvider }
type RagProviderSource = ISharedRagProviderSource | IPerIdentityRagProviderSource;
```

The mode decides **who must filter**: under `service` the consumer's check is the *only* line of defence; under `delegated` the store enforces too and the check is the second. A seam that requires delegation declares `IPerIdentityRagProviderSource` and will not accept a shared source.

| store | sees today | to see the caller |
|---|---|---|
| PostgreSQL | the service user of a shared `pg.Pool` | a connection per identity, or `SET LOCAL` in a transaction with RLS policies reading it |
| HANA | the `uid`/`pwd` from configuration | the caller's JWT — supported by HANA; **which client properties carry it is unverified** |
| Qdrant | the holder of one `api-key` | a claim-restricted token; our client sends only `api-key` — **unverified** |
| OpenAI, Anthropic, AI Core | the service, always | impossible — our users do not exist there |

Because `SessionGraphIdentity` types `createFor`, this union lives in `@mcp-abap-adt/llm-agent-libs` beside the session factory unless that identity type moves into `@mcp-abap-adt/llm-agent` first (§9.3).

### 6.3 Lifetime stays typed; only ownership becomes opaque

A provider must not depend on whether identity is `userId`, a role, a tenant or something we have not thought of. But two fields are **not** identity — they are lifetime, and the framework itself reads them: `SimpleRagRegistry.closeSession` deletes collections by `meta.scope === 'session' && meta.sessionId === sessionId`. Hide `sessionId` in a blob and `closeSession` goes blind.

```ts
createCollection(name, {
  scope: RagCollectionScope;      // lifetime — typed, read by the registry
  sessionId?: string;             // lifetime key for scope: 'session' — typed
  attributes?: unknown;           // ownership and policy — opaque, persisted, never interpreted
})
```

- `userId` moves into `attributes` (the registry never keys on it), `sessionId` and `scope` stay typed.
- **The provider persists `attributes`** and hands them back to the check. Today it persists nothing: pg and qdrant use the creation options only for `checkScope` and the id strategy, so a provider decides nothing after a restart or in a second instance.
- `supportedScopes` keeps its meaning — what a provider can make *outlive* — which is lifetime, not permission.

Who writes `attributes`: the component that knows the caller — the tool handler from its `RagToolContext`, or the consumer calling `createCollection` directly. The registry passes them through and never invents them (§9.5).

### 6.4 Where the registry stands

`SimpleRagRegistry` is shared across per-session builds and receives providers through `setProviderRegistry` (`llm-agent-libs/src/builder.ts:855`); its own comment explains why some collections opt into idempotent registration. A `delegated` source cannot work through that wiring: the registry outlives the identity. Either the registry becomes per-identity for delegated sources, or it holds the `RagProviderSource` and resolves per call — **open (§9.4)**.

---

## 7. One job, one contract: the logger

`@mcp-abap-adt/llm-agent` declares `ILogger { log(event: LogEvent) }` (10 event kinds, 22 non-test source files); `@mcp-abap-adt/interfaces-utils` declares `ILogger { info/warn/error/debug(message, meta?) }`. Same job, two contracts — and cloud-llm-hub pays for it today:

```ts
// srv/lib/errorUtils.ts:106
logger: ILogger | { error: (message: string, meta?: unknown) => void }
// srv/connections/BtpOnPremDestinationConnection.ts:14
// ILogger doesn't include csrfToken and tlsConfig, so we use loggerAdapter from lib/logger
```

**Direction:** llm-agent adopts the `interfaces-utils` contract as a **type-only** dependency and re-exports it, so its 22 files and every implementer keep one import path. `LogEvent` stays and becomes the payload.

| rule | value |
|---|---|
| message | `event.type`, except `warning`, where it is `event.message` |
| meta | the whole `event` |
| `pipeline_error` | `error` |
| `warning` | `warn` |
| `rag_upsert`, `rag_query`, `tools_selected` | `debug` |
| everything else | `info` |

The text shape is the general one: a structured event fits in `meta`, a closed union cannot carry arbitrary text. `interfaces-utils` needs no change; the major is llm-agent's.

---

## 8. What changes, and where

| package | change | breaking |
|---|---|---|
| `@mcp-abap-adt/llm-agent` | `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated; `attributes` on collection creation; `ILogger` re-exported from `interfaces-utils` | one major, all old seams kept |
| `@mcp-abap-adt/llm-agent-libs` | `withMcpServers` on the builder; start in `build()`, `stop()` into `closeFns`; optional `mcpServerFactory` on the session factory; `RagProviderSource`; registry wiring (§9.4) | additive |
| `@mcp-abap-adt/llm-agent-server-libs` | consumes the builder seam; `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` deprecated, not deleted | additive |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`; `IMcpServer` implementations for stdio and http | additive |
| `llm-agent-rag`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | optional credentials in constructors; persist `attributes`; ask the check when given one | additive |
| LLM and embedder providers | credential contracts beside `apiKey?: string`, keeping the AI Core env fallback (§9.2) | additive |
| `@mcp-abap-adt/interfaces-auth` | gains `AccessCheck` and, subject to §4, the three credential contracts | minor |
| cloud-llm-hub, `llm-agent-server` | **may** adopt the seams; neither is required to | their own work |

---

## 9. Open questions

1. **HANA and Qdrant delegation.** Which `@sap/hana-client` properties carry a JWT; whether our Qdrant version supports claim-restricted tokens (§6.2).
2. **SAP AI Core.** Whether the SDK accepts a token source at all; if not, `IBearerCredential` cannot be mandatory there and the `AICORE_SERVICE_KEY` fallback stays.
3. **`SessionGraphIdentity`'s home** — `llm-agent-libs` today; moving it into `@mcp-abap-adt/llm-agent` lets `RagProviderSource` sit with the other contracts.
4. **The registry under delegation** — per-identity registry, or a shared registry holding `RagProviderSource` (§6.4).
5. **Who writes `attributes` at creation** — tool handler, consumer, or both; and the final signatures of `IRagRegistry.createCollection` / `IRagProvider.createCollection` (§6.3).
6. **An optional marker on authenticated clients.** A seam *may* declare that it accepts only clients a factory produced, making "forgot the caller's credentials" a compile error. It must stay opt-in: mandatory, it would dictate policy. Precedent for the risk: cloud-llm-hub PR #236 (`fix(security): stop caching MCP tool results across callers`, open) — a `ToolCache` shared by every caller returned one user's ABAP result to another within 30 s, below the role check and below their own SAP connection.
7. **`buildRagCollectionToolEntries`** — mounted by a consumer, or deleted.
8. **The server's YAML `mcp:` block.** Injection already outranks it. It belongs to the `llm-agent-server` assembly, not to the library — but stdio genuinely requires spawning, so "the library never starts anything" is not an option.

---

## 10. Workstreams

Four independent changes under one umbrella; each gets its own plan, all land in one major.

1. **MCP lifetime and identity** — `IMcpServer`, `withMcpServers`, optional `mcpServerFactory`, stop-on-dispose, stdio `env`.
2. **Credential contracts** — write them where §4 settles, adopt them beside the existing fields.
3. **RAG identity and attributes** — `RagProviderSource`, persisted opaque attributes, the two axes, registry wiring.
4. **Logger convergence** — one contract, `LogEvent` as payload, levels per §7.

---

## 11. Out of scope

- Writing any contract before a package accepts it (decision 11).
- Any consumer's implementation: cloud-llm-hub's per-session graph and XSUAA-backed check, and `llm-agent-server`'s configuration, are theirs.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
