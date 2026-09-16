# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review round 8 · **Date:** 2026-09-16 · **Base:** `main` at `bd5c464c` (v26.0.0)

## TL;DR

- **This is a framework, not an application.** Every seam below is **offered**; a consumer may decline it and keep what it has. Nothing here decides policy on anyone's behalf.
- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **One decision-maker for admission**, built by the consumer with the caller's identity, asked wherever it must be — never a second set of rules.
- **MCP lifetime and identity are today app-local glue**, written once in `llm-agent-server-libs` and differently in cloud-llm-hub. The seam moves to `SmartAgentBuilder`, where every assembly already passes.
- **Collections have two axes**: `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Scope and the owner keys stay typed; only role and policy become opaque.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- **A minor, not a major.** Every seam is added beside what exists, nothing is removed, and no behaviour on any existing path changes — the safer teardown order comes with the new seam, through a new optional hook (§3.4).
- Umbrella: four workstreams (§10), each gets its own plan.

---

## 1. The framework's position

`@mcp-abap-adt/llm-agent` is a framework for assembling agents and pipelines of arbitrary shape. It does not know who assembles them: `llm-agent-server` is one assembly, cloud-llm-hub is another, and the next one is unknown. **It offers capabilities and adapts to nobody.**

Three rules follow, and every section below is bound by them:

1. **Declinable.** A new seam left unused changes nothing. No credential is mandatory, no access check is mandatory, no lifetime contract is mandatory.
2. **No default policy.** Where the framework cannot know the answer, it holds no opinion — it does not invent one. An absent access check means the framework does not judge, not that it permits on someone's behalf.
3. **No privileged topology.** Per-session, shared, single-user, multi-tenant — all are assemblies, and none is the reference.

The framework also imports nothing from `@mcp-abap-adt/interfaces*` today and declares its own `ILogger` and `IMcpRequestHeadersStrategy`. Where that changes below, the imports are **types-only** (`import type`, so nothing enters the runtime graph) though the package is still a regular dependency, and the contracts are plain shapes with `kind` literals, so a consumer can satisfy them without importing anything.

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

One implementation per way of starting: **stdio** spawns a child; **http** owns a connection; **embedded** runs in-process. The credential a target needs is demanded by **that implementation's own constructor**, typed per target — which is what a bare `McpClientFactory` cannot express **in its type**: a closure can capture a credential, but its single parameter is a generic `McpConnectionConfig`, so nothing in the signature says which credential this target needs.

`start()` is called once per instance; **reconnection stays with `IMcpConnectionStrategy`**, which already owns outage handling, `toolsChanged` and revectorization. An implementation that cannot be restarted after `stop()` throws; the framework never restarts one on its own.

### 3.4 Where the seam lives

Every assembly passes through `SmartAgentBuilder`, so the seam is there:

```ts
builder.withMcpServers(servers: IMcpServer[]): this;   // beside withMcpClients, never replacing it
```

`build()` starts them, pushes each `stop()` into the `closeFns` the handle already awaits, and pairs descriptors. `SessionGraphFactory` and `llm-agent-server-libs` become **consumers** of that seam rather than owners of their own glue; cloud-llm-hub may adopt it without adopting `SessionGraphFactory`. An optional `mcpServerFactory?: (identity) => IMcpServer[]` on the session factory gives the per-session case the identity that `buildPerSessionMcpClients` never had.

Nothing is removed by this release, which is a minor (§8). `withMcpClients`, `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient` and `closeBySession` are marked deprecated and live at least until the **next** major, with the new seam taking precedence when set — the same courtesy `mcpClientFactoryWithDescriptors` received in #244. A consumer that declines the seam keeps exactly today's behaviour.

**Descriptors.** They come from `IMcpServer.descriptor`, and the existing invariant holds unchanged (`assert-client-descriptors.ts`): descriptors are **all or none** (their count must equal the client count), `slotIndex` values are unique non-negative integers, and `configuredSlotCount`, when given, must be **strictly greater than the largest `slotIndex`**. When no server carries a descriptor, array position is the pairing, exactly as today.

**Ownership: exactly one owner per server.** A started server is stopped by whoever started it, and the two paths never overlap:

| path | starts | stops |
|---|---|---|
| builder | `build()`, from `withMcpServers` | `handle.close()`, through the `closeFns` it already awaits |
| per-session | the session factory, from `mcpServerFactory(identity)`, **before** `buildAgent` so it has clients to pass | the session factory, on dispose |

On the per-session path `buildAgent` receives clients (`SessionAgentParts.mcpClients`, unchanged) and therefore uses `withMcpClients`, **not** `withMcpServers` — otherwise `stop()` would run twice, once from `handle.close()` and once from the factory.

**Teardown: a new hook, not a moved one.** `onDispose` is documented to run *after* the session-RAG `closeSession` ("run during `SessionGraph.dispose()`, AFTER the session-RAG `closeSession`"), and `llm-agent-server-libs` closes its own session clients inside it. Moving that hook on one path only would make its position depend on an unrelated option — a contract no docstring can state truthfully.

So nothing moves. A distinct optional hook is added, and the factory's teardown reads in one line:

| step | what | when |
|---|---|---|
| 1 | `closePipeline?(sessionId)` — **new**, optional | before anything is deleted |
| 2 | `ragRegistry.closeSession(sessionId)` | unchanged |
| 3 | `onDispose?(sessionId)` | unchanged — still after `closeSession`, as documented |
| 4 | `stop()` on every server this factory started | last |

Why it is worth a hook: a pipeline still in flight must not write into a collection step 2 is deleting, and the clients must outlive the pipeline still calling them. A consumer that wants that guarantee moves its pipeline teardown into `closePipeline`; one that does not, changes nothing and keeps today's behaviour exactly.

This is deliberate. The repository has charged a major for a behaviour change on a kept path before (`fix!: a deleted RAG collection is gone`, #301, v26.0.0); this design does not repeat it, and offers the safer order as something to opt into.

**Slot counts on this path.** `mcpServerFactory` returns `IMcpServer[]`; `configuredSlotCount` is `undefined`, which means "nothing was filtered out", and the descriptor invariant then checks only uniqueness and count. A consumer that filters a configured set and needs the original positions keeps using `mcpClientFactoryWithDescriptors` until the major that removes it.

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

Every one of these is **optional and additive**: the credential sits beside the existing field, and a provider constructed the old way keeps working unchanged.

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

There is no separate collection-access contract: it is `AccessCheck<CollectionRequest>`. The consumer builds it once **per caller** and hands that object wherever it must be asked — the MCP server instance it constructs, and the RAG provider it obtains for that caller (`createFor`, §6.2). The provider has no rules of its own; it asks.

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

The axis stores a **policy value**, nothing more: whether *this* caller may delete *that* global collection is the check's decision, read from the value, never encoded in it. `RagCollectionScope` needs no new member: the earlier "fourth scope for roles" conflated the two axes. **Skills are an ordinary collection** under the same axes, not an exempt "configuration" kind — this supersedes cloud-llm-hub's collection-model spec, retired in hub commit `ae1e0e4b`.

### 6.2 Service or delegated identity

A credential on a RAG provider proves who **we** are to the store; it says nothing about the caller. Whether the store can judge the caller is a separate, typed, optional choice:

```ts
interface IServiceRagProviderSource {
  readonly identityMode: 'service';
  /** No caller, no check: one shared provider, and the framework judges nothing (§5). */
  create(): IRagProvider;
  /** A caller is known: a facade over that shared provider, with the check bound in. */
  createFor(identity: SessionGraphIdentity, check: AccessCheck<CollectionRequest>): IRagProvider;
}

interface IDelegatedRagProviderSource {
  readonly identityMode: 'delegated';
  /** The only way in: there is no service identity to fall back to. */
  createFor(identity: SessionGraphIdentity, check: AccessCheck<CollectionRequest>): IRagProvider;
}

type IRagProviderSource = IServiceRagProviderSource | IDelegatedRagProviderSource;
```

**Why the check is bound at construction, not passed per call.** `IRag.query` and `IRagEditor.upsert` already take a `CallOptions`, so the check could ride along — but an optional per-call argument is forgettable, and a forgotten one means "no judgement" under §5. That is the hub's `?? 'anonymous'` failure in a new place. Bound at construction, it cannot be omitted by a call site.

Under `identityMode: 'service'` that binding is a thin facade over one shared, service-credentialed provider — no extra connection, no pool per caller. Under `'delegated'` the provider behind it carries the caller's own credential. A consumer that supplies no check calls `create()` and gets exactly today's behaviour.

The mode decides **who must filter**: under `service` the consumer's check is the *only* line of defence; under `delegated` the store enforces too and the check is the second. A consumer that will not accept the first case types the seam as `IDelegatedRagProviderSource`, and a shared source does not compile there — the refusal is the consumer's, expressed in its own types, and the framework neither performs it nor prevents it.

Why two members rather than one interface with an optional `create()`: a delegated-only store — HANA reached with the caller's JWT — has **no** service identity, so a `create()` on it would have nothing honest to return. Throwing at runtime where a discriminant gives a compile error is the trade this design refuses.

| store | sees today | to see the caller |
|---|---|---|
| PostgreSQL | the service user of a shared `pg.Pool` | a connection per identity, or `SET LOCAL` in a transaction with RLS policies reading it |
| HANA | the `uid`/`pwd` from configuration | the caller's JWT — supported by HANA; **which client properties carry it is unverified** |
| Qdrant | the holder of one `api-key` | a claim-restricted token; our client sends only `api-key` — **unverified** |
| OpenAI, Anthropic, AI Core | the service, always | impossible — our users do not exist there |

Because `SessionGraphIdentity` types `createFor`, this interface lives in `@mcp-abap-adt/llm-agent-libs` beside the session factory unless that identity type moves into `@mcp-abap-adt/llm-agent` first (§9.3).

### 6.3 Scope and owner keys stay typed; only role and policy become opaque

A provider must not depend on whether authorization is a role, a tenant, a department or something we have not thought of. But the **owner keys are not that**: the framework itself reads them, to name a store and to end a session.

```ts
// simple-rag-registry.ts — the owner key IS the store's identity
const owner = scope === 'session' ? (sessionId ?? '')
            : scope === 'user'    ? (userId ?? '')
            : '';
sha256(JSON.stringify([scope, owner, collectionName])).slice(0, 12);
```

`closeSession` finds its collections by `meta.scope === 'session' && meta.sessionId === sessionId`. Hide `sessionId` in a blob and it goes blind; hide `userId` and every user's `user` collection of the same name collapses onto one store name `hash(scope, '', name)` — a cross-user leak, which is what issue #304 is about.

```ts
createCollection(name, {
  scope: RagCollectionScope;      // lifetime and addressing — typed
  sessionId?: string;             // owner key for scope 'session' — typed
  userId?: string;                // owner key for scope 'user' — typed
  attributes?: unknown;           // role and policy only — opaque, persisted, never interpreted
})
```

- Both owner keys stay typed. §6.1's "owner is implied by scope" needs a typed owner to read it from; only role and policy are opaque.
- **The provider persists `attributes`** and hands them back to the check. Today it persists nothing: pg and qdrant use the creation options only for `checkScope` and the id strategy, so a provider decides nothing after a restart or in a second instance.
- **This needs a catalog, not row metadata.** In pg a collection *is* a table, created per collection with `metadata JSONB` on each **row** (`schema.ts`) — there is nowhere to put a collection-level fact. Each provider therefore gains a small catalog of its own — `CREATE TABLE IF NOT EXISTS` in pg and HANA, and in Qdrant a catalog collection holding one point per collection (**unverified**: Qdrant exposes no collection-level metadata we have checked) — written on create and read on every decision. Additive: the catalog appears on first use.
- **A collection created before the catalog existed hands back `undefined`.** The provider does not invent attributes for it, and by §5 the check decides what an absent value means — the framework holds no opinion.
- `supportedScopes` keeps its meaning — what a provider can make *outlive* — which is lifetime, not permission.

Who writes `attributes`: the component that knows the caller — the tool handler from its `RagToolContext`, or the consumer calling `createCollection` directly. The registry passes them through and never invents them (§9.5).

### 6.4 Where the registry stands

`SimpleRagRegistry` is shared across per-session builds and receives providers through `setProviderRegistry` (`llm-agent-libs/src/builder.ts:855`); its own comment explains why some collections opt into idempotent registration. Anything obtained through `createFor` is bound to one caller — under `delegated` by its credential, under `service` by the check in its facade — and cannot be registered in a registry that outlives that caller. This is not a delegation problem: it is true of every checked path. Either the registry becomes per-caller, or it holds the `IRagProviderSource` and resolves per call — **open (§9.4)**.

---

## 7. One job, one contract: the logger

`@mcp-abap-adt/llm-agent` declares `ILogger { log(event: LogEvent) }` (10 event kinds, 22 non-test source files); `@mcp-abap-adt/interfaces-utils` declares `ILogger { info/warn/error/debug(message, meta?) }`. Same job, two contracts. The cost is not hypothetical: a consumer that already has a text logger cannot hand it to `withLogger` — it must first write an adapter that turns every call into a `LogEvent`. cloud-llm-hub simply declined to: it passes no logger to llm-agent at all, and its own `ILogger` imports come from `@mcp-abap-adt/connection` and `@mcp-abap-adt/interfaces`, not from here.

**What must not change.** `ILogger` is not only an input — llm-agent hands it **out**: `PipelineContext.logger` and `IPipelinePlugin` are typed by it, so a consumer's plugin calls `logger.log({ … })` on our type. Changing the shape of the exported name would break every such plugin, which is a major. So:

| seam | type | rule |
|---|---|---|
| exported `ILogger` | `{ log(event: LogEvent): void }` | **unchanged** |
| `ITextLogger` (re-exported `interfaces-utils` shape) | `info/warn/error/debug(message, meta?)` | new name, new import |
| input seams — `withLogger`, `SessionGraphFactoryOptions.logger`, `ConnectionStrategyOptions.logger`, embedder resilience, session lifecycle | `ILogger \| ITextLogger` | accept both, normalise at the boundary |
| output seams — `PipelineContext.logger`, `IPipelinePlugin` | `ILogger` | unchanged, so plugins keep compiling |

The import is types-only (`import type`), which keeps it out of the runtime graph — but a re-exported type must resolve in every consumer's `tsc`, so `@mcp-abap-adt/interfaces-utils` is a **regular dependency**, not a dev one.

**The residue, stated plainly.** This leaves llm-agent with two logger names — the very duplication §7 set out to remove. It is the price of not breaking anyone in this release: the convergence to one name is a rename, and a rename is a major (§9.9). The mapping below is what the boundary does when an `ITextLogger` is supplied; `LogEvent` stays and remains the payload.

| rule | value |
|---|---|
| message | `event.type`, except `warning`, where it is `event.message` |
| meta | the whole `event` |
| `pipeline_error` | `error` |
| `warning` | `warn` |
| `rag_upsert`, `rag_query`, `tools_selected` | `debug` |
| everything else | `info` |

The text shape is the general one: a structured event fits in `meta`, a closed union cannot carry arbitrary text. `interfaces-utils` needs no change, and this release is a minor: the rename that finally leaves one name, when it comes, is llm-agent's major (§9.9).

---

## 8. What changes, and where

| package | change | breaking |
|---|---|---|
| `@mcp-abap-adt/llm-agent` | `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated as a consumer seam; `attributes` on collection creation; `ITextLogger` re-exported from `interfaces-utils`, **exported `ILogger` unchanged** | additive — nothing a consumer implements or receives changes |
| `@mcp-abap-adt/llm-agent-libs` | `withMcpServers` on the builder; start in `build()`, `stop()` into `closeFns`; optional `mcpServerFactory` on the session factory; `IRagProviderSource`; registry wiring (§9.4) | additive |
| `@mcp-abap-adt/llm-agent-server-libs` | consumes the builder seam; `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` deprecated, not deleted | additive |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`; `IMcpServer` implementations for stdio and http | additive |
| `llm-agent-rag`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | optional credentials in constructors; persist `attributes`; ask the check when given one | additive |
| LLM and embedder providers | credential contracts beside `apiKey?: string`, keeping the AI Core env fallback (§9.2) | additive |
| `@mcp-abap-adt/interfaces-auth` | gains `AccessCheck` and, subject to §4, the three credential contracts | minor |
| cloud-llm-hub, `llm-agent-server` | **may** adopt the seams; neither is required to | their own work |

**Release shape: a minor.** Nothing is removed, nothing a consumer implements or receives changes shape, no existing path changes behaviour, and every seam is declinable — including the safer teardown order, which arrives as the optional `closePipeline` hook (§3.4). The deprecations — `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` — are markers for a later major, not part of this one. `McpClientFactory` is a special case: it stays as the default implementation's factory, which `mcpServerFromFactory` consumes, and is deprecated only as the **consumer-facing** seam.

---

## 9. Open questions

1. **HANA and Qdrant delegation.** Which `@sap/hana-client` properties carry a JWT; whether our Qdrant version supports claim-restricted tokens (§6.2).
2. **SAP AI Core.** Whether the SDK accepts a token source at all; if not, `IBearerCredential` cannot be mandatory there and the `AICORE_SERVICE_KEY` fallback stays.
3. **`SessionGraphIdentity`'s home** — `llm-agent-libs` today; moving it into `@mcp-abap-adt/llm-agent` lets `IRagProviderSource` sit with the other contracts.
4. **The registry and `createFor`** — a provider obtained for one caller cannot live in a registry that outlives it. Per-caller registry, or a shared registry holding the `IRagProviderSource` and resolving per call (§6.4).
5. **Who writes `attributes` at creation** — tool handler, consumer, or both; and the final signatures of `IRagRegistry.createCollection` / `IRagProvider.createCollection` (§6.3).
6. **An optional marker on authenticated clients.** A seam *may* declare that it accepts only clients a factory produced, making "forgot the caller's credentials" a compile error. It must stay opt-in: mandatory, it would dictate policy. Precedent for the risk: cloud-llm-hub PR #236 (`fix(security): stop caching MCP tool results across callers`, open) — a `ToolCache` shared by every caller returned one user's ABAP result to another within 30 s, below the role check and below their own SAP connection.
7. **`buildRagCollectionToolEntries`** — mounted by a consumer, or deleted.
8. **The server's YAML `mcp:` block.** Injection already outranks it. It belongs to the `llm-agent-server` assembly, not to the library — but stdio genuinely requires spawning, so "the library never starts anything" is not an option.
9. **One logger name, at the next major.** This release keeps `ILogger` (the event sink, handed out through `PipelineContext` and `IPipelinePlugin`) and adds `ITextLogger`. Converging them means renaming what consumers' plugins are typed by, which breaks them — so it is a major, scheduled, not silently deferred. Until then llm-agent carries two names for one job, and §7's own argument stands against it.

---

## 10. Workstreams

Four independent changes under one umbrella; each gets its own plan. All four are additive, so they land as a minor — in any order, and a consumer may take one and decline the rest.

1. **MCP lifetime and identity** — `IMcpServer`, `withMcpServers`, optional `mcpServerFactory`, the optional `closePipeline` hook with `stop()` last (§3.4), stdio `env`.
2. **Credential contracts** — write them where §4 settles, adopt them beside the existing fields.
3. **RAG identity and attributes** — `IRagProviderSource`, persisted opaque attributes, the two axes, registry wiring.
4. **Text-logger acceptance** — `ITextLogger`, the boundary adapter and its levels (§7). Convergence to one name is deferred to the next major (§9.9).

---

## 11. Out of scope

- Writing any contract before a package accepts it (decision 11).
- Any consumer's implementation: cloud-llm-hub's per-session graph and XSUAA-backed check, and `llm-agent-server`'s configuration, are theirs.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
