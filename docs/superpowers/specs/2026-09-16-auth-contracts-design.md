# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review round 8 · **Date:** 2026-09-16 · **Base:** `main` at `bd5c464c` (v26.0.0)

## TL;DR

- **This is a framework, not an application.** Every seam below is **offered**; a consumer may decline it and keep what it has. Nothing here decides policy on anyone's behalf.
- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **Admission is the consumer's, and none of it is ours.** Every provider here is a *client* of an outside service; a client proves who it is and judges nobody, because nothing calls it. So there is no authorization at request time anywhere in this framework and no access-check contract in it — a deliberate limit on what we build, not a gap to fill (§1.4, §5).
- **MCP lifetime and identity are today app-local glue**, written once in `llm-agent-server-libs` and differently in cloud-llm-hub. The seam moves to `SmartAgentBuilder`, where every assembly already passes.
- **Collections have two axes**: `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Scope and the owner keys stay typed; only role and policy become opaque.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- **Two kinds of change, kept apart: optional capabilities a consumer may decline, and a contract migration it may not.** The *capabilities* are optional seams — `IMcpServer`/`withMcpServers`, `ragRegistryFactory`, the RAG catalog's read members, `closePipeline` (the safer teardown order arrives through that new hook rather than a changed one, §3.4) — and declining one keeps today's path; among those, no existing path changes behaviour by itself **with one exception, named because a blanket claim that is false once is worse than a qualified one**: the plugin loader begins **reporting** a malformed export it used to skip in silence, and refuses a plugin whose `name` differs from the key it is registered under (§4.6.7), so a deployment that has been running without a pipeline it thought it had will now be told. **What does break**, all of it deliberate and all of it in §8's migration note: §4.6.2 removes `apiKey` from `LLMProviderConfig` and `EmbedderFactoryConfig`, removes `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` from `llm-agent-libs`, strips the secret fields from `SmartServerLlmConfig` and **deletes** the unread legacy `PipelineLlmProviderConfig` and `PipelineRagStoreConfig`, stops the SAP providers reading `AICORE_SERVICE_KEY` (a new `sap-aicore-auth` package holds the exchange instead), and makes a connection string carrying credentials a construction-time error; §4.6.3 makes `BuildAgentDeps.makeLlm`, `resolveEmbedder` and `makeRag` **required**, so passing `{}` as `deps` stops compiling; §4.6.4 **splits** `SmartServerRagConfig` into `store` and `embedder`, each with its own `credentialRef`, and adds `makeRag` to `BuildAgentDeps`; §4.6.6 removes `makeLlm`, `llmMap` and `pipelineFallback` from `IServerPipelineContext` and `makeLlm(lc)` from `IRoleLlmResolver`, and §4.6.7 adds a **required** `resolveNamedLlm(key)` to `IPipelineContext` — the strict lookup for a key a file named — so every implementation of that contract must add it, leaving the framework's own `resolveLlm(role)` — with the strict `resolveNamedLlm(key)` beside it — as the only way in — a usage-side contract may not construct; §4.6.7 removes `IPipelinePlugin.parseConfig` and the `config` parameter of `build` — configuration is read only by the server that assembles the pipeline, a plugin is constructed with typed settings that name each role's model by key and resolves the instance through `ctx`, `controller`'s `subagents.<role>` and a DAG worker's own config file name an `llm:` key instead of holding an LLM configuration, and a configurable dynamic plugin exports a **factory** rather than an instance; §5.1 removes `RagToolContext`'s declared `sessionId?`/`userId?` and requires `identity` on `buildRagCollectionToolEntries`; §6.3 has the shipped stores keep a catalog on their existing create and delete paths — extra backend writes, the rights to make them, `CatalogRecordDeleteError` as a new failure of `deleteCollection`, a refusal to create a collection that exists — so re-creating a collection at startup no longer reattaches it, and an assembly that relied on that must hydrate — and one probe embedding per Qdrant collection created, whether or not a consumer calls any new member; §6.4 keys a registry by scope and name, so a name held in several scopes must be addressed with its scope, keys user and session collections in `ragStores` as `user/<name>`/`session/<name>`, and reserves those prefixes for global names; §7 widens six readable option properties. `IModelResolver`, `ILogger` and every contract not named above keep their shape. What version carries the set is §10's to state — it is a major.
- Umbrella: four workstreams (§10), **one plan**, and **one PR per repository**. Two of the four are already merged; the rest land together.

---

## 1. The framework's position

`@mcp-abap-adt/llm-agent` is a framework for assembling agents and pipelines of arbitrary shape. It does not know who assembles them: `llm-agent-server` is one assembly, cloud-llm-hub is another, and the next one is unknown. **It offers capabilities and adapts to nobody.**

Three rules follow, and every section below is bound by them:

1. **Declinable.** A new seam left unused changes nothing. No credential is mandatory, no access check is mandatory, no lifetime contract is mandatory.
2. **No default policy.** Where the framework cannot know the answer, it holds no opinion — it does not invent one. An absent access check means the framework does not judge, not that it permits on someone's behalf.
3. **No privileged topology.** Per-session, shared, single-user, multi-tenant — all are assemblies, and none is the reference.
4. **We build the client side, and only it.** Every provider here — LLM, embedder, RAG store, foreign MCP — is a *client* of something outside. A client proves who it is; it does not judge who is calling it, because nothing calls it. So there is **no authorization at request time anywhere in this framework**, and nothing in it wraps a server. This is a deliberate limit on what we build rather than a gap to fill later: the assembly that faces users — cloud-llm-hub, `llm-agent-server` — is the server, and admission is its job (§5).

Before this design the framework imported nothing from `@mcp-abap-adt/interfaces*` and declared its own `ILogger` and `IMcpRequestHeadersStrategy`. Where that changes below, the imports are **types-only** (`import type`, so nothing enters the runtime graph) though the package is still a regular dependency, and the contracts are plain shapes with `kind` literals, so a consumer can satisfy them without importing anything.

---

## 2. The two jobs

| job | question | contract | supplied by |
|---|---|---|---|
| **A — prove who we are** | how do we authenticate to OpenAI / AI Core / Qdrant / PostgreSQL / HANA / a foreign MCP? | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | whoever constructs the concrete implementation |
| **B — decide what the caller may do** | may *this* caller use that tool, read that collection, delete it? | **none of ours** — the consumer's own (§5) | the consumer, and it stays there |

**Both jobs are named here; only job A is ours.** Job B is in the table because leaving it out would suggest the framework has an opinion about admission, and §1.2 says it must not. Naming it and then declining it is the honest form.

**Data isolation is not a third job either, and it is not job B in disguise.** A store is isolated by what its collections are *named* — scope plus the typed owner keys, which the framework reads to address a store and to end a session (§6.3). That is addressing, not permission, and it works with no check anywhere: it is why llm-agent can close issue #304 without owning job B.

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

One implementation per way of starting: **stdio** spawns a child; **http** owns a connection; **embedded** runs in-process.

**The name says what it manages, not what we are.** An `IMcpServer` is our handle on a server’s *lifetime* — one we spawn, or one already running that we only connect to. Every member is a client’s: start a connection, hand back an `IMcpClient`, release it. Nothing here serves a request, so §1.4 holds even for a contract with `Server` in its name.

**http is the main protocol; stdio is the local case.** Only stdio actually *spawns* anything — a developer machine, or a server this process genuinely must launch itself. For http, `start()` means acquiring and holding a connection to a server that is already running elsewhere, and `stop()` means releasing it; nothing is spawned, and `env` is irrelevant. Workstream 1's concrete work (§3.5, the stdio `env`) therefore served the narrower case, and the ordering for workstream 2 is the reverse of the order these were written in: the typed **http** implementation lands first, because that is what deployments use, with the typed stdio one beside it for local work. The credential a target needs is demanded by **that implementation's own constructor**, typed per target — which is what a bare `McpClientFactory` cannot express **in its type**: a closure can capture a credential, but its single parameter is a generic `McpConnectionConfig`, so nothing in the signature says which credential this target needs.

**“Asked on each use” means on each *connect* here, and that is a real boundary.** §4 makes every secret a function so the acceptor never holds a stale one, and every other acceptor in this design can honour that per request. An http MCP connection cannot: `IMcpRequestHeadersStrategy.headers()` returns `Record<string, string>` **synchronously** (`llm-agent/src/interfaces/mcp-request-headers-strategy.ts:7`) and `buildHttpTransportOptions` merges its result into `requestInit` at connect (`llm-agent-mcp/src/client.ts:194-209`). So the credential is resolved once per connection, and a long-lived connection carries the token it connected with.

That is consistent rather than a hole: `start()` acquires a connection, the credential is a constructor argument (§4.1), and refreshing means reconnecting — which is `IMcpConnectionStrategy`'s job, stated just below. A consumer whose token outlives no connection reconnects; one who needs per-request rotation is asking for `headers()` to be asynchronous, which would break every consumer that implements the strategy and is not in this release. Recorded because a reader who takes “per use” literally across every acceptor would be wrong about exactly one of them.

`start()` is called once per instance; **reconnection stays with `IMcpConnectionStrategy`**, which already owns outage handling, `toolsChanged` and revectorization. An implementation that cannot be restarted after `stop()` throws; the framework never restarts one on its own.

### 3.4 Where the seam lives

Every assembly passes through `SmartAgentBuilder`, so the seam is there:

```ts
builder.withMcpServers(servers: IMcpServer[]): this;   // beside withMcpClients, never replacing it
```

`build()` starts them, pushes each `stop()` into the `closeFns` the handle already awaits, and pairs descriptors. `SessionGraphFactory` and `llm-agent-server-libs` become **consumers** of that seam rather than owners of their own glue; cloud-llm-hub may adopt it without adopting `SessionGraphFactory`. An optional `mcpServerFactory?: (identity) => IMcpServer[]` on the session factory gives the per-session case the identity that `buildPerSessionMcpClients` never had.

Nothing is removed by **workstream 1**, and nothing on an existing path changes behaviour; what version the whole set ships as is §10's (§8). (Workstream 3 does remove two declared properties — §5.1.) `withMcpClients`, `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient` and `closeBySession` are marked deprecated and live at least until the **next** major, with the new seam taking precedence when set — the same courtesy `mcpClientFactoryWithDescriptors` received in #244. A consumer that declines the seam keeps exactly today's behaviour.

**Descriptors.** They come from `IMcpServer.descriptor`, and the existing invariant holds unchanged (`assert-client-descriptors.ts`): descriptors are **all or none** (their count must equal the client count), `slotIndex` values are unique non-negative integers, and `configuredSlotCount`, when given, must be **strictly greater than the largest `slotIndex`**. When no server carries a descriptor, array position is the pairing, exactly as today.

**Ownership: exactly one owner per server.** A started server is stopped by whoever started it, and the two paths never overlap:

| path | starts | stops | if construction fails in between |
|---|---|---|---|
| builder | `build()`, from `withMcpServers` | `handle.close()`, through the `closeFns` it already awaits | `build()` itself — no handle is returned, so nobody else can: it stops everything it started and rethrows the original error |
| per-session | the session factory, from `mcpServerFactory(identity)`, **before** `buildAgent` so it has clients to pass | the session factory, on dispose | the session factory itself — no `SessionGraph` is constructed, so `dispose` never runs and the started servers are unreachable |

On the per-session path `buildAgent` receives clients (`SessionAgentParts.mcpClients`, unchanged) and therefore uses `withMcpClients`, **not** `withMcpServers` — otherwise `stop()` would run twice, once from `handle.close()` and once from the factory.

**The third column is the one that bites.** The first two describe the happy path, where an owner exists; the leaks live in the interval *between* `start()` and that owner. Workstream 1 shipped with it, and the whole-branch review found three separate defects there: `buildAgent` throwing after the servers were started, the builder's much larger window from its start loop to its `return`, and — reported by a human reviewer after the automated ones had passed — `handle.close()` abandoning the remaining servers once one `stop()` rejected. Each was invisible to the tests because every test built successfully.

So an owner is only defined once the interval is closed. Whoever starts a batch owns it from the first `start()` until the object that will own it exists; a failure anywhere in that span stops the whole batch and rethrows the original error, and routine teardown reaches every closer regardless of what any individual one does. Both are best served by one shared unwind helper rather than a copy per path — two copies drift, and in workstream 1 they did: the session factory preserved the original error while the builder masked it.

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

**What a contract is, and where it stops.** A contract states how a consumer hands its choice over as a parameter, and how the accepting side uses what it got. Nothing else belongs in one. Everything the implementation can hide, it must hide — how the material was obtained, when it expires, which header carries it, whether the far side is reached over HTTP or a database wire. A contract that describes any of that has stopped being a vocabulary and started being one implementation wearing an interface, and the next implementation will not fit it.

This is the test applied throughout §4: each member below is either something the consumer must supply or something the acceptor must read. A member that is neither is a leak, however true it happens to be of the code we have today.

`IApiKeyCredential { kind: 'api-key'; secret() }`, `IBearerCredential { kind: 'bearer'; token() }`, `ISecretLoginCredential { kind: 'secret-login'; principal; secret() }`. A contract never says whether the secret is a static password, a rotated key or a fresh token. The `kind` literal is what makes the check real — though not for the reason first written here: api-key and bearer do differ in their members (`secret()` against `token()`). The overlap is between secret-login and api-key, since a secret login carries everything a key asks for and its extra `principal` does not get in the way; without the literal it satisfies the key contract outright. The literal is also what lets an acceptor narrow a union to one protocol.

| seam | today | contract |
|---|---|---|
| `LLMProviderConfig.apiKey?: string` (`llm-agent/src/types.ts:78`) | a string on the **shared base** every provider config extends, with a comment admitting it cannot describe SAP AI Core | **removed, and nothing replaces it here** — a shared base can only type the *union* of every provider's credential, and per-target typing is the point (§4.6.2) |
| `EmbedderFactoryConfig.apiKey?: string` | a second key seam, and one the **framework** carries to a consumer's factory | **removed** — the factory is the consumer's code and closes over its own credential (§4.6.2) |
| `sap-aicore-llm`, `sap-aicore-embedder` | `clientId` + `clientSecret`, **or** an `AICORE_SERVICE_KEY` env fallback read inside the provider — two sources, so a precedence rule | `IBearerCredential` — confirmed viable, §9.2: a constructed destination's `headers.Authorization`, rebuilt per call for freshness; the `foundation-models` embedder swaps its own `TokenProvider` instead |
| `qdrant-rag` | `url` + `apiKey?: string` | `IApiKeyCredential` |
| `pg-vector-rag`, `hana-vector-rag` | `host`/`port`/`user`/`password`/`database`, **or** `connectionString` | `ISecretLoginCredential` |
| an http MCP implementation | `headers` | whatever its server speaks |

Every one of these **replaces** the field beside it rather than joining it (§4.6.2): a plain key is one way of *obtaining* what an acceptor needs, not the thing itself, so carrying both would make “did this object get authorized?” a question with two answers. `staticApiKey` / `staticLogin` convert a call site in one line, and §8 carries the migration.

### 4.1 The unit is the pipeline, so the credential goes in the constructor

This is a framework for assembling **pipelines**, not servers (§1). One pipeline holds its own instances — as many as it needs — and whoever assembles it decides what goes in, including whether an instance is fresh or one it already had.

**Construction is the authorization, and nothing after it is.** Once an instance exists it is authorized; every method on the contract is then only the job — `embed(texts)`, `chat(messages)`, `query(text)` — and carries no secret, no key, no token and no auth options. That is what makes “did this object get authorized?” a single question with a single answer, asked once, where it can still be refused. A config with two sources, or a method with an optional credential, turns it into a question with several answers and forces precedence rules to settle them (§4.6.2).

**A new pipeline does not mean new instances of everything,** and reading it that way would install the privileged topology §1 forbids. It means the pipeline is constructed, and each provider in it is whatever the assembler passed. Which of the two that is follows from §4.2:

- **Transparent** — the credential is a caller’s, so the instance holding it is **caller-scoped by necessity**: sharing it would hand one caller’s credential to another.
- **Opaque** — the credential is the service’s, so an instance **may be shared** across pipelines and simply handed to the new one. The server’s cached per-worker LLM and embedder are correct here, and no plan should replace them with per-user instances to satisfy a rule that does not exist.

Either way the credential for that pipeline is simply what its providers were constructed with.

So the credential is a **constructor** argument, and three consequences follow:

- **The pipeline-facing contracts do not change.** `ILlm`, `IEmbedder` and `IRagProvider` say nothing about authentication today and must keep saying nothing. A consumer works with a provider without knowing how it authenticates.
- **`CallOptions` never carries a credential.** It carries *identity* — `sessionId`, `userId`, `ragFilter.userId`, which answer "who is asking" — and that is a different question from "what proves we may". An optional per-call credential is forgettable, and a forgotten one does not fail: the call proceeds with the instance's credential, which is someone else's. That is the `?? 'anonymous'` failure of cloud-llm-hub in a new place, and the `ToolCache` incident (hub PR #236) is what it costs.
- **The provider declares which credentials it accepts, as a union.** The constructor's parameter type is the filter: a credential for another protocol does not compile. A database speaking several protocols accepts one union member per protocol, and the branch that knows *where* the material goes — `uid`/`pwd` here, a header there — is inside the implementation and invisible from outside.

`llm-agent-mcp` already has this shape: a server per session is the ordinary case, and its credential is demanded by that implementation's own constructor (§3.3). The rest of the providers are being brought to the same shape, not given a new one.

### 4.2 Whose credential is not a property of the contract

The same contract carries either owner. `IBearerCredential` is `IBearerCredential` whether the token is the service's or an end user's: an end user's token means a provider built per session with that user's credential — the same shape as an MCP server per session, and the contract does not change.

What differs is what the far side sees, and that is the assembler's choice, made **per provider**:

| | transparent | opaque |
|---|---|---|
| what travels outward | the **caller's** credential | **our** credential |
| what the far side sees | every consumer of our service | only our service |
| who judges the caller | the far side — its quotas, its audit, its access control | only us, and if we do not, nobody does |
| how consumers are kept apart | not our job | the consumer's job B, decided from the identity and collection scope we keep for it (§5, §6.3) |

**And the choice is not always there to make.** §6.2’s table says which far sides can see a caller at all: PostgreSQL and HANA can, Qdrant probably can, and for OpenAI, Anthropic and AI Core it is *impossible* — our users do not exist there, so those are opaque by nature and not by decision. Transparent is a choice only where the far side has somewhere to put a caller.

cloud-llm-hub is both at once, which is why this cannot be one global setting: `x-sap-login`/`x-sap-password` per request reach ABAP (`srv/mcp-manager.ts:88`), so SAP sees each user; the LLM runs on `AICORE_SERVICE_KEY` (`srv/agent-config.ts:291`), so AI Core sees only the hub.

**A shared instance is legal in the opaque case and illegal in the transparent one.** The server's cached per-worker LLM and embedder are correct while the credential is the service's, and wrong the moment it is a caller's — which is the assembler's call to make, and exactly why §1 forbids the framework from having an opinion about topology.

### 4.3 The boundary: not every authentication reduces to a secret

A credential contract can exist only where authentication reduces to **material handed over**, with the acceptor needing to know nothing but where to put it. Three common methods do not reduce:

- **request signing** (SigV4, HMAC) — the secret never travels; it signs. "Give me the secret" would force the acceptor to implement the algorithm, which is precisely the knowledge a credential contract exists to keep out of it.
- **mutual TLS** — the material lives in the handshake, which is why `IAuthProvider` answers with `transportMaterial()` rather than a secret.
- **SPNEGO/Kerberos** — a negotiation, and its token is consumed by the request that carried it.

This is not speculation: `@mcp-abap-adt/interfaces` tried and withdrew it. `ICredentialOwningItsFetch` and `ICredentialTransport` existed for the one-shot case and **were removed in 21.0.0, having never been implemented** — such a credential "needs either an exchange it owns end to end, or a signal that the establishing request succeeded".

So the test for a new `kind` is not "is this a different protocol" but: **can the acceptor use it knowing only "here is the material"?** If it cannot, the shape is not a credential but a provider — `IAuthProvider`'s `prepare()` / `authorizationHeader()` / `cookies()` / `transportMaterial()`, already in `interfaces-auth` for exactly this class.

### 4.4 Where they live

This section, the rule above and §4.5 were `mcp-abap-adt-interfaces`' own credential spec until 2026-09-20. One design described in two repositories drifted — the same claim was stated two ways and one open question was answered in one copy and not the other — so the design lives here alone, and that repository keeps only what is about its own shape (`docs/architecture/DECISIONS.md`).

Two decisions of `mcp-abap-adt-interfaces` settle placement, and since 2026-09-23 they answer different questions. **Decision 26** — a contract lives where it is accepted — now decides only *whether* a contract belongs in that repository at all: one accepting package keeps its own. **Decision 35** decides *which package*, by reading the contract itself: it lives in the package whose subject its own fields name. It replaced 26 for that question because authentication broke the acceptor reading — one package accepting both a token contract and an SAP configuration put both in `interfaces-adt`. (Decision 34, the same day, retired the `@mcp-abap-adt/interfaces` facade: it forwards nothing and is deleted rather than shipped empty, so a consumer names the leaf packages.)

- `AccessCheck<R>` **does not go to `interfaces-auth`.** Decision 26 named llm-agent and the hub as its two acceptors, and that was true of an earlier draft of this design. §1.4 removes llm-agent as an acceptor, which leaves one — the hub — and a single acceptor keeps its own contract (§5). This is decision 26's remaining question, so 35 does not reopen it.
- The three credential contracts go to `interfaces-auth`, and that no longer waits on a second acceptor. By decision 35 the placement follows from their fields — a secret, a token, a user and a password, none of them SAP's — so they are `-auth` and not `-auth-sap`, which holds what names an SAP client, a service URL or a BTP service. `@mcp-abap-adt/connection` has not rebuilt `BasicAuthProvider`/`TokenAuthProvider` on them: at 9.2.1 it has moved off the facade to the leaf packages (`interfaces-auth` ^1.2.0 among them) and still implements `IAuthProvider` and `IRenewableCredential` directly (`src/auth/providers.ts:23`, `:61`), importing none of the three. That is not a reason to move the contracts: a contract is a shared vocabulary, and whoever needs an implementation writes one — this family, `connection` later if it chooses, or a consumer with a credential source neither of us anticipated. That is what strategies and injection are for, and it is why the contract must not live where only one implementation happens to live today.

**When a contract may be written.** Decision 11 asks who calls a thing, and refuses members added for symmetry — it does not require the acceptor to exist first, and an earlier draft of this design said it did. That reading is unsatisfiable here: the acceptors are separately published packages, and none of them can declare a dependency on a contract that has not been published. So the rule is: a contract may be written once a concrete accepting change has been **specified and checked against the acceptor's actual API**; `interfaces-auth` is published first, and the acceptor then adopts that published version. Demand is still evidenced — by the specified acceptor, not by an impossible ordering.

### 4.5 Vector stores, concretely

A vector-store provider accepts the contracts for the protocols its database speaks. PostgreSQL has one for this purpose: a user name and a password message. A static password and an Azure Entra ID token both travel in it, so for `pg-vector-rag` they are **one contract**, and which of the two sits behind it is invisible to the provider.

```ts
new PgVectorRagProvider({ host, database, credential }); // credential: ISecretLoginCredential
// inside: { user: credential.principal, password: () => credential.secret() }

// built by whoever owns the secret
const byPassword = { kind: 'secret-login', principal: 'rag_svc', secret: async () => process.env.PG_PASSWORD! };
const byEntra    = { kind: 'secret-login', principal: 'rag-app@contoso', secret: () => entra.getToken() };
```

- **Principal is required.** `pg` falls back to the environment (`PGUSER`, then the OS user) when `user` is missing; with the principal inside the credential there is no such fallback, and no connection under the wrong identity.
- **Fresh secret per connection.** `pg` 8.23.0 accepts `password` as a function, possibly async, and calls it for each new connection (`Client._getPassword`), so each new pooled connection gets a current token. That is `secret()` being a function rather than a field, paying off without the provider doing anything.
- **The token source stays outside.** The database package depends on no auth provider; an adapter over an existing token provider is one line: `secret: async () => (await provider.getTokens()).authorizationToken`.

Admission, placement and ownership are §4.1, §4.4 and §4.2; they are not restated here.

What each database speaks, as checked on 2026-09-15:

| package | accepts today | the database also supports | contracts to accept |
|---|---|---|---|
| `pg-vector-rag` | connection string, or host/port/user/password/database | a token in the password message (Azure Entra ID) — the same protocol | `ISecretLoginCredential` |
| `hana-vector-rag` | user and password (`uid`/`pwd`), both required | JWT, SAML, X.509 (SAP HANA Cloud; the `@sap/hana-client` 2.29.27 changelog mentions all three) — separate mechanisms, each needing §4.3's test before it earns a `kind` | `ISecretLoginCredential` now; more once the client's connection properties are read (§9.1) |

### 4.6 The three that blocked a plan, and what settled them

   **Every change to a contract in this section carries its argument, and that is a requirement rather than a courtesy.** "Otherwise the configured path does not work" describes a difficulty, not a justification — and a contract changed without one is a contract the next reader cannot defend or revert. Several of the decisions below were reversed once precisely because the first version had only a difficulty behind it, and each now states what it buys, what it costs and what was rejected. If a member cannot be argued for in one sentence, it is not ready to be added.

Each was measured in the packages on 2026-09-20, not reasoned about. Two of the three turned out to be additive, which the earlier wording of this section and of §8 denied.

1. **Passwords in connection strings: additive, and nothing needs forbidding.** The worry assumed a credential has to displace the connection string. It does not, because the code that reads either one is not public. `resolvePgConnectArgs` and `resolveHanaConnectArgs` are absent from their package barrels — `index.ts` exports only the config type and the class — and both packages declare a **closed `exports` map with only `"."`**, so `dist/connection.js` ships in `files` but Node refuses the subpath. Each resolver has exactly one production caller and it is **already `async`**: `private async createDriverClient` (`pg-vector-rag.ts:62`, `hana-vector-rag.ts:54`). Awaiting `secret()` there costs no signature anyone can see, and the config interfaces gain one optional property.

   **Precedence looked like the next question and turned out to be the wrong one.** Two drafts of this item ranked the sources, because the two packages disagree with each other: in `pg`, `if (cfg.connectionString) return { connectionString, … }` is an early return, so discrete `user`/`password` are ignored outright (`connection.ts:31-37`), while in `hana` `??=` lets the connection string fill only the gaps, so the discrete fields win (`connection.ts:33-40`). A credential dropped into each would silently inherit opposite precedence from its neighbour, so a rule seemed necessary.

   **It is not, because §4.6.2 leaves one source.** Ranking is only ever needed where a config carries several, and “did this object get authorized?” should have one answer. So the discrete `user`/`password` go, the **connection string carries the address only**, and a string with credentials in it is **refused at construction** — loudly, with the `staticLogin` fix in the message — rather than silently losing to the credential. The disagreement between the two packages disappears with the fields that caused it, which is a better outcome than reconciling it.
    **Whether that one source is required is decided per target, and the answer differs.** A credential being optional is not politeness — it is the statement that this target has a working configuration without one, and each of the three had to be read rather than assumed. **Qdrant**: optional, because an unauthenticated Qdrant is a real deployment. **PostgreSQL**: optional, because trust authentication and the driver's own `PGUSER`/`PGPASSWORD` environment are paths the resolver must not refuse. **HANA**: **required**, and an earlier ruling of mine that made all three optional was wrong here — `resolveHanaConnectArgs` throws unconditionally when the login does not resolve, so optionality rescues no configuration that works after this change; the only credential-free-looking HANA config was a connection string with credentials embedded, which this section closes. Optional there buys nothing and costs the thing §5 values most: it moves a mistake from the compiler to a connect-time throw. Required where no credential-free configuration exists, optional where one does.

    **And "asked per use" has to be true of the driver, not merely of our code.** Qdrant asks the credential inside each request's header assembly, so rotation works. HANA resolves once per instance, which is once per connection there. **PostgreSQL is the one that needed care**: a resolved string baked into a `pg.Pool` config is reused for every physical connection the pool ever opens, so a rotating credential would be frozen for the pool's lifetime and fail after the original secret's TTL — a defect no test would show under a static key. `pg` takes `password` as a function (`password?: string | (() => string | Promise<string>)`, evaluated per client in `pg/lib/client.js`), so the credential is handed over **as** that function and each new connection asks again. A contract whose secret is a function is only honoured if the layer underneath is given the function too.

   What the measurement above still buys: because both resolvers are internal and unreachable, and their only caller is already `async`, none of this is visible in either package's public surface beyond the config type itself.

2. **The property: there is none, because a contract does not carry a credential at all.** Two earlier drafts of this item argued about *how* to put a secret in a config — widen `apiKey` or add a field beside it, then deprecate the old one. Both answered the wrong question.

   **Construction is the authorization.** A credential is a constructor argument, and a constructor is not part of an interface. Once the object exists it is authorized, and every method on the contract is just the job — `embed(texts)`, `chat(messages)`, `query(text)` — needing no secret and nothing else auth-shaped. So the credential is read by exactly one thing, the **concrete implementation**, and read nowhere a contract can see.

   **This is a requirement, not a conclusion reached here.** *A secret belongs in a contract only where the secret **is** the contract — its subject, not an auxiliary parameter.* Recorded as binding principle 9 in `docs/ARCHITECTURE.md`; what follows is its application. Three earlier drafts of this item each re-derived the rule and each landed somewhere different — widen the field, add one beside it, put it on the shared base — and a fourth stated it as a blanket “no secrets in a provider contract”, which would have forbidden `IApiKeyCredential` itself.

   **The test is to remove the secret and see what is left.** Take `secret()` out of `IApiKeyCredential` and nothing remains: the secret was the whole subject, which is why §4's three contracts are the right home for one and may speak of tokens and headers freely. Take `apiKey` out of `LLMProviderConfig` and a complete LLM configuration remains — model, temperature, base URL, throttling. There it was a **passenger** on a contract about something else, and that is the position it may never hold.

   **Where the credential goes is decided by what is being constructed, and by nothing else.** An earlier draft of this item drew the line at “core versus concrete package” and got two types wrong in opposite directions. The line that holds:

   | type | what it actually is | today | after |
   |---|---|---|---|
   | a concrete provider's own config (`OpenAIConfig`, `SapCoreAIConfig`, `QdrantRagConfig`, `PgVectorRagConfig`, …) | that implementation's constructor | `apiKey: string`, `user`/`password`, the SAP object | **`credential`, typed for what that target speaks** |
   | `LLMProviderConfig` (`llm-agent/src/types.ts:78`) | the **shared base** those configs extend — `OpenAIConfig extends LLMProviderConfig`, likewise Anthropic, DeepSeek, Ollama and SapCoreAI | `apiKey?: string` | **nothing** — see the paragraph after this table |
   | `EmbedderFactoryConfig` (`interfaces/rag.ts:20`) | an object the **framework hands to a consumer's factory** | `apiKey?: string` | **nothing** — see below |
   | `MakeLlmConfig` (`llm-agent-libs/src/providers.ts:27`, exported) | the argument of a convenience that dispatches on `provider` and constructs one of five | `apiKey?: string` **and** `credentials?: SapAICoreCredentials` | **the type is removed entirely**, with `makeLlm` — an earlier draft of this cell said “both fields removed, the rest remains”, which contradicted the decision below it |

   **Why the shared base gets nothing, though it is reached through a constructor.** Putting one `credential` on `LLMProviderConfig` would have to type it as the *union* of every provider's credential — and then `OpenAIConfig` accepts an `ISecretLoginCredential` it cannot use, `SapCoreAIConfig` accepts an api key it has no place for, and the compiler stops being able to say which credential a target actually needs. That is exactly the loss §3.3 holds against `McpClientFactory`: “the credential a target needs is demanded by **that implementation's own constructor**, typed per target — which is what a bare factory cannot express in its type.” A shared base is a bare factory's twin. So the base keeps the fields that really are common — `model`, `temperature`, `maxTokens`, `baseURL`, `whenThrottled` — and each concrete config declares its own credential.

   **`makeLlm` does not lose its authentication — it leaves the library.** Two drafts tried to keep it: one gave `MakeLlmConfig` a discriminated credential union, the other said it stays “for the cases where nothing secret is involved”. Both were patching a function that should not be here, and reading it settles the question:

   ```ts
   // llm-agent-libs/src/providers.ts — what the dispatch actually is
   const mod = await import(pkg);                       // :70, :88, :106, :124, :142
   … as { new (cfg: { apiKey?: string; … }): … } & LLMProvider;   // :77, :95, :113, :131, :156
   const provider = new DeepSeekProvider({ apiKey: cfg.apiKey, … });          // :186
   ```

   `llm-agent-libs` declares **none** of the five provider packages as a dependency — they are loaded by dynamic `import()` as “optional peers”, and one type is imported outright from an undeclared package (`SapAICoreCredentials`, `:18`). Each provider's constructor shape is then **restated by hand** in this file. So the library owns a private copy of five contracts it does not own, and that copy is the only reason a secret ever had to appear in a framework config: `MakeLlmConfig.apiKey` exists to feed `new DeepSeekProvider({ apiKey })`.

   **It is also a variation point the consumer should own.** Principle 5 says anything left to the consumer's choice is a strategy they can swap; which LLM provider exists, and how it is constructed, is exactly that — and principle 2 says the assembly is where such glue lives, not the library. The seam is already there: `withMainLlm(llm: ILlm)`, `withHelperLlm`, `withClassifierLlm` (`builder.ts:246`, `:258`, `:264`).

   So `makeLlm`, `makeDefaultLlm` and the five `load*` shims **leave `llm-agent-libs`**. A consumer writes `new OpenAIProvider({ credential, model })` and hands in the instance; `llm-agent-server` keeps a dispatch of its own if it wants one, being the example (principle 2). Nothing in the library then restates a constructor it does not own, and no framework type carries a secret — not because we removed a field, but because the code that wanted the field is gone.

   **The same removal answers the model resolver, and `IModelResolver` itself does not change.** An earlier draft said the interface would start taking a factory; that was wrong on two counts, and reading it shows both. `IModelResolver` is one method and holds nothing — `resolve(modelName, role): Promise<ILlm>` (`interfaces/model-resolver.ts:7-12`). What holds a config is the **default implementation**: `DefaultModelResolver` keeps `Omit<MakeLlmConfig, 'model'>` plus a `defaults.temperature`, and on every call builds a whole new provider — `makeLlm({ ...this.providerConfig, model: modelName }, temperature)` (`providers.ts:314-327`).

   **An earlier draft of this item said per-call options replace it. They do not, and `CallOptions` says so itself.** Its `model` docstring: the override “applies to the main working LLM path… It does **NOT** reach the reviewer, finalizer, planner, or target-state evaluator roles — those receive only a diagnostic-only subset… Same for temperature / maxTokens / topP / stop” (`interfaces/types.ts:35-42`). The exclusion is deliberate, so a client-supplied override cannot corrupt those roles' structured output. And the resolver's actual job is not a per-call override at all: `PUT /v1/config` uses it to **permanently swap** the main, classifier or helper instance (`llm-agent-server-libs/src/smart-agent/http/config-route-handler.ts:106`, `:129`, reached from `smart-server.ts:334`, `:3041`). Retracted.

   **So the capability stays, and only the implementation moves.** Constructing a provider for a newly chosen model is construction — exactly where a credential belongs — so whoever holds the credential must be the one that builds it. That is not the library: `DefaultModelResolver` could only do it by holding a stored config with a secret in it, plus the five-way dispatch that leaves with `makeLlm`. Where it lands is settled below, under *Where the dispatch lands*: the **app**, `llm-agent-server` — an earlier draft said `llm-agent-server-libs`, and that is withdrawn, because `-libs` is a library whose own DTOs carry the same passengers.

   **Nothing loses a capability silently, because the seam is already optional.** `modelResolver?: IModelResolver` (`smart-server.ts:334`) means a deployment that supplies none has no model switching today either — `config-route-handler.ts:106` checks for exactly that. The contract is untouched, the shipped server keeps the feature by implementing it where the credential lives, and a consumer with its own resolver is unaffected.

   Its `role === 'main' ? 0.7 : 0.1` goes with the class rather than moving: that is a policy with our numbers in it, which `LLMProviderConfig`'s own `whenThrottled` comment argues against a few lines away. Whoever implements the resolver picks its own.

   **Where the dispatch lands, precisely — the app, not `llm-agent-server-libs`.** An earlier draft sent it to that package, which would have moved the same contract one directory over: `SmartServerLlmConfig` declares a **required** `apiKey: string` (`smart-server.ts:129`) and `PipelineLlmProviderConfig` carries `apiKey?` plus SAP client credentials (`pipeline.ts:14-26`). Both are passengers by this section's test — remove the key and a complete server configuration remains — and `-libs` is a library, consumed by `llm-agent-server`. So those two DTOs lose their secret fields as well.

   **They cannot “take an instance or a factory” instead, though, and an earlier draft of this paragraph said they could.** These types *are* the YAML: the shipped template declares `llm: { provider, apiKey: ${DEEPSEEK_API_KEY}, model, temperature, classifierTemperature }` (`yaml-loader.ts:15-21`). A file holds no object and no function, so the fix is not to change what the field accepts but to **separate two layers that had been one**:

   | layer | what it is | holds |
   |---|---|---|
   | **serializable app configuration** — `SmartServerLlmConfig`, `PipelineLlmProviderConfig`, the YAML | what a file can express: `provider`, `model`, `temperature`, `classifierTemperature`, `url`, and a **`credentialRef`** | **no secret, no instance** |
   | **runtime injection** — `BuildAgentDeps.makeLlm`, which already exists | `(cfg) => Promise<ILlm>`, supplied by the app, closing over the credentials it holds | **construction, done by the app** |

   **The seam is not new, and that is the point.** `BuildAgentDeps.makeLlm?: (cfg: SmartServerLlmConfig) => Promise<ILlm>` is already there (`smart-server.ts:360`), already optional, and already the right shape: a factory handed the *serializable* config, returning a constructed `ILlm`. Its siblings already work this way: `resolveEmbedder`, `connectMcp`, `buildSkillHost` (`:361`, `:371`, `:366`).

   **But it stops being optional in practice, and that is a runtime break of its own.** `SmartServer` supplies a default today — `makeLlm: deps.makeLlm ?? ((cfg) => this._makeLlmDefault(cfg))` (`smart-server.ts:954`) — so a consumer that never touched the DI seam relies on it, and removing the default means such a deployment **stops starting**, not merely stops compiling. §8 lists it and the migration shows the call; the validator should refuse at startup with a message naming the seam rather than failing later.

   **The role does not travel in the config, and it is not added either — two drafts of this paragraph got this wrong in turn.** The first claimed the role reaches the factory; it does not, since `main`, `classifier` and `helper` are keys of the outer YAML map (`yaml-loader.ts:68-81`) while what arrives is a `SmartServerLlmConfig` (`:359-360`). The second then widened the seam to `(cfg, role: 'main' | 'classifier' | 'helper')`. Counting the call sites kills that:

   - the seam is called from about twenty places — `smart-server.ts:1036`, `:1043`, `:1052`, `:1875`, `:1888`, `:1900`, `:2020`, `build-dag-coordinator-deps.ts:89`, `:102`, `:174`, `plan-analysis.ts:461`, `controller.ts:336`, `dag.ts:49`, `coordinator-resolvers.ts:191`, `role-llm-resolver.ts:11`, `:51`, `:66`, and more;
   - its shape is **restated as a type** in at least four of them — `server-context.ts:26`, `role-llm-resolver.ts:29`, `:38`, `coordinator-resolvers.ts:176` — so a required parameter is a required edit in each;
   - and the roles are not three. Those calls build a finalizer, a planner, a reviewer, DAG coordinator roles, and **arbitrary named entries**: `coordinator-resolvers.ts:165` documents the chain as “top-level `llm.<name>` → `llm.main` → `pipelineFallback`” (the last link is dead — §4.6.6 — and `buildFinalizer`'s error text at `:188` still names the removed `pipeline.llm.main`). A closed union of three cannot name them, and a `role: string` would be a label nobody can rely on.

   So no parameter is added. It was wanted for role-aware defaults or auditing, which is speculation; the one thing that genuinely needed to vary per entry is **credential selection**, and `credentialRef` sits in the config where every one of those twenty call sites already carries it. The seam keeps the signature it has:

   ```ts
   makeLlm: (cfg: SmartServerLlmConfig) => Promise<ILlm>;    // shape unchanged, no longer optional (§4.6.3)
   ``` `IModelResolver` stays the separate, already-optional seam for `PUT /v1/config` switching (`:334`).

   **`apiKey` leaves the YAML, but a non-secret `credentialRef` replaces it — an earlier draft removed both and lost something real.** Today each role may carry its own `apiKey: ${ENV_VAR}`, so one deployment can put `main` on one account and `classifier` on another. Remove the field with nothing in its place and `{ provider, model, … }` can no longer say **which** credential a role or an endpoint is meant to use; “the app reads the environment” only works when there is one thing to read.

   ```yaml
   llm:
     main:
       provider: deepseek
       # No credentialRef: the root's default entry applies — was: apiKey: ${DEEPSEEK_API_KEY}
       model: deepseek-chat
     classifier:
       provider: openai
       credentialRef: OPENAI_KEY_CHEAP     # a second account, named — still expressible
       model: gpt-4o-mini
   ```

   **And the rule is general, not an LLM rule — two more DTOs carry the same passenger.** *(Both of those two are RAG shapes, and §4.6.4 below shows why one `credentialRef` on either is not enough — read the two together.)* `PipelineRagStoreConfig.apiKey` is a plain secret, documented as “API key (for openai type or Qdrant auth)” (`pipeline.ts:32`) — though, as it turned out, on a legacy DTO nothing reads, which is why it is deleted rather than fixed (§4.6.4); `SmartServerRagConfig` — the **exported** YAML DTO, and the one a PostgreSQL or HANA deployment actually fills — carries `user?: string` and `password?: string` (`smart-server.ts:167-168`); and `SkillPluginsConfig`'s store variant is `{ type: 'qdrant'; url: string; apiKey?: string }` (`skill-plugins-config.ts:19`, threaded at `skill-plugins-host-factory.ts:271`, `:310` and `controller-skill-pipeline-builder.ts:16`, `:47`). Both are YAML DTOs, and by this section's test both fail it the same way: remove the key and a complete store configuration remains. Two earlier drafts narrowed this: the first applied `credentialRef` to the LLM configs alone, the second added the pipeline and skill stores but missed `SmartServerRagConfig` — which is the one carrying `user`/`password`, so the rule would have held everywhere except the PostgreSQL and HANA path it matters most on.
   So they take `credentialRef` as well, resolved the same way, and the embedder and store construction moves to the app with the provider dispatch. The RAG stores' own constructors take the credential (§4.5), so nothing new is needed below.

   A reference is not a passenger by this section's test: remove it and the configuration can no longer address the right account, so it is something the config genuinely needs. And it is not a secret — the value never enters the loaded object, which is precisely what `${…}` substitution did wrong. The app maps a `credentialRef` to a credential however it likes: an env var of that name, a vault lookup, a fixed table. Absent, it means “the one credential I hold”, so a single-account deployment writes nothing.

   **What stays in `-libs`, and what moves.** The YAML loader, the env substitution and the schema validation stay: once the shape carries no secret, loading a file is not handling one. What moves to the app is the part that needs a secret — credential construction, provider dispatch, and the `IModelResolver` implementation behind `PUT /v1/config`. One validation rule goes with them: `config-validator.ts:72` refuses a `sap-ai-sdk` configuration without `AICORE_SERVICE_KEY`, and only the app knows whether it holds a credential.

   The composition root is **`llm-agent-server`**, the app. It is the only package that already declares every provider it might construct — all sixteen, explicitly, unlike `llm-agent-libs` which reached for five by dynamic `import()` — and principle 2 makes the app the example. It reads YAML and the environment, builds credentials, constructs providers, and hands instances in. Nothing below it sees a secret.

   **And the AI Core token source is named, because “the root builds an `IBearerCredential`” is not an implementation.** `AICORE_SERVICE_KEY` holds OAuth **client credentials**, not a token: something must exchange them, cache the result and refresh before expiry. That something already exists and is tested — `TokenProvider` in `sap-aicore-embedder/src/auth.ts` (caching, expiry, a refresh window, `grant_type=client_credentials`) with `parseServiceKey` beside it in `service-key.ts`, and `auth.test.ts` / `service-key.test.ts` covering both. Neither is exported: the barrel ships only `SapAiCoreEmbedder` and its types.

   Since `sap-aicore-llm` and `sap-aicore-embedder` depend on each other in neither direction, that code moves to a small package both can use — **`@mcp-abap-adt/sap-aicore-auth`** — exporting one function:

   ```ts
   // The service key carries an ADDRESS as well as OAuth material, and an address is not
   // a credential (§4.6.3) — so one call returns both, each going where it belongs.
   serviceKeyCredential(raw: string): {
     credential: IBearerCredential;   // parse, exchange, cache, refresh
     apiBaseUrl: string;              // serviceurls.AI_API_URL, for the provider's own config
   };
   parseServiceKey(raw: string): ParsedServiceKey;        // moved as-is, still exported
   ```

   An earlier draft returned the credential alone, which dropped `serviceurls.AI_API_URL` — `parseServiceKey` already returns it as `apiBaseUrl` (`service-key.ts:1-8`) — and left the migration example constructing a provider with no endpoint. An env-only deployment has to keep working, so the address travels with the call that reads the key.

   **And the property it lands in is named `apiBaseUrl` on both SAP packages.** `SapCoreAIConfig` has no endpoint field today — the URL sits inside the credential object being removed (`sap-core-ai-provider.ts:29`) — so it gains one, and `apiBaseUrl` is the name to gain: it is what `parseServiceKey` returns (`service-key.ts:7`) and what `sap-aicore-embedder` already calls the same thing (`foundation-embedder.ts:8`). An earlier draft of the migration example wrote `serviceUrl`, matching nothing.

   This is a move of working, tested code rather than new work, and it is the shape §4.4 anticipated: the contract package ships the vocabulary, and whoever needs an implementation writes one. The composition root calls it with what it reads from the environment; the two SAP providers stop reading anything.

   That is the same answer as `EmbedderFactory`'s, arrived at from the other direction, and the repetition is the point: **wherever the framework must construct something later, it asks the consumer for a factory, never for a secret.** One shape covers the embedder, the switched model, and anything of this kind that comes next.

   **`EmbedderFactoryConfig` is the one case of that, and it is why the rule is worth stating.** The framework passes it *to a factory the consumer wrote*, so today the framework carries a secret on the consumer's behalf, from the consumer, back to the consumer. It never needs to: the factory closes over the credential it already holds — `() => new MyEmbedder({ credential: mine })`. Removing `apiKey` there means the framework stops handling secrets, rather than handling them more politely.
    **A built-in factory has no closure, and that is the line between the two cases.** The paragraph above is about a factory the *consumer wrote*, which is why the framework must stop carrying its secret: the consumer already holds the credential and closes over it. The names the framework resolves **itself** are the other case — `openai`, `sap-ai-core` and the store names in `llm-agent-rag` reach constructors the consumer never writes and cannot close over, so for those the credential has to arrive as an argument or the target cannot be built from configuration at all. This is not a weakening of the rule; it is §5's rule applied one layer out, since resolving a name **is** construction.

    **What makes that safe is the same thing that makes it necessary: the parameter is typed by the credential contract.** A file cannot produce an `IApiKeyCredential` — `${VAR}` substitution yields a string, and `secret()` is a function — so a member of that type can only be filled by code that holds the credential. The **type**, not a convention or a review habit, is what keeps the serializable layer secret-free. That is why `credentialRef: string` and `credential: IApiKeyCredential` are two members of two different layers rather than two spellings of one: the first is what a file can say, the second is what only a holder can supply, and an object that reaches a constructor may carry the second precisely because no YAML can.

    **Two consequences, and the second is easy to get wrong.** The resolution input in `llm-agent-rag` carries `credential`, because its built-ins have no other way to be authorized — and it carries it as a **typed arm of a discriminated union**, not as a member of an untyped bag: the contracts exist so a type is not lost anywhere along the path, so the place that passes a credential on is also the place that must keep it checkable (principle 10). But a consumer-registered `extraFactories` entry keeps the narrow `EmbedderFactoryConfig`: the framework may hold a credential for a constructor **it owns**, and must not promise to carry one for a factory the consumer wrote — that is the paragraph above, and widening this seam would reintroduce exactly the secret-handling it removes.
   **One plain-string convenience exists, not two, and it goes rather than gaining a credential.** `makeDefaultLlm(apiKey: string, model: string, temperature: number)` (`providers.ts:302`) is a one-line wrapper over `makeLlm` with `provider: 'deepseek'` hardcoded, so it leaves with it. An earlier draft of this item also named a `createDeepSeek` — **there is no such symbol anywhere in the repository**; I carried it in from a summary and it should never have reached a spec.

   **And it removes the precedence rules instead of ranking them.** §4.6.1 had to decide whether a credential outranks a connection string and the discrete fields, and §4.6.2 whether it outranks `apiKey`. Both questions exist only while a config carries several sources; with one source, “did this object get authorized?” has one answer, checkable at construction, and there is nothing to rank. A connection string therefore carries the **address** only — a string with a password in it is refused at construction, loudly, rather than silently losing to the credential.

   **The cost, stated plainly.** Consumers pass `apiKey` today, so this is a break: in llm-agent's contracts it is a removal, and in the concrete packages it replaces the field. The release is already a major (§7), and core ships the conversion so each call site is one line:

   ```ts
   staticApiKey('sk-…')       // => IApiKeyCredential, for a key that does not rotate
   staticLogin('user', 'pw')   // => ISecretLoginCredential
   ```

   **§1.1 does not argue against this, and an earlier draft misused it to.** “A new seam left unused changes nothing” governs a new *capability*, which a consumer may decline. Authentication was never declinable — only how to express it was — so replacing the expression is a migration (§8), not an opinion imposed on anyone.

   The asymmetry with the logger stands and explains why *that* convergence still waits: llm-agent hands `ILogger` **out** through `PipelineContext` and `IPipelinePlugin`, so renaming it breaks every consumer's plugin (§7, §9.9). Nothing hands a secret out.

3. **Where the endpoint goes: a field of its own on the provider's config, named `apiBaseUrl`.** An earlier draft said it “keeps the home it has” — but for `sap-aicore-llm` that home was *inside* the credential object being removed (`sap-core-ai-provider.ts:29`), so there is nothing to keep. It becomes a top-level `apiBaseUrl`, matching what `parseServiceKey` returns (`service-key.ts:7`) and what `sap-aicore-embedder` already calls it (`foundation-embedder.ts:8`). An address is not a credential by this section's own rule, so `IBearerCredential` carries the token and nothing else, and the service URL keeps the home it has — `sap-aicore-llm`'s provider config (`sap-core-ai-provider.ts:29`, read at `:164`) and `sap-aicore-embedder`'s `apiBaseUrl` (`foundation-embedder.ts:8`). What changes is only that the two stop being one object: today the URL sits in the same structure as the OAuth input, and the credential replaces that input's half of it. §9.2's measurement shows the resulting shape exactly — a constructed destination `{ url, authentication: 'NoAuthentication', headers: { Authorization } }`, where `url` comes from config and the header from `token()`.

---

   ### 4.6.3 Where the check belongs — principle 10 applied to this design

   **The rule.** *Prefer a check the compiler makes over a check that runs.* A guard reports a mistake to whoever is unlucky enough to hit it; a type refuses it in front of whoever wrote it. So a runtime check keeps one job — the **boundary** where input arrives that no compiler ever saw — and everywhere else the type is the mechanism. Recorded as binding principle 10 in `docs/ARCHITECTURE.md`. It was stated after three items of this design had already been written the other way round, so this section says what each of them becomes, rather than leaving the rule to be applied by whoever reads it next.

   **The tell is always a cast, and the question is which one.** A name held in a variable, `await import(pkg)` with a non-literal specifier, `as new (opts: Record<string, unknown>) => T` — each turns a compile-time question into a runtime one and then invites a guard to answer it. Before adding a guard, ask which cast made it necessary and whether that cast was load-bearing. In this design, three times out of three, it was not.

   **1. The store dispatch (settled, see the `llm-agent-rag` row in §8).** A discriminated union whose arms carry what each backend's constructor demands, dispatched over literal import specifiers. The wrong credential kind, a missing required one and a leftover `apiKey`/`user`/`password` become build errors; the bag, the casts and the name maps are deleted.

   **2. The embedder dispatch — the same treatment, and it is required rather than eventual.** The embedder half of that package has the identical shape: `EmbedderFactoryOpts = Record<string, unknown>` reaching a cast constructor, a whitelist copied field by field, and a `kind` guard answering what the compiler could. Leaving it is not a smaller version of the same defect, it is the same defect, and an earlier draft of this design shipped a guard there for exactly the reason principle 10 rejects. It is equally convertible: `@mcp-abap-adt/openai-embedder`, `-ollama-embedder` and `-sap-aicore-embedder` are declared in **both** `peerDependencies` and `devDependencies`, so a literal specifier type-resolves while each stays an optional peer. What must not change with it is the narrow consumer-facing `EmbedderFactoryConfig` on `extraFactories`: a factory the consumer wrote closes over its own credential, and the framework must not promise to carry one for it.

   **3. `BuildAgentDeps.makeLlm` becomes required in the type, not merely un-defaulted.** §4.6.2 removes `SmartServer`'s `deps.makeLlm ?? _makeLlmDefault` so the seam is genuinely supplied by the app, and an earlier draft of that item stopped there, adding that *"the validator should refuse at startup with a message naming the seam"*. That is the runtime answer to a question the type can settle: the member is optional today (`smart-server.ts:360`), so removing the default without making it required turns a build error into a deployment that stops starting. It becomes non-optional. The cost is real and is the migration: `BuildAgentDeps`'s doc comment promises that passing `{}` preserves current behaviour, and it no longer can, so every call site — tests included — names the seam. That is a smaller price than a fleet of deployments discovering it at boot, and §8's migration note carries it. The startup refusal stays for callers with no types to check.

   **4. `makeRag` takes a built embedder, not the name of one — a calling-contract change this section owes an explicit statement.** It emerged from implementing item 1 rather than from designing it: once each union arm carries `embedder: IEmbedder`, there is nothing left for `makeRag` to resolve by name, and an earlier draft of the task text asked for both at once — arms typed to an instance and a `resolveEmbedder(cfg as EmbedderResolutionConfig)` call inside `makeRag` — which cannot compile together. The instance wins, and it is the right half to keep: a name is a string that any typo satisfies, an `IEmbedder` is checked. So a caller composes the two — `resolveEmbedder` first, then `makeRag` — and three consequences follow, each of which belongs to a task rather than to a surprise: the name-resolution path leaves `makeRag` entirely; `llm-agent-server-libs`' four call sites must resolve before calling, which is **Task B9's** work and is why that suite is red between the two tasks; and `InMemoryRag` without an embedder is no longer reachable through `makeRag`, so a caller wanting keyword-only in-memory constructs it directly, as it still exports.

   **And one runtime check that is correct and must not be "fixed".** A connection string carrying credentials is refused at construction (§4.6.1). Whether a string contains `user:pass@` is a property of its **value**, not of its type, and it arrives from a file — so this is the boundary doing exactly its job. The same holds for a missing optional peer, which no type can answer, and for a legacy secret field arriving from YAML, since a loaded object is not a fresh literal and no excess-property check ever sees it. The distinction to keep is not runtime-versus-compile-time as a matter of taste: it is whether the value ever passed a compiler.


   ### 4.6.4 One `credentialRef` is not enough for RAG, and the app has no seam to build a store through

   Two blockers found reviewing this design against the code, and they are one structural problem seen from two sides: **the serializable RAG config describes two independently authenticated targets at once, and the composition root has no way to construct either.**

   **The config conflates a store and an embedder.** `SmartServerRagConfig` (`smart-server.ts:150`) is one flat shape holding the store's `connectionString`, `host`, `port`, `user`, `password`, `database`, `schema`, `poolMax`, `connectTimeout`, `dimension` and `autoCreateSchema` **beside** the embedder's `embedder`, `model`, `resourceGroup`, `scenario` and `maxBatchSize` — and two members are outright ambiguous: `url` is Qdrant's address or Ollama's depending on its neighbours, and `model` is the embedding model while the store has none. So a single `credentialRef` cannot say what it refers to. Qdrant with OpenAI embeddings needs **two** api keys; Qdrant with SAP AI Core needs an api key **and** a bearer credential with an `apiBaseUrl`. An earlier draft of §4.6.2 added one `credentialRef` to this DTO and to `PipelineRagStoreConfig`, which would have been unable to express either deployment.

   **So the shape splits, along the line the implementation had already drawn.** §4.6.3's item 4 left `makeRag` taking a built `IEmbedder` rather than a name, which means store construction and embedder construction are already two steps in code; the serializable side mirrors that instead of contradicting it:

   ```yaml
   rag:
     store:                      # what the vector store needs, and its own account
       type: qdrant
       url: http://localhost:6333
       collectionName: docs
       credentialRef: QDRANT
     embedder:                   # what the embedder needs, and its own account
       provider: sap-ai-core
       model: text-embedding-3-small
       credentialRef: AICORE     # the service key behind it also yields the apiBaseUrl
   ```

   Each nested shape carries **its own** `credentialRef`, which is what makes two accounts expressible; the ambiguous `url` and `model` land on the target that actually owns each; and the search knobs land on the one target that reads them. `dedupThreshold`, `vectorWeight` and `keywordWeight` were read **only** by the in-memory branch of `makeRag` — `VectorRag` with an embedder, `InMemoryRag` without one — and never by Qdrant, pgvector or HANA (`main:packages/llm-agent-rag/src/rag-factories.ts:266-286`), so an earlier draft of this example was wrong to leave them at `rag.` level as "belonging to neither target": they are the in-memory store's own settings, and the in-memory section carries them:

   ```ts
   type InMemoryStoreConfig = {
     type: 'in-memory';
     collectionName?: string;   // → VectorRag's namespace — new on this branch; main built neither store with one
     credentialRef?: string;    // present only so a ref named for it is refused by name
     dedupThreshold?: number;
     vectorWeight?: number;     // hybrid scoring — read only when an embedder is present
     keywordWeight?: number;
   };
   ```

   A flat config that set them beside a Qdrant store was setting values nothing read, and the migration note says so rather than moving them to a new place where they would still do nothing. Two readers move with them, or hot reload of the weights silently stops: the config watcher reads `rag.vectorWeight`/`rag.keywordWeight` and applies them to live stores through `updateWeights` (`llm-agent-libs/src/config/config-watcher.ts:141-144`, `config-reload-watcher.ts:117-129` — only `VectorRag` implements it), and the section resolver defaults all three at `rag.` level (`resolve-config-sections.ts:199-201`, 0.92 / 0.7 / 0.3). Both read `rag.store` instead, and only when its `type` is `in-memory`. Two things the in-memory arm now does differently, stated rather than hidden: `collectionName` reaches `VectorRag` as its `namespace`, where `main` built it without one; and the keyword-only `InMemoryRag` in the reference below gets `dedupThreshold` alone — `main` also passed `queryPreprocessors`/`documentEnrichers`, which are programmatic objects no YAML can carry, so nothing a file configured is lost. `PipelineRagStoreConfig` is not split but deleted: it and `PipelineLlmProviderConfig` belong to the legacy `PipelineConfig`, which startup has refused since v19, and nothing reads either — reshaping a dead DTO would be work with no reader to check it. **`SkillPluginsStoreConfig` does not**, and an earlier draft of this paragraph was wrong to say it should: it is already a discriminated union — `{ type: 'in-memory' } | { type: 'qdrant'; url; apiKey?; collection? }` — describing persistence only, with no embedder target in it to separate. Its qdrant arm simply gains its own `credentialRef?`. And it is worth noticing why that config needed no rescuing: `SkillPluginsConfig` **already** keeps its embedder in a separate `embedder` member, read at `skill-plugins-host-factory.ts:240`. The split asked of `SmartServerRagConfig` is therefore not an invention of this section — it is the shape a sibling config in the same package has been using all along. This is a **breaking** change to a YAML shape, and §8's migration note carries the before/after — it is a rename plus a nesting, mechanical for a consumer to apply.

   **And the app needs a seam to construct a store, which it does not have.** `BuildAgentDeps` offers `makeLlm`, `resolveEmbedder`, `buildSkillHost`, `connectMcp` and more — but **nothing for a store**. `SmartServer` imports `makeRag` from the library and calls it directly at `smart-server.ts:1271`, `:1272`, `:1915` and `:1923`. So with secrets gone from YAML, those four call sites have no credential to pass and the composition root never participates: the design's whole claim, that construction belongs to the app, has an LLM seam and no store seam. An earlier draft did not notice because it reasoned about the DTOs and never about who calls the constructor.

   So `BuildAgentDeps` gains `makeRag`, **required** for the same reason `makeLlm` is (§4.6.3 item 3). What it takes had to be corrected twice, and the second correction is the instructive one. The first draft said `(storeConfig, embedder: IEmbedder)`; the second said `(cfg: RagResolution)` — the library's runtime union. Both were wrong, in opposite directions, and for one reason: **neither end of the seam holds what it was being asked for.** `SmartServer` cannot build a `RagResolution`, because that union carries a `credential` and the credential is precisely what the library must not hold. The app's factory cannot receive a `RagResolution` either, because it would then never see the `credentialRef` it is supposed to resolve. The seam's job **is** that conversion, so its input is what the caller genuinely has — the serializable store section and, when the store needs one, a resolved embedder — and its body is where the app turns those into the typed union:

   ```ts
   // paired, so the compiler demands an embedder exactly where a store cannot work without one
   type MakeRagInput =
     | { store: InMemoryStoreConfig; embedder?: IEmbedder }
     | { store: QdrantStoreConfig | PgVectorStoreConfig | HanaVectorStoreConfig; embedder: IEmbedder };

   makeRag: (input: MakeRagInput) => Promise<IRag>;
   ```

   The pairing is a discriminated union rather than an optional second parameter, because `SmartServerRagStoreConfig` is itself discriminated by `type` once §4.6.4's split has happened — so the requirement travels with the arm instead of being asserted about it. `SmartServer` narrows at the YAML boundary, which is where narrowing belongs (§4.6.3), and after that its four call sites type-check.

   **The discipline this section was missing, stated so the next seam does not need three drafts.** For every seam, write down what each side holds before choosing the signature:

   | seam | the library holds | the app holds | so the seam carries |
   |---|---|---|---|
   | `makeLlm` | `SmartServerLlmConfig` with a `credentialRef` | the credential registry | the config; the app resolves and constructs |
   | `resolveEmbedder` | the embedder section with its own ref | the registry, and the narrowing per provider | the config; the app resolves, narrows and constructs |
   | `makeRag` | the store section with its own ref, plus an `IEmbedder` it obtained from the seam above | the registry | both of those; the app resolves and constructs |

   Two of the three mistakes above were signatures chosen before this table existed.

   **And two rules the adapters must obey, both of which an earlier draft of them broke.** First, **the reference ends in the root**: it is destructured out before anything is spread onward, because `{ ...cfg }` carries `credentialRef` into a runtime object and TypeScript will not stop it — excess property checking does not apply to a spread. A non-secret reference leaking into `llm-agent-rag` and on into a provider config is not a security problem, it is the two-layer separation the whole design rests on quietly failing. Second, **"optional" means the reference may be omitted, never that a named reference may fail to resolve.** An earlier draft treated an unknown or wrong-kind entry as "no credential", so `credentialRef: QDRNAT` would have opened an **unauthenticated** connection instead of reporting a typo — a silent downgrade from authenticated to anonymous, which is the worst direction for a mistake to fail in. A ref that was named must resolve, and must hold the right kind; falling back to no credential is legitimate only where none was asked for and the target genuinely permits it. Two parameters made the keyword-only path inexpressible: a `store.type: in-memory` with no `rag.embedder` has no `IEmbedder` to pass, while every call site was to go through this seam. In the union the embedder sits on the arms that need one — required on `qdrant`, `pg-vector` and `hana-vector`, **optional on `in-memory`**, which is also how `SkillPluginsStoreConfig` has long expressed the same thing (`{ type: 'in-memory' }` carries no fields at all). So the compiler demands an embedder exactly where a store cannot work without one, and the app resolves one only then: a library that may not construct an authenticated LLM from configuration may not construct an authenticated store from it either. `resolveEmbedder` becomes required on the same argument, since an embedder is the third authenticated thing. The cost, stated rather than discovered: a deployment using only Ollama and an in-memory store needs no credential at all and must still supply three factory lines, and passing `{}` as `deps` stops compiling. The alternative — keeping the seams optional and defaulting them when the config names no credential — was rejected: it is a runtime condition deciding who constructs, which is principle 10 inverted, and it leaves the library holding construction for exactly the deployments least likely to review it.


   ### 4.6.5 Authorization is established once, which is a statement about lifetime

   §5 says construction is the authorization: once the object exists it is authorized, and every method
   on the contract is just the job. That is a claim about **how often construction happens**, and a
   constructor that takes a credential but runs on every request has moved the work rather than removed
   it. So the requirement is two-part, and the second part had been left implicit: *authorization is
   passed **once**, when the provider instance is built, and that instance is then reused.*

   **It is measurable, not stylistic, because the quota gate depends on it.** §4.6.2's rate limiting keys
   a 429 bucket on the credential **object's identity** — deliberately, since deriving a key from the
   secret would put the secret in a cache key. Two consequences follow, and the reference implementation
   broke both before this section existed:

   - **The registry must hand back the same object for the same reference.** A `credentialFor` that calls
     `staticApiKey(requireEnv(…))` on each lookup returns a new object every time, so one account gets a
     fresh quota bucket per construction and the gate stops gating — a defect no single-request test can
     show. Memoize per reference, keeping the laziness that made it a function rather than a literal:
     parse on the first ask, reuse afterwards.
   - **A resolver must not construct per resolution.** `RoleLlmResolver.resolve(role)` returns held
     instances for `main`, `helper` and `classifier`, and for any **other** configured role falls through
     to `deps.makeLlm(cfg)` — constructing a provider, and resolving a credential, on every call. The
     three common roles hid it. A role's instance is built once and cached by the resolver, on the same
     argument that gives the three their fields; a config reload replaces the instance, which is the one
     event that should.

   The same holds for every object the pipeline embeds, not only LLMs: an `IMcpServer` whose constructor
   demands a credential per §3.3, an embedder, a store. If any of them is constructed per request, its
   authorization is per request too, whatever the constructor's signature says. **The test to apply to a
   seam is not "does the constructor take a credential" but "how many times is this constructor
   called"** — and if the answer is per request, the seam is a factory in the wrong place.

   **And "once" needs its unit named, or the rule fails in the other direction.** Once means once per the **scope of the identity being authorized** — process-wide for a deployment's own account, and **per session** where the credential is the session's, which is the case a per-user ABAP login or a per-tenant store falls into. Never per request and never per step. The opposite error is as real and worse: caching an instance built from one session's credential and handing it to another session shares an authorization across callers, which is a cross-caller leak rather than a missed optimisation (§5.1 and AS-6 in the threat model). So the lifetime of the instance is the lifetime of the identity it was built for, and a per-session object is disposed with its session.


   ### 4.6.6 A usage contract carries neither authorization nor the means to obtain it

   §4.6.5 asks that a provider be constructed once, and asking is not a mechanism. The mechanism is
   structural: **the contract through which an object is *used* must not mention authorization, and must
   not offer any way to get an authorized object either.** Then a step further down cannot send
   credentials on every call, because nothing in its reach accepts them and nothing in its reach
   constructs. Authorization lives in a **separate** contract — §4's three credentials — consumed by the
   **constructor** of the implementation of the usage contract, and nowhere else. This is principle 10
   applied to a lifetime rather than to a value: enforce it in the type, not in a rule someone must
   remember.

   **The usage contracts already pass this test, which is why it is worth stating for the rest.**
   `ILlm.chat`/`streamChat` take `LLMCallOptions`, whose entire content is `model`, `temperature`,
   `maxTokens`, `topP`, `stop` and `signal` — behaviour knobs, all of them, and `model` being one of them
   matters below. `IEmbedder.embed`, `IRag.query` and the MCP call surface are the same: the job, and
   nothing auth-shaped.

   **First, the layers, because an earlier draft of this section called the wrong thing "the framework".**
   `llm-agent` is the framework for **building pipelines**: it declares `IPipelineContext` and knows nothing
   about YAML, credentials or deployments. `llm-agent-server-libs` and `llm-agent-server` are a **default
   implementation** — a separate package, and not part of the framework — which is where all nine pipelines
   and `SmartServer` actually live. The app above them is the composition root. Being the default assembly,
   the server layer may legitimately compose; what it may not do is **widen the framework's pipeline context
   with construction**, because `IServerPipelineContext` is exported, so that capability reaches every
   pipeline written against it, a consumer's included. And the framework's own contract already covers the
   default case: two of the four pipelines need nothing beyond `resolveLlm`. It needs one addition, for keys
   a file names (below and §4.6.7).

   **The pipeline's own context contract fails it, and fails it in the licensed way rather than by
   accident.** `IServerPipelineContext` (`pipelines/server-context.ts:22`) — the object handed to every
   step — declares, beside the correctly-resolved `mainLlm: ILlm`, `helperLlm?: ILlm` and
   `embedder?: IEmbedder`:

   - `makeLlm(cfg: SmartServerLlmConfig): Promise<ILlm>` — a **constructor**, taking the serializable
     config, which after §4.6.4 carries a `credentialRef`. Used at `pipelines/controller.ts:336` to build
     the three subagent role LLMs and threaded onward at `pipelines/dag.ts:49`, so construction is
     reachable from inside a running pipeline.
   - `llmMap?: NormalizedLlmMap` and `pipelineFallback?: SmartServerLlmConfig` — the **configs
     themselves**, references included, handed to every step.

   So the contract holds both shapes at once: instances, which are right, and configuration plus a
   factory, which is the per-step authorization path §4.6.5 measured. `IRoleLlmResolver` has the same
   defect for the same reason, declaring `makeLlm(lc)` beside `resolve(role)`.

   **What replaces them mostly exists, and that is the finding.** The **core** pipeline context contract
   — the framework's, in `llm-agent` — declares `resolveLlm(role: string): Promise<ILlm>`
   (`llm-agent/src/interfaces/pipeline-plugin.ts:48`),
   with its own comment saying why — *"Core-only; the server closes over its own config"*. A role in,
   an instance out: no config, no construction, no credential. So the right shape was designed at the
   start, `smart-server.ts:2462` already supplies it, and **two of the four pipelines already use it** —
   `pipelines/linear.ts:35` and `pipelines/stepper.ts:64` wire `makeRoleLlm: (role) => ctx.resolveLlm(role)`.
   `controller.ts:335` and `dag.ts:49` reach for `ctx.makeLlm` instead. So the default-role lookup needs no
   inventing: the server-libs additions `makeLlm`, `llmMap` and `pipelineFallback` are a **duplicate of a
   core contract, weaker than it**, and they go — an earlier draft of this paragraph proposed a new
   `resolveRole`, which was that same mistake a third time. What the core contract does **not** have is a
   strict lookup, and §4.6.7 adds one, `resolveNamedLlm(key)`, for a key a file named. That is not
   `resolveRole` again: `resolveRole` restated what `resolveLlm` already answered, while `resolveLlm` cannot
   answer this question at all — it answers an unknown name with `main`, which is right for a role asked by
   default and wrong for a key someone typed, and the resolver cannot tell the two apart from the string. One of the three costs nothing to remove: `pipelineFallback` is
   already dead — the `pipeline.llm` block it read was removed with the `pipeline: { name, config }`
   schema (`config-validator.ts:201`), and `SmartServer` now assigns it a constant `undefined`
   (`smart-server.ts:1030`). For the other two, `controller` and `dag` do what `linear` and `stepper`
   already do and ask for a role's model instead of building it — `ctx.resolveNamedLlm(key)` for a key their
   typed settings name, `ctx.resolveLlm(role)` with the role's own name when none was given — the keys
   arriving in their typed settings rather than in configuration they parse themselves (§4.6.7). **The replacement is the role, not a per-call option, and an earlier draft
   of this paragraph got that backwards against an argument this document had already made.** It said a step
   wanting a different model could pass `model` in `LLMCallOptions` — but §4.6.2 established the opposite
   twelve pages earlier, from `CallOptions`' own docstring: the override does not reach the reviewer, the
   finalizer, the planner or the evaluator. Those are precisely the roles the controller and DAG paths build,
   so for them a per-call option changes nothing and the migration would have silently kept the old model on
   every auxiliary call while appearing to work on the main one. What replaces `ctx.makeLlm(cfg)` is
   `ctx.resolveNamedLlm(key)` for a named key, or `ctx.resolveLlm(role)` for a role's default — either way
   an **instance the server built**, which is what roles exist for. The plugin never
   learns whether that instance is the deployment's or the session caller's, nor whether it was swapped by
   `PUT /v1/config` since the last session; the server's resolver decides both, which is why an instance
   reaches a plugin through `ctx` and not through its constructor (§4.6.7). A per-call `model`
   remains valid where the call site genuinely carries `CallOptions` through, which is the main path and not
   the auxiliary ones. The only capability removed is the ability to authorize something mid-pipeline, which
   is the capability that should not exist.

   **And the map is not the framework's to own, which settles where the scoping lives.** Four pipelines
   consume role resolution — `linear`, `stepper`, `controller`, `dag` — and the resolver is held above all
   of them by `SmartServer` (`:777`, built at `:1063`). A thing that serves several pipelines is not a
   pipeline's concern, and by principle 5 a variation point the consumer owns is the consumer's: the
   **app** composes the role map and hands it in, and `resolveLlm` and `resolveNamedLlm` read it. That also disposes of the
   contradiction an earlier version of this paragraph created by saying "a map the root filled at build
   time", which §4.6.5 forbids outright for a caller's credential — A map built once at startup can only hold instances built
   from the **deployment's own** credentials. A credential that belongs to a caller — a per-user ABAP login,
   a per-tenant store — does not exist at build time, so such a map either cannot hold those roles at all or
   holds one instance and hands it to every session, which is precisely the cross-caller leak §4.6.5 names.
   because a startup map can only hold the deployment's own accounts. The two scopes below are therefore
   **the app's policy**, not a lifetime the framework enforces; the framework only ever reads a lookup.
   Which scope a role lands in is decided by whose credential it uses:

   | scope | holds | built | disposed | a config reload |
   |---|---|---|---|---|
   | **deployment** | instances built from the deployment's own accounts, the ones a `credentialRef` names in the root's registry | once, at startup | with the process | replaces the instances; a borrowed one is read through a live accessor, so the next `resolveLlm` observes the new one |
   | **session** | instances built from the **caller's** credential | on first use **within that session**, once the identity exists | **with the session**, and only what that session built | does not touch them: their credential did not change |

   A session's resolver delegates to the deployment resolver for any role whose credential is the
   deployment's, and **borrows** rather than copies — so it must not dispose what it did not build, which is
   the one mistake this shape invites. This is the same arrangement §6.4 already settles for RAG, where a
   session may own its registry and disposes it with the session; nothing new is being invented, it is being
   applied to the other three kinds of embedded object.

   **The key is the consumer's, and the framework offers the lookup rather than requiring a shape.** An
   earlier draft of this paragraph prescribed a resolution chain — the `llm:` map, then a pipeline fallback,
   then `main`, with `planner` aliasing `helper` and an absent key throwing — as though the design were
   entitled to say so. It is not. `resolveLlm(role: string)` takes a **string**, deliberately and not a
   closed union, precisely because what the keys mean is the consumer's: which ones exist, whether any
   aliases another, whether an unknown one falls back or refuses, and whether there is a "map" behind it at
   all rather than a function computing an answer. The framework offers a way to ask; it neither fixes the
   question's vocabulary nor requires that anybody use it. This is principle 5 — a variation point the
   consumer owns is expressed as a seam, not as a policy we wrote down for them.

   So what follows is the **default implementation's** behaviour, offered as an example and not as a
   requirement: `SmartServer` builds its held `classifier` from `llm.classifier` when that entry is declared and otherwise from `llm.main` at `classifierTemperature` — today it always uses `llm.main` (`smart-server.ts:1041-1046`), so a declared classifier on a second account silently ran on main's, which the strict lookup below would have made permanent. It answers `main`, `classifier` and `helper` (and `planner`, read as `helper`
   and checked **before** any `llm.planner` entry, when a helper is configured) with the instances it holds, which `PUT /v1/config` swaps;
   any other key names an `llm:` entry, built **once** per key and held (§4.6.5); and a key with no entry
   gets the held **`main` instance** — not, as `RoleLlmResolver.resolve` does today, a fresh instance built
   from `llm.main`'s configuration on every call (`role-llm-resolver.ts:61-66`), which is neither shared nor
   swapped. (The `pipelineFallback` step it used to list is dead, above.) A different consumer may key by tenant, by model name, by
   cost tier, or by nothing at all. **The one invariant that is not theirs to choose** is the isolation one,
   and it constrains the *value* rather than the key: a lookup must never hand back an instance authorized
   for a caller other than the one asking (§4.6.5, §5.1). Whatever the key space, that answer is fixed.

   An earlier draft of this design would have left all of this in place, because it reasoned about where a
   credential is *declared* and never about who can *obtain* one. The two questions have different
   answers, and only the second one closes the hole.


   ### 4.6.7 Configuration is the builder's, and a plugin is handed what it needs

   **The rule, stated first because every paragraph below applies it.** There is one configuration file,
   and it is read by whoever runs the builder and assembles the pipeline — in this repository the server
   layer, `SmartServer` and the app above it, and nothing else. Every other component — a pipeline plugin,
   a coordinator, a provider, a store — knows nothing about configuration: it parses no section, holds no
   dialect and never sees a `credentialRef`. What it receives instead depends on how often it is built. A
   provider, a store, an `IMcpServer` or a coordinator is constructed for the lifetime it serves, so it
   takes typed values **and already-built instances — its credential included — in its constructor**
   (§4.1, §3.3). A **pipeline plugin** is the exception, constructed once and process-wide while serving
   every session, so its constructor takes typed settings only and the instances it uses arrive through
   `ctx` (below). Configuration answers *how is this deployment assembled*, and only the
   assembler asks that question. A component that parses configuration has taken a piece of the
   assembler's job and a piece of its knowledge with it — which is exactly how construction became
   reachable from inside a running pipeline (§4.6.6).

   **What a plugin module hands over is already built, or is its author's own factory.** `LoadedPlugins`
   (`llm-agent/src/interfaces/plugin.ts:147`) carries `mcpClients: IMcpClient[]` — clients the consumer
   connected and therefore authorized at construction, per §3.3 — `stageHandlers`, `apiAdapters`, and
   `embedderFactories: Record<string, EmbedderFactory>`. That last one is the **narrow** consumer-facing
   type, which is exactly the conclusion §4.6.3 reached for `extraFactories`: a factory the consumer wrote
   closes over the credential it already holds, so the framework must not promise to carry one to it. Two
   independent sites, the same answer, one of them written long before this design — which is the strongest
   evidence available that the rule is the codebase's and not this document's invention.

   **What a plugin receives at build time is a lookup or an instance, never a credential.**
   `IPipelineContext` gives it `resolveLlm(role)`, `toolsRag`, `ragRegistry?`, `mcpClients?`,
   `toolClientMap?`, `callMcp(…)` and `knowledgeRagFor(sessionId)`, plus `subagents` as **metadata only** —
   names and descriptions, no handles. Nothing auth-shaped, and `knowledgeRagFor` is keyed by a **session**,
   not by a credential, which is the legitimate form of the session-scoped access §4.6.5 describes: the
   identity is the key, and whoever supplied the function closed over the credential.

   **Where today's plugins break the rule — and an earlier draft of this section miscounted it.**
   `IPipelinePlugin` is `name`, `parseConfig(raw: unknown): Config` and `build(config: Config, ctx)`, and the
   server does `const cfg = plugin.parseConfig(…); return plugin.build(cfg, ctx)` (`smart-server.ts:2350`).
   So every plugin carries its own configuration dialect, and **four of the five shipped classes have one**:
   `linear` (`pipelines/linear.ts:25`), `stepper` (`stepper.ts:37`), `dag` (`dag.ts:29`, which refuses a
   section without a `planner`) and `controller` (`controller.ts:82`, which requires
   `subagents.evaluator`/`planner`/`executor` and validates its budget and wait knobs); only `flat`
   (`flat.ts:19`) has none. The earlier draft said the opposite — that the shipped plugins take no
   configuration and four of five could stay plain instance exports — and was therefore wrong about the size
   of the migration as well as the count. The worst case is `controller`: its section holds a **complete LLM
   configuration per subagent** (`ControllerConfig.subagents`, `smart-agent/controller/types.ts:203`, each a
   `SmartServerLlmConfig`), which is the whole reason it needed `ctx.makeLlm` — a plugin holding LLM configs
   must be able to construct from them, and after §4.6.2 those configs carry a `credentialRef` as well.

   **So the contract reduces to `name` and `build(ctx)`, and what reaches a plugin is split by what it is.**
   A plugin is given **no configuration** — but it is given two other things, at two different times, and
   the difference between them is what an earlier revision of this paragraph got wrong by trying to push
   both through the constructor:

   - **Typed settings, in the constructor, once.** The server parses and validates the plugin's section and
     constructs the plugin with a typed settings object — budgets, wait knobs, planning and dispatch kinds,
     and **the keys naming which model each role uses**. A key is a value, not configuration: it says which
     `llm:` entry a role wants, and nothing about how that entry is built or authorized.
   - **Instances, through `ctx`, per session.** At `build(ctx)` the plugin turns each key into an instance
     — `ctx.resolveNamedLlm(key)` for a key its settings named, `ctx.resolveLlm(role)` for a role whose key
     was omitted — and takes the other per-session objects — the worker registry, knowledge
     RAG, MCP clients — from `ctx` as today.

   Instances cannot go in the constructor, for three reasons measured against the code, each sufficient on
   its own. **Scope belongs to the deployment, not to the plugin**: whether a role is authorized by the
   deployment's credential or by the session caller's is the app's policy (§4.6.6), so a constructor
   signature fixed when the plugin was written cannot know which to demand, while a key resolved by the
   server can mean either. **A model can be swapped at runtime**: `PUT /v1/config` replaces the main,
   classifier and helper instances (`smart-server.ts:3043-3049`), and an `ILlm` handed to a constructor once
   would be frozen, silently ignoring the swap — §4.6.6's table already promises that the next lookup
   observes the new instance. **Some dependencies are per session**: `dag`'s coordinator dependencies include
   its workers, and the worker registry is built per session (`buildServerCtx` → `buildWorkerRegistry`,
   `smart-server.ts:2431`), each worker carrying that session's logger, RAG registry and MCP clients.

   The rule for a plugin therefore reads: **it never receives configuration; its constructor takes typed
   settings, and every assembled or authorized instance it uses reaches it through `ctx`.** (What a plugin
   constructs for itself — a coordinator it wires in `build`, a `LinearFactory`, a per-run token ledger, a
   fallback `DefaultStepExecutionControl` — is its own business; the rule is about what the assembler
   provides.) One channel for provided instances, not two:
   the registry constructs each plugin once, process-wide (below), so anything handed to a constructor would
   be deployment-scoped and frozen, and the question "is this instance per session, or swappable?" would
   have to be answered by the plugin author instead of by the server that knows. The instances
   `IPipelineContext` already hands over (`stepExecutionControl`, `runExecutionControl`, `waitStrategy`,
   `toolLoopContextStrategyFactory`, `mcpFailureClassifier`, and on the server context `embedder` and
   `stepperKnowledgeBackend`) are that channel working as intended, and stay where they are.

   What that means for each piece:

   - **The dialects leave the plugins.** Each built-in's parser moves into the server beside its other
     section resolvers: `controller`'s (`pipelines/controller.ts:82`), `dag`'s (`dag.ts:29`), `stepper`'s
     (`parseStepperCoordinatorConfig`, `smart-agent/stepper-config.ts:284` — `stepper.ts:37` only calls it)
     and `linear`'s (`parseLinearConfig`, `pipelines/parsers.ts:17` — `linear.ts:25` is a pass-through cast).
     `parseLinearConfig` also calls `ctx.resolveLlm('planner')`; that half is a lookup, not parsing, and
     stays in `build`. Parsing happens in `SmartServer.start()`, not in the YAML resolver: `SmartServerConfig`
     is also a programmatic shape (`smart-server.ts:279`, constructed directly by the CLI,
     `llm-agent-server/src/smart-agent/cli.ts:307`), so validating only on the YAML path would leave that
     path unvalidated. `SmartServerConfig.pipeline.config` keeps its public type, `Record<string, unknown>` (`smart-server.ts:279`) — its meaning depends on which plugin is selected, and the server's parser for that plugin is what narrows it.
   - **The registry holds factories, and the selected one is called once.** Every entry becomes
     `(section: unknown) => IPipelinePlugin`: for a built-in it is server code — parse, validate, construct
     with typed settings — and for a dynamic plugin it is the module's export (below). The server calls the
     selected entry once, in `start()`; the non-selected ones are never called, so a built-in whose section
     is absent costs nothing. `controller` and `controller-weak` stay two entries over one class, as today
     (`smart-server.ts:1131-1132`); the class keeps its `(name, plannerKind)` arguments
     (`controller.ts:74`) and gains its settings.
   - **A role's model is a key, and an omitted key means the role's own name — and the two are asked for
     differently.** A settings field that names a key is optional. When it is **present**, the plugin resolves
     it with `ctx.resolveNamedLlm(key)`, which answers only from an `llm:` entry of exactly that name and
     throws, naming the key, when there is none — no alias, no fallback. When it is **absent**, the plugin
     calls `ctx.resolveLlm(role)` with the role's own name — `'planner'`, `'executor'`, `'evaluator'`,
     `'reviewer'`, `'finalizer'` — which is what `linear` and `stepper` already do
     (`build-stepper-root.ts:265-289`). One default for every pipeline, and it is the server's resolver
     that decides what a name means (§4.6.6: `planner` read as `helper`, then an `llm:` entry of that name,
     else the held `main` instance — shared, and swapped by `PUT /v1/config`). That fallback is for a
     key that was **omitted**, never for one that was **named**, and the distinction lives in which method
     is called rather than in a rule a plugin author must remember: the resolver cannot tell `'planner'`
     asked as a default from `'cheep'` asked by mistake, so the caller says which it is. It is §4.6.4's
     rule for a `credentialRef` — optional means omittable, never unresolvable — applied to a model key.
     **When** a misspelled key fails depends on who can see it. The server parses the sections of the
     built-ins and the worker files, so it refuses a named key with no entry in `start()`: `llm: cheep`
     there is a startup error. A dynamic plugin's settings are opaque to the server — its factory takes
     `raw` and the loader must not inspect the section — so for it the same key fails at the first session
     build, loudly, from `resolveNamedLlm`, rather than at startup. An earlier revision of this bullet
     promised startup validation for every plugin, which the server cannot do for a class it has never seen;
     what it can guarantee for all of them is that a named key is never silently answered by `main`.
     Startup refusal for dynamic plugins would need the factory to be handed the set of `llm:` keys, and is
     left until a plugin needs it. Two temperatures change with the default, stated: a role with no entry used to get a
     fresh build of `llm.main`'s configuration as written, and now shares the `main` instance, built at
     `temperature ?? 0.7` (`smart-server.ts:1034-1037`); and `dag`, which gave an entry without a
     temperature its `mainTemp` (`build-dag-coordinator-deps.ts`, `resolveRoleLlm`), now gets the entry as
     written — a model's temperature is a property of its `llm:` entry, here as everywhere. An earlier revision of this bullet made an omitted key mean `main` for `controller`
     alone, which would have given a controller's planner `main` and a stepper's planner `helper` for the
     same YAML.
   - **`controller`'s subagents name `llm:` keys.** Each of `subagents.evaluator`, `planner`, `executor` —
     still required, `{}` allowed — carries an optional `llm: <key>` beside its `hint`. `reviewer` and
     `finalizer` stay optional and, when their **block** is absent, use the planner's key — or the
     planner's default, if it named none — which is what an absent block means today
     (`controller/types.ts:207`). A per-role temperature, which each subagent's inline
     `SmartServerLlmConfig` could carry, belongs to the `llm:` entry like every other property of a model:
     a role that wants a colder planner names a colder entry.
   - **`dag` keeps assembling its dependencies in `build(ctx)`.** Its settings — planner, reviewer and
     finalizer keys, and its static knobs — arrive in the constructor; `buildDagCoordinatorDeps` still runs
     per session, reads the workers from `ctx.workerRegistry`, and resolves each of the three through
     `ctx.resolveNamedLlm(key)` when its key was named and `ctx.resolveLlm(role)` when it was not, instead of
     receiving `llmMap` and a `makeLlm`.
   - **The DAG workers name keys too, which changes how a worker file is resolved.** The main file lists
     workers as `subagents: [{ name, config }]`; `parseSubAgents` (`config.ts:97-173`) loads each worker file
     and resolves it **on its own** as a complete `SmartServerConfig` (`resolveSmartServerConfig`,
     `config.ts:170`), validated like the main file (`config.ts:257`). So the worker file's `llm:` is a whole
     map today — `main`, from which `main` and `classifier` are built at two temperatures, and its own
     `helper` (`smart-server.ts:1849`, `:1866-1895`) — and those instances are built by `makeLlm` and cached
     per worker name, never through the resolver (`resolveWorkerLlmSet`, `workers/worker-registry.ts:117-131`).
     Under the rule:
     - a worker file's `llm` becomes **keys of the main file's `llm:` map** — a string, shorthand for
       `{ main: <key> }`, or a map of the worker's roles to keys, `{ main, helper, classifier }`, each optional.
       An omitted `helper` or `classifier` resolves as that name does for the pipeline — the held helper and
       classifier instances, or the held `main` where the main file configures no helper. These are
       behaviour changes, stated: today a worker with no `helper` entry has no helper at all
       (`worker-registry.ts:122`), and it derives its classifier from its **own** main entry at
       `classifierTemperature`, and a variant "this key at that temperature" is
       not addressable by one key; a worker that wants its own classifier names an entry for it. An inline
       LLM configuration in a worker file is refused, naming the main map;
     - `parseSubAgents` therefore resolves a worker file **with the main file's map in scope**, and its
       validation and the worker's config type change with it — `SmartServerConfig.llm`
       (`smart-server.ts:264`) stays the main file's shape, and the worker file gets its own;
     - a worker's instances come from the **same resolver** as the pipeline's, per session, so a worker
       naming `main` shares the main instance and observes a `PUT /v1/config` swap like every other role;
       only the **three LLM slots** of the per-worker-name cache give way to the resolver. The same cache
       also holds the worker's embedder, tools RAG, history RAG and MCP clients (`resolveWorkerLlmSet`,
       `worker-registry.ts:117-131`, injected at `:315-321`), and those stay cached per worker name —
       dropping them would re-vectorize and reconnect every worker on every session. `PUT /v1/config`
       already drains that cache (`config-route-handler.ts:180-182`); after this change the LLM half of a
       swap reaches workers through the resolver instead.

     The worker file keeps its other settings — prompts, and its `rag:`, which splits into `store` and
     `embedder` with their own `credentialRef` exactly like the main file's, since its store goes through
     the same `makeRag` call sites (`smart-server.ts:1915`, `:1923`) §4.6.4 counts. Whether a worker needs a
     file of its own at all is a separate question this design does not take up (§11). With that, **every
     model is configured in exactly one place, the main file's `llm:` map**, and every role naming a key
     resolves to the instance built for it. (Credentials are a different matter: `rag.store`, `rag.embedder`
     and the skill store keep their own `credentialRef`, §4.6.4, because they are not models.)

   **A dynamically loaded plugin is the one place the builder cannot parse, and its factory is builder
   code.** A module exports **already-constructed instances** — `PluginExports`'s
   `pipelinePlugins?: Record<string, IPipelinePlugin>` — and the loader merely imports and registers them
   (`llm-agent-libs/src/plugins/types.ts:110-125`, a plain `.set(name, plugin)` at `:122`). The server never
   sees such a plugin's class or its section's shape, and `parseConfig(raw)` has been the only channel such a
   plugin had for its section. So a module may export
   `pipelinePluginFactories?: Record<string, (raw: unknown) => IPipelinePlugin>` — the same factory shape the
   registry holds for built-ins — and the server calls the selected one with that plugin's section. This is
   not an exception to the rule but the rule applied to a class the builder has never seen: the factory is
   **the plugin author's piece of the assembler**, shipped beside the plugin, and the class it constructs
   takes typed settings like any other. It reaches models the same way the built-ins do, by naming `llm:`
   keys and resolving them through `ctx` — `resolveNamedLlm` for a key its section named, `resolveLlm` for
   a role's default. Exporting an instance stays valid for a plugin that needs no
   settings; the server registers it as a factory that ignores its argument.

   **What a dynamic plugin's section may carry is a convention, and the gap it leaves is named.** The loader
   must not inspect a plugin's section, and `${…}` substitution runs over the whole file in `-libs`
   (§4.6.2), so nothing *prevents* a section from writing `apiKey: ${X}` and handing its factory a secret as
   a string. The convention is that a section carries no secret and no `credentialRef` — nothing on the
   server would resolve one for it.

   **Every authorized object reaches a plugin through `ctx`, whoever registered the plugin — and that is a
   stated capability limit.** Because the registry constructs each plugin once and process-wide, a
   constructor cannot carry anything a caller's credential authorized (§4.6.5), and under this section's
   rule it carries no instance at all. So a per-caller backend reaches a plugin the way a per-caller LLM
   does: through a `ctx` member whose value the server scopes to the session, built on first use and
   disposed with it — the arrangement §4.6.6 draws for the role map and §6.4 for the RAG registry.
   A plugin — the app's own or a third party's — that needs an authorized object `ctx` does not offer has
   no channel for it, and the remedy is a **named, typed** capability, not a constructor dependency and not
   a generic dependency bag — which would be the `Record<string, unknown>` of §4.6.3 rebuilt in a new place,
   and is refused for the same reason. Where it is added decides who can use it, and that is a real cost:
   a member of `IPipelineContext` (`@mcp-abap-adt/llm-agent`) reaches every plugin, a third party's
   included, and costs a framework release; a member of `IServerPipelineContext` or an app subtype reaches
   only plugins written against that type, since one typed against `IPipelineContext` could reach it only
   through a cast principle 10 refuses. Either way the member returns an **already-authorized instance**,
   as `resolveLlm` does, so `ctx` still gains nothing auth-shaped. And the rule binds what the server
   constructs; a plugin an `IPluginLoader` hands over already built (`smart-server.ts:297`) was constructed
   by someone else with whatever they chose, so for it the rule is a convention, like the section one above.

   **And there is deliberately no credential lookup on `ctx`.** `IPipelineContext` offers specific lookups
   and instances and no credential registry, no generic factory; a credential lookup on a usage contract is
   the thing §4.6.6 exists to forbid. Under this section's rule the question it would answer does not
   arise: a plugin is given model keys to resolve, but never a **credential** reference.

   **An external plugin is runtime information, so the check belongs to the loader — and the loader is where
   it belongs rather than an exception to §4.6.3.** An imported module is `unknown` until something inspects
   it: no compiler was present at that boundary, which is exactly the case principle 10 reserves a runtime
   check for. So the rule is not "validate somewhere" but *the loader validates what it loads, and reports
   what it refuses*.

   Measured against that, today's loader is **inconsistent with itself**
   (`llm-agent-libs/src/plugins/types.ts:110-125`). For a duplicate plugin name it does the right thing: it
   pushes an entry into `result.errors` naming both the new source and the one that already held the name,
   and keeps the first. But for a **malformed** plugin it checks `typeof plugin.build !== 'function'` and then
   silently `continue`s — no error, no mention — so a mistyped export vanishes and the deployment starts
   without that pipeline, which is the same "quietly less" failure direction as §4.6.4's silent auth
   downgrade. It also checks `build` while never checking `name`, and casts with `as IPipelinePlugin` on the
   strength of that one probe.

   So: the loader checks the members the contract actually requires — `name` a string and `build` a function
   for an instance export, and a function for a `pipelinePluginFactories` entry — and every rejection becomes
   an `errors` entry naming the module, the key and what was missing, exactly as the duplicate case already
   does. A cast at that boundary is only honest after the check that justifies it. What the loader must **not**
   do is inspect a plugin's section: that shape is its factory's business, and the loader, which assembles
   nothing, has no reason to know it.

   **A factory's export is only half of what it promises, and the other half can be checked only after it
   runs.** A `pipelinePluginFactories` entry's contract is its **result** — `(raw) => IPipelinePlugin` — and
   the loader, which never calls it, can confirm only that it is a function. So the check the loader makes
   for an instance export is made again where the factory is called: when `start()` calls the selected
   entry, the value it returns must have `name` a string and `build` a function, or startup fails with an
   error naming the module, the key and what was missing — the same report the loader writes, at the first
   moment the fact exists. A factory that throws is reported the same way, with its own error attached.
   Without this, the fail-fast reporting this section promises would hold for every external plugin except
   the configurable ones, which are exactly the new path.

   **And a plugin's `name` is its registry key, checked rather than assumed.** Built-ins are registered under
   their own `name` (`smart-server.ts:1128-1137`), while an external plugin is registered under its **export
   key** (`:1138-1146`) and its `name` is never compared with it — so a module exporting
   `{ planner2: pluginNamedPlanner }` is selected as `planner2` and reports itself as `planner`, in logs and
   anywhere else `name` is read. The two must agree: the loader refuses an instance export whose `name`
   differs from its key, and `start()` refuses a factory result whose `name` differs from the key it was
   selected by, both with the same kind of `errors` entry or startup error. This is the one check here that
   can reject a plugin that works today, and it is listed with the loader's other new reports in §1.4.

   **The cost, stated because it is a framework contract and this is where such things get argued.** It is
   source-breaking for plugin authors: `parseConfig` goes, `build` loses a parameter, a configurable dynamic
   plugin exports a factory instead of an instance, and the loader begins **reporting** malformed exports it
   used to skip in silence. It is larger for the shipped plugins than an earlier draft said: four of the five
   classes lose their parser to the server and take typed settings instead, and the YAML changes shape in two
   places — `controller`'s `subagents.<role>` and a DAG worker's own config file each stop holding an LLM
   configuration and name an `llm:` key — which §8's migration note carries with a before/after. In
   exchange no component parses configuration, the registry the server holds is a map of factories only the
   server calls, and the file configures each model in one place.

   A baseline, so the change can be checked rather than assumed: none of the five shipped plugins carries a
   secret in its config today, so no deployment's secret moves as part of this; the controller's subagent
   sections carried an `apiKey` only through `SmartServerLlmConfig`, which §4.6.2 already removes.

## 5. Admission is the consumer's, and none of it is ours

Job B needs one decision-maker, built with the caller's identity, asked wherever the answer matters. That is not in dispute. What §1.4 settles is **where it lives**: the component that receives a caller's request is the only one that can judge it, and nothing in this framework receives one. Every provider here is a client of something outside.

So llm-agent ships **no admission contract and no admission step**. That is not a gap left for later — a framework that has not been given a check does not judge and does not pretend to permit (§1.2), which is also exactly what it does today. Nothing changes because nothing needs to.

**And the contract does not go into `interfaces-auth` either.** `AccessCheck<R> = (request: R) => Promise<boolean>` is one line, and a line belongs to whoever accepts it. The acceptors are assemblies that face users — cloud-llm-hub certainly, `llm-agent-server` perhaps — which is *one consumer today*, not several packages across the family. The placement rule puts it in the consumer. If a second repository later accepts the same shape, that is the moment it moves up, and not before.

**What llm-agent does contribute is the inputs to someone else's decision**, and it is careful to contribute nothing more:

- the typed owner keys on collection creation, `scope`/`sessionId`/`userId`, which the framework itself reads to address a store and to end a session (§6.3);
- opaque `attributes`, persisted on create and handed back unread, so a consumer's rules survive a restart (§6.3);
- identity in `CallOptions` — `sessionId`, `userId`, `ragFilter.userId` — which is identity and never a secret (§4.1).

Each is a fact the consumer asked us to keep. None is a judgement.

cloud-llm-hub shows what a **server** does with those facts — and what happens when it has to guess them instead:

- ABAP tools: `assertToolAllowed(toolName, toolExposition, allowed)` in `srv/lib/tool-authorization.ts`, deny by default; roles come from request options *or* an async-local store, because — per `srv/agent-manager.ts:348` — tool selection runs twice per request and the second pass rebuilds its own options.
- RAG collection tools: a module-level `dispatchRagTool(registry, name, body)` deriving identity per call from `cds.context?.user?.id ?? 'anonymous'`.

Both workarounds exist because identity had to be recovered rather than passed. Passing it is what §6.3's typed keys and `CallOptions` are for; deciding with it stays the hub's.

### 5.1 Authorization happens at construction, and the instance *is* the enforcement point

§5 says admission is the consumer's. Read alone, that invites a fair objection: the consumer authorizes an arriving HTTP request, but *which* collection and *which* operation are chosen later, when the model calls a tool. If nothing judges at that moment, what stops a caller's tool call from naming someone else's collection?

The answer is that nothing needs to judge at that moment, because **the instance the tool operates through was built for one caller**. One external user, one session, one pipeline, its own instances (§4.1). Authorization is performed once, when that pipeline is constructed, by deciding *what the instance can reach at all*. By the time the model names a collection, the only names that resolve are that caller's own and the globals; another caller's collection is not refused, it is **absent**.

**The line this must not cross.** Narrowing what is addressable is the framework reading its own typed owner keys — the same keys it already reads to name a store and end a session (§6.3). That is addressing. Deciding whether an addressable thing *may* be read or written is policy, and policy does not enter a client (§1.4). So the tool entries are built with the caller's **identity**, never with a check:

```ts
buildRagCollectionToolEntries({ registry, identity })   // identity narrows the address space
buildRagCollectionToolEntries({ registry, check })      // rejected: a policy inside a client
```

**Whose type, and declared where.** `identity` is `{ readonly sessionId: string; readonly userId?: string }`, declared in `@mcp-abap-adt/llm-agent` beside the tools as `RagCallerIdentity` — not imported. `SessionGraphIdentity` is the same shape but lives in `llm-agent-libs`, and the dependency runs `llm-agent-libs` → `llm-agent`, one way, so the tools cannot reach it. Nothing is lost by declaring it locally: the shapes are structurally identical, so a consumer hands a `SessionGraphIdentity` straight in with no conversion — which is the same reason §4 keeps its contracts plain shapes rather than nominal types.

The difference from the `createFor(identity, check)` that §6.2 deletes is exactly the second argument. Binding identity at construction was never the mistake; binding a decision was.

**`identity` is required, and that is a source break we are choosing.** `buildRagCollectionToolEntries({ registry })` compiles today and is exported from the package root (`rag/mcp-tools/index.ts` → `rag/index.ts:4` → `index.ts:33`), so requiring the second field breaks any external caller of the old form — that no consumer exists in these repositories is luck, not an argument. It is still the right shape, and an optional `identity?` would be the wrong one: omitting it would have to mean "do not narrow", which is an unnarrowed address space reached by forgetting a field. That is the hub's `?? 'anonymous'` in a new place, and §1.2's "absent means absent" does not license it — absent *judgement* is honest, an absent *address space* is everyone's. No overload without `identity` is kept: the point of the break is that the unsafe call can no longer be written. It is listed in §8's release shape and its migration note.

**The gap this closes is real and present today**, and workstream 3 exists to close it. Measured in `packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`:

| tool | identity today | what a shared registry lets it reach |
|---|---|---|
| `rag_add`, `rag_correct`, `rag_deprecate` | `_ctx` — ignored (`:61`, `:87`, `:128`) | writes any collection resolvable by name |
| `rag_list_collections` | `_ctx` — ignored (`:155`) | returns every registered collection's metadata, other users' included |
| `rag_describe_collection` | `_ctx` — ignored (`:171`) | any collection by name |
| `rag_create_collection` | uses `ctx` for the owner keys (`:266`) | correct |
| `rag_delete_collection` | compares owner keys (`:200`, `:208`) | correct, and for the right reason |

Five of seven ignore the context they are handed. `rag_delete_collection` is the one that shows the intended shape — and note *what* it does: it compares owner keys, which is addressing, and it refuses global deletes outright rather than deciding who may.

**Which globals a caller may read is decided where the registry is built, and the tools never read it.** An earlier revision of this paragraph had the tools read `public` globals and refuse `role` ones — which no contract here could implement: `authorization` is stored inside the opaque `attributes` (§6.3), the framework interprets no policy (§1.2), and nothing hands a tool the value. It is also the wrong place to ask. §6.4 already has the consumer build each caller's registry — hydrating that caller's collections and deciding "how a session registry comes to see the `global` collections" — and the consumer reads the record's `attributes` there, where the policy is its own. So a `role` global a caller may not reach is simply **not in that caller's registry**, which is §5.1's construction-time narrowing applied to globals: the tools address what they were given, and what they were given is already the answer. The framework's own tools therefore draw only one line, between reading and mutating:

| | the caller's `session` / `user` collections | a `global` in the caller's registry |
|---|---|---|
| read (`rag_list_collections`, `rag_describe_collection`, query) | yes — the address space is the caller's | yes — it is there because the consumer put it there |
| mutate (`rag_add`, `rag_correct`, `rag_deprecate`) | yes — the caller owns them | **refused** |
| delete (`rag_delete_collection`) | yes, owner keys compared | **refused** (already true today, `:193`) |
| create (`rag_create_collection`) | yes, owned by the bound identity | **refused** — `global` leaves the tool's `scope` enum |

A consumer that shares one registry across callers (§6.4 says what that costs) gets every global it holds readable by every caller, which is what sharing it means.

**The tools address a collection by name and, where that is ambiguous, by scope.** A caller's registry may hold a `global`, a `user` and a `session` collection of one name (§6.4), so every tool that takes a collection name — `rag_add`, `rag_correct`, `rag_deprecate`, `rag_describe_collection` and `rag_delete_collection` — gains an optional `scope` argument and passes it to the registry. A name one scope holds needs none; a name several hold, given without a scope, is refused with `RAG_AMBIGUOUS_COLLECTION` naming the scopes, so the model is told to choose rather than silently handed one; `rag_list_collections` already reports each collection's scope (`rag-collection-tools.ts:147-164`), which is how it learns what to pass. Querying is not a tool here: it goes through the `ragStores` projection, keyed as §6.4 sets out. `rag_create_collection` already takes its `scope` — now `session` or `user` only, above — and a taken (scope, name) is refused there — `RAG_DUPLICATE_COLLECTION` when it has a record, `RAG_ORPHAN_STORE` when only its store exists (§6.3).

**Reachable licenses reading, never writing**, and nothing in §6.1's two axes says otherwise: `public` and `role` are values about who may *reach* a global, and neither describes who may change one. Letting `rag_add` write a global because the caller can reach it would be the framework inventing the rule that reachable implies writable — a policy, decided by us, on shared data, for every consumer. So framework tools mutate **no** global, whatever its authorization value — and **creating** one is a mutation too: `rag_create_collection` accepts `scope: 'global'` today (`rag-collection-tools.ts:247`), which would let any caller put a collection into every caller's address space. Its schema narrows to `session | user`. `IRagRegistry.createCollection` keeps `global`, because a consumer creating a deployment's shared collection in its own code, behind its own check, is exactly the boundary this paragraph sends such writes to; exactly as `rag_delete_collection` already refuses every global delete. A consumer that wants global writes mounts its own tool with its own check; that is not a limitation of this design but the whole of it. Refusing is not policy; it is declining to act with no basis, which is §1.2. A consumer that wants that case mounts its own tool, with its own check, on its own side of the boundary.

**One source of identity, and the per-call one goes.** Binding identity at construction while a handler still reads owner keys from its per-call `RagToolContext` leaves two sources and no rule, and `rag_create_collection` reads exactly that today (`:266-267`). Two sources is the failure principle 8 names in its other half: a per-call identity that disagrees with the instance does not fail, it acts as somebody else — here, creating a collection owned by an identity the address space was never narrowed to.

So the **construction-bound identity is the only source**, and `RagToolContext`'s declared `sessionId?` and `userId?` are **removed** rather than ignored or cross-checked. Ignoring them leaves a field that looks authoritative and is not; cross-checking them makes every call site restate what the instance already knows, and turns a mismatch into a runtime error where there should be no channel to mismatch on. Removing them is also nearly free: `RagToolContext` declares `[key: string]: unknown` (`:15`), so call sites passing those keys keep compiling — they simply stop meaning anything, and no handler can read them as identity.

What stays per-call is what is genuinely per-call and is not identity: the free-form context the index signature carries. `rag_create_collection` then takes its owner keys from the bound identity, which is the same identity that decided what the instance can address — one fact, read once, used everywhere.

**What llm-agent contributes:** `buildRagCollectionToolEntries` returns the seven entries. It has no consumer today (§9.7), which is why five handlers could ignore the context and a sixth could trust it without anyone noticing.

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

The axis stores a **policy value**, nothing more: whether *this* caller may delete *that* global collection is the consumer's decision, read from the value, never encoded in it and never made here. `RagCollectionScope` needs no new member: the earlier "fourth scope for roles" conflated the two axes. **Skills are an ordinary collection** under the same axes, not an exempt "configuration" kind — this supersedes cloud-llm-hub's collection-model spec, retired in hub commit `ae1e0e4b`.

### 6.2 Service or delegated identity is which credential was passed, and nothing more

A credential on a RAG provider proves who **we** are to the store; it says nothing about the caller. Whether the store can see the caller is decided entirely by **which credential the consumer handed to the constructor** — the service’s, or that caller’s own. That is the whole mechanism, and §4.2 already named the two cases, so this section adds no second vocabulary for them.

**An earlier draft of this section is deleted, and why matters more than what it said.** It declared an `IRagProviderSource` union with `identityMode: 'service' | 'delegated'` and a `createFor(identity, check)` that bound an `AccessCheck` into the provider, arguing that a construction-time binding cannot be forgotten by a call site. That argument was right about forgetting and wrong about ownership: it turned a client into a wrapper around a server. A provider receives no caller’s request, so it has nothing to judge (§1.4), and the check belongs to the assembly that does receive one (§5). Once the check is gone, `createFor` carries nothing a constructor argument does not, and the union has nothing left to discriminate.

What survives, unchanged in substance: a provider built with the service credential shows the store one identity for everyone; a provider built with the caller’s credential shows it that caller. The first may be shared, the second may not — which is not a rule about RAG but §4.1’s transparent/opaque distinction reaching this far down.

| store | sees today | to see the caller |
|---|---|---|
| PostgreSQL | the service user of a shared `pg.Pool` | a connection per identity, or `SET LOCAL` in a transaction with RLS policies reading it |
| HANA | the `uid`/`pwd` from configuration | the caller's JWT — supported by HANA; **which client properties carry it is unverified** |
| Qdrant | the holder of one `api-key` | a claim-restricted token; our client sends only `api-key` — **unverified** |
| OpenAI, Anthropic, AI Core | the service, always | impossible — our users do not exist there |

**Two of those rows say what is possible, not what we will do.** Reaching PostgreSQL per identity, or HANA with the caller’s JWT, is delegation a consumer may build by passing a credential we accept. The framework performs none of it, and §9.1 leaves the unverified halves unverified rather than planning on them.

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
createCollection(name, opts: RagCollectionOwner & {  // scope + the owner key it requires — typed (below)
  attributes?: RagJsonValue;      // role and policy only — opaque, persisted, never interpreted
})
```

- Both owner keys stay typed. §6.1's "owner is implied by scope" needs a typed owner to read it from; only role and policy are opaque.
- **The provider persists `attributes`** and hands them back **unread**, to whoever asks. It does not consult them, because it has nothing to decide (§1.4). Today it persists nothing: pg and qdrant use the creation options only for `checkScope` and the id strategy, so a provider decides nothing after a restart or in a second instance.
- **This needs a catalog, not row metadata.** In pg a collection *is* a table, created per collection with `metadata JSONB` on each **row** (`schema.ts`) — there is nowhere to put a collection-level fact. Each provider therefore gains a small catalog of its own, **created if absent by whatever means its backend supports** — which statement that is belongs to the implementation and not to this design, for the same reason the paragraph on `openCollection` gives. In Qdrant it would be a catalog collection holding one point per collection (**unverified**: Qdrant exposes no collection-level metadata we have checked). Written by `createCollection` **last**, after the store exists, and deleted by `deleteCollection` **first**, before the data (both below). Additive: the catalog appears on first use.
- **A collection created before the catalog existed hands back `undefined`.** The provider does not invent attributes for it, and what an absent value means is the consumer's check to decide, outside this framework — which holds no opinion (§1.2, §5).
- `supportedScopes` keeps its meaning — what a provider can make *outlive* — which is lifetime, not permission.

**Persisting them is half a contract; reading them back is the other half.** As written above this section promised survival across a restart and specified only the write. Measured, there is no path back: `IRagProvider.listCollections?()` returns `Promise<Result<string[], RagError>>` — names and nothing else (`interfaces/rag.ts:217`) — and `IRagRegistry.list()` returns `readonly RagCollectionMeta[]` from memory (`:171`), which after a restart is empty. So the guarantee was unimplementable as specified. The read contract is therefore part of this design, not of the plan:

```ts
/** What a catalog can store and give back unchanged on every backend: JSON, with
 *  finite numbers only. `unknown` admitted cycles, BigInt, functions and class
 *  instances, which the three backends cannot round-trip alike. */
type RagJsonValue =
  | null | boolean | number | string
  | readonly RagJsonValue[]
  | { readonly [key: string]: RagJsonValue };

type RagCollectionRecordBase = {
  /** What the PROVIDER knows the store by — `storeNameFor`'s output. */
  readonly storeName: string;
  /** The LOGICAL name the registry registers it under. Must be persisted; see below. */
  readonly name: string;
  readonly attributes?: RagJsonValue; // opaque, returned exactly as stored
};

/** The scope is required and selects its owner key. One type, used by the record
 *  AND by both createCollection contracts, so no layer can hold a user or session
 *  collection without its owner. */
type RagCollectionOwner =
  | { readonly scope: 'global' }
  | { readonly scope: 'user'; readonly userId: string }
  | { readonly scope: 'session'; readonly sessionId: string };

/** A record says whose it is, or it is not a record at all. */
type RagCollectionRecord = RagCollectionRecordBase & RagCollectionOwner;

// on IRagProvider — NEW and optional, never a widening of listCollections()
describeCollections?(): Promise<Result<{
  readonly records: readonly RagCollectionRecord[];
  /** Catalog rows that are not valid records — reported, never returned as records. */
  readonly rejected: readonly { readonly storeName?: string; readonly reason: string }[];
}, RagError>>;

// on IRagProvider.createCollection's opts — the logical name and the attributes,
// because a catalog cannot return what it was never given
createCollection(name: string, opts: RagCollectionOwner & {
  collectionName?: string;           // the logical name; `name` is the store name.
                                     // Absent → the provider records `name` as the logical name too
  attributes?: RagJsonValue;
  adoptExisting?: boolean;           // take over a store that exists without a record; never create
}): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

// on IRagProvider — NEW and optional: build handles for a store that EXISTS.
// Creates nothing, ensures nothing, writes no catalog row — now or on any later
// call through the handles: an operation on a store that is gone fails.
// No handle, from here or from createCollection, ever creates its store (below).
openCollection?(record: RagCollectionRecord): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

// on IRagRegistry — NEW and optional: register an EXISTING store, no creation
// providerName: which registered provider owns the store — a record cannot say,
// because a provider does not know the name it is registered under
adopt?(record: RagCollectionRecord, rag: IRag, editor?: IRagEditor, providerName?: string): void;

// on IRagRegistry.createCollection's params — `attributes` gains a way in, and is
// handed to provider.createCollection with the logical name, unread (§9.5)
createCollection(params: {
  providerName: string;
  collectionName: string;            // logical — passed on as opts.collectionName
  displayName?: string; description?: string; tags?: readonly string[];
  attributes?: RagJsonValue;         // NEW — opaque, passed through unchanged
  adoptExisting?: boolean;           // NEW — forwarded to the provider unchanged
} & RagCollectionOwner): Promise<Result<RagCollectionMeta, RagError>>;  // owner: was scope + optional keys

// RagCollectionMeta does NOT gain `attributes`: the tools read metadata, and
// nothing a tool does may depend on a policy value (§5.1). The consumer reads
// them from describeCollections() when it builds a caller's registry.
```

**A record names its scope and its owner, or it is not a record.** Hydration sorts records into a caller's `global`, `user` and `session` collections, and a record without a scope — or a `user` record without a `userId` — cannot be sorted: guessing would put someone's collection in someone else's registry. So `scope` is **required** and selects the owner key it needs, which `createCollection` always has, since it receives both. And because the catalog is storage outside any compiler — rows a previous version, an operator or a damaged write may have left — `describeCollections()` checks each row at that boundary (principle 10's case, the same as the plugin loader's in §4.6.7): a row with no scope, an unknown one, a missing owner key for its scope, no store name or no logical name is **not returned as a record** but listed in `rejected` with its store name where it has one and what was wrong, so the consumer can report it. One malformed row neither fails the call nor slips into a registry.

**The same owner rule holds on the way in.** Both `createCollection` contracts take `RagCollectionOwner` rather than `scope` beside two optional keys, which admitted `{ scope: 'user' }` with no `userId` — and `storeNameFor` then digests an empty owner (`simple-rag-registry.ts:37-42`), so every caller missing its key would share one store: the cross-user collision this design removes. With the union that is a build error, for creation and for `adoptExisting` alike. For a caller no compiler checked, both `createCollection`s also refuse a `user` or `session` owner whose key is absent or empty, with `RAG_INVALID_OWNER`, **before touching the backend** — the same boundary check, at the other end of the catalog.

**`attributes` are JSON, and a value JSON would change is refused.** "Returned exactly as stored" is a promise across three backends, and `unknown` could not keep it: a cycle, a `BigInt`, a function or a class instance has no common stored form. So the type is `RagJsonValue`. What the type still admits and JSON would alter — `NaN` and the infinities, which it turns into `null`, and a cycle reached through an untyped caller — `createCollection` refuses with `RAG_INVALID_ATTRIBUTES` before creating anything, so what comes back is what went in. How a provider stores the value is its own; pg's `JSONB` already takes it as is.

**Two identifiers, because the provider never sees one of them.** `SimpleRagRegistry.createCollection` computes `storeName = storeNameFor(params)` and calls `provider.createCollection(storeName, …)` (`simple-rag-registry.ts:189`, `:193`), so the provider is handed the store name *as* the name. It does already receive the owner keys — `{ scope, sessionId, userId }` are in its signature (`interfaces/rag.ts:209-216`) — and what it never receives is the **logical** `collectionName`.

And it cannot derive it. `storeNameFor` (`:31`) returns `${base}_${digest}`, where `digest` is 12 hex characters of a SHA-256 and `base` is the logical name with every `[^a-zA-Z0-9_]` replaced by `_` and then truncated to fit 63 characters. The prefix is a readable hint, not the name: two different logical names collapse onto one base, and a long one loses its tail. So a catalog keyed only on what the provider was given can return the physical name and nothing else, and after a restart a consumer would know a store exists without knowing what to call it. The logical name must therefore be **written** into the catalog, which is why `createCollection` gains it alongside `attributes`. It stays **optional**, because `createCollection` is also called directly (§9.5 below), and a direct caller that names its store has no second name to give: when `collectionName` is absent the provider records `collectionName ?? name`, so `RagCollectionRecord.name` is always filled. That is the same assumption `register` already makes — store name and logical name are one — and it is exact for such a caller, since nothing hashed its name. Making it required instead would break every direct caller for a value they do not have.

**And hydration needs its own member, because `register` cannot express it.** `SimpleRagRegistry.register(name, …)` sets `storeName: name` (`:99`) — it assumes the two are the same, which is true for a collection registered directly and false for every hydrated one. `adopt?()` takes the record whole, so the logical name and the store name stay distinct, and it never creates anything: the store is already there. Optional on `IRagRegistry` so an external implementation of that interface is not broken by gaining a member.

**A collection is its scope, its owner and its name — and a taken name is an error.** The store name is already derived from exactly those three (`storeNameFor`, `simple-rag-registry.ts:31-50`), so the same collection of the same owner always has the same store, and that is kept. What is added is the rule that makes it safe: **`createCollection` refuses a name that is taken, in either of the two places it can be taken.**

- **A record exists** → `RAG_DUPLICATE_COLLECTION`, the code it returns today for a name its own registry holds. A collection can be created again only once its deletion has finished and its record is gone.
- **No record, but the store exists** → `RAG_ORPHAN_STORE`, naming the store. It means *a store without a record at this moment*, and the moment can be transient: another session of the same owner may be creating that collection (its store made, its record not yet written) or deleting it (its record gone, its data not yet). The duplicate checks live in one registry, and two sessions have two (§6.4), so the refusal is correct — the name is taken — but a caller that gets it and retries a little later may find a finished collection or a free name. This is the case determinism would otherwise turn into a resurrection: a store left behind by a data deletion that failed after its record was gone, by a creation whose record write failed (below), or by a release before this one, which kept no catalog. A create that silently reused it would hand the new collection the old rows — on pg and hana, whose `ensureSchema` is `CREATE TABLE IF NOT EXISTS` (`pg-vector-rag/src/schema.ts:25`, `hana-vector-rag/src/schema.ts:21`), that is exactly what today's code would do. So the provider creates a store with an operation that **fails, rather than succeeds, when the store is already there** — which operation is its own business, and this design relies only on the outcome, not on what a backend does with a repeated create — and turns that failure into the refusal.

**An existing store is taken over only on purpose.** `IRagProvider.createCollection`'s options and `IRagRegistry.createCollection`'s params both gain `adoptExisting?: boolean`, the registry forwarding it: with it, a store that exists and has no record is recorded as this collection instead of refused, and nothing is created. A store that does **not** exist is refused rather than created — adoption takes over what is there, and a caller who meant to create omits the flag. The reach is exactly the stores whose name the registry computes: those created by v26.x, since `storeNameFor` arrived in v26.0.0 (#301). A collection from v25 or earlier was stored under its logical name (the registry passed `collectionName` straight to the provider), so the registry will never find it; a consumer that wants one back calls the provider directly, `provider.createCollection(oldName, { …, adoptExisting: true })`, and registers the handles it gets. That is the one deliberate path for the two legitimate cases — a collection from before this release, and an orphan its owner wants back rather than removed — and it is the consumer's call, never a tool's: `rag_create_collection` does not pass it. A store with `autoCreateSchema: false` is always this case, since an operator creates its tables: `createCollection` then requires the store to exist, refuses with the backend's own error if it does not, and records it.

**Creation is committed by the record, which is written last — and only if absent.** A catalogued provider's `createCollection` creates the store first and writes the record after it, with a write that **refuses an existing record** (create-if-absent, however the backend expresses it). That is what makes the cross-session case lose cleanly: two creations or two adoptions of one identity from different registries cannot both commit, and the loser gets `RAG_DUPLICATE_COLLECTION` and leaves the store alone — the winner's record points at it. So a creation's outcome is decided by the record, so a record always means the store exists — which is what lets hydration trust it, and lets `openCollection` build handles without creating anything:

- **The store's creation fails** → nothing was recorded; the call fails as it does today, or with `RAG_ORPHAN_STORE` when the store was already there.
- **The record's write fails** → the provider **leaves the store where it is** and returns the error, naming it. It does not remove it, for a reason no amount of care inside one call can remove: between its failed write and any removal, another registry — another session of the same owner, which shares no lock with this one — may see a store without a record, adopt it with `adoptExisting`, and commit a record pointing at it; a removal then would leave that record without a store, the one state this section exists to prevent. An earlier revision removed "the store this call created", then only one "no record points at"; both checked something another registry could change before the removal ran, and a check-then-delete across registries cannot be made atomic from inside one of them. So the store is an orphan, visibly: the identity is refused with `RAG_ORPHAN_STORE` until its owner adopts it (`adoptExisting`) or removes it. That costs a stray store on a rare failure and never a record without data.

**And no handle ever creates its store — `createCollection` does, and only it.** Two shipped providers create lazily today. `qdrant-rag` creates on the first write (`_ensureCollection`, `qdrant-rag.ts:99`, called at `:165` and `:454`), because Qdrant fixes a collection's vector size at creation and `IEmbedder` does not declare one (`interfaces/rag.ts:15-17`); its `createCollection` therefore learns the size by embedding one probe string and creates the collection then — one embedding call per collection created, none per write. Lazy creation survives in one place, deliberately: a standalone `QdrantRag` that `makeRag` builds for a store the YAML configures is not catalogued and still creates its collection on the first write, so `QdrantRag` gains `autoCreateCollection` (default `true`) and every handle the **provider** builds passes `false`. And the create-if-absent record write needs Qdrant's `update_mode: "insert_only"`, which exists from **Qdrant 1.17**: a catalogued Qdrant store therefore requires 1.17 or later, which the migration note states. `pg-vector-rag` and `hana-vector-rag` create in `createCollection` (`ensureSchema`, `pg-vector-rag-provider.ts:84`, `hana-vector-rag-provider.ts:105`), **but their handles also create**: `maybeEnsureSchema()` runs `ensureSchema` before a query, an upsert or a write while `schemaReady` is false (`pg-vector-rag.ts:94`, and the same in `hana-vector-rag.ts`). A handle `createCollection` returns has already run it; a fresh one — which is what `openCollection` builds — would issue `CREATE TABLE IF NOT EXISTS` on its first use, and a stale hydrated handle in another session would recreate a deleted table. So `openCollection` builds its pg and hana handles with the schema marked ready and lazy creation off. Lazy creation cannot survive the record-last rule on any provider: a record would exist before its store, and a stale handle would recreate the store with no record, where no hydration finds it and no deletion reaches it. A write through any handle to a store that is gone fails.

**`adopt` needs handles, and a record is not one — so opening is its own member.** `describeCollections()` returns metadata; the only existing way to obtain an `IRag` and an `IRagEditor` is `IRagProvider.createCollection`, and it cannot serve here. Measured across the three shipped providers, they do not even agree on what it does: `pg-vector-rag` and `hana-vector-rag` call `await rag.ensureSchema()` inside it (`pg-vector-rag-provider.ts:84`, `hana-vector-rag-provider.ts:105`), issuing DDL; `qdrant-rag` issues nothing and defers creation to `_ensureCollection` on first use. **And whether a second call is harmless is not something this design may reason about.** An earlier draft of this paragraph argued it was safe today because the DDL says `IF NOT EXISTS`. That argument is inadmissible twice over. It answers a question about a *contract* with the text of one implementation, which §4 forbids. And it is not even a fact: `IF NOT EXISTS` on `CREATE TABLE` is a server-version capability, PostgreSQL and SAP HANA are each many versions, HANA Cloud and on-premise differ again, and the same statement is sent to all of them from one string. What a given backend does with a repeated create is unknown from here and must stay irrelevant here. The contract never promised idempotence, so nothing may rely on it — that alone settles it, and it settles it for every backend rather than for the two we happened to read.

And the accident ends with this very workstream: once `createCollection` also writes a catalog row, calling it to hydrate would rewrite that row, and — since a hydrating caller passes no `attributes`, it is reading them — overwrite what it was trying to recover. So `openCollection?(record)` is separate by necessity, and it is cheap: it is qdrant's existing body, and pg's and hana's minus the `ensureSchema` call — with one requirement on the handles it returns, below.

**`adopt` is told which provider owns the store, because nothing else can tell it.** A deletion reaches the data through the provider that created the collection, and `SimpleRagRegistry.deleteData` returns success and calls nobody when an entry has no `providerName` (`simple-rag-registry.ts:280-281`). A hydrated entry without one would therefore report a successful delete, leave its catalog record, and come back at the next hydration. The record cannot carry the name — a provider does not know what it is registered as — so the hydrating consumer, which called that provider's `describeCollections`, passes it to `adopt`.

**The hydration flow, whole:** the consumer calls `describeCollections()`, reports what it `rejected`, keeps the `records` belonging to the caller whose pipeline it is building, calls `openCollection(record)` for each, and `adopt(record, rag, editor, providerName)` to register them under their logical names. Nothing in that path creates a store, ensures a schema, or writes a catalog row — which is what "creates nothing" has to mean to be worth saying. The registry it hydrates into is that caller's, not a shared one (§6.4).

**Deletion has to reach the catalog, or hydration undoes it.** A record that outlives its collection is not a stale row, it is a resurrection: the next hydration adopts a collection whose data is gone and hands the caller something that looks valid. So the **provider's** `deleteCollection` removes the catalog record too.

**Where the ordering lives: inside the provider.** The catalog is the provider's own storage — each gains one, per the catalog bullet above — so record-before-data is its invariant to keep, and the registry's algorithm changes in two places — it unregisters **and reserves the name**, then makes the one `provider.deleteCollection(storeName)` call it makes today, the typed failure travels back up through the `Result` it already returns, and **on `CatalogRecordDeleteError` alone it re-registers the entry it just removed** (below). A registry orchestrating two phases would have to know whether a given provider has a catalog at all, which is precisely the implementation detail a contract must not carry (§4).

**The order is unregister, then — within that one provider call — the record, then the data** — and an earlier draft of this paragraph got it wrong in a way worth recording. It asked for a failed record deletion to “fail the operation and leave the collection accessible”, which cannot be done and should not be: `SimpleRagRegistry.deleteCollection` unregisters as its first act and says why in its own comment — *“It is unregistered first, whatever follows, so nothing can reach it again”* (`:246-258`). That invariant exists so nothing reaches a collection mid-deletion, and trading it away to satisfy a sentence would be the worse bargain.

Keeping it costs nothing, because reachability was never the point:

- **The record's deletion fails** → stop, and do not touch the data. Record and data both survive intact, so the deletion did not happen, and the registry **re-registers the entry it removed** — the same handles, which are still valid because nothing behind them changed — before returning the error. An earlier revision called this "fully retryable" while leaving the entry unregistered, which was true only after a new session re-hydrated it: a second call of the same delete tool would not find the collection, and `closeSession` would have no victim to retry. With the entry restored, both retry in place. Unregistering first still holds its purpose — nothing reaches a collection **while** it is being deleted — and restoring it afterwards is not a breach of that: the deletion is over, and it failed.

  **Restoring needs the name to be still free, so the deletion reserves it.** Between the unregister and the provider's answer the name is otherwise open, and a `createCollection` of the same collection could register a new entry that the restore would then collide with or overwrite — the catalog's own refusal does not cover this, because the record still exists until the provider's first step runs. The registry already solves the twin case for creation: a `creating` set of names whose creation is still running, counted by the duplicate check (`simple-rag-registry.ts:160-165`), because "two at once would share one store". Deletion gets the same, a `deleting` set, keyed like the `creating` set now is — by scope and name, so a running creation of the user's `docs` no longer blocks the session's `docs` (`:69`, `:162-175`). It replaces the `deletions` map (`:67`), under which a creation of the same store **waited** for the deletion to finish (`:191`): a taken name is now refused, not queued, as everywhere else in this section. No production caller relies on the queueing — `rag_delete_collection` awaits the deletion before returning (`rag-collection-tools.ts:215`) and `closeSession` deletes sequentially — but two tests encode it and are rewritten on purpose: *"the same owner creating the collection while its deletion runs waits for it"* (`__tests__/simple-rag-registry.test.ts:559-590`) now expects a refusal, and *"another user creating the same name while a deletion is still running does not open its store"* (`:544-557`) now expects the second user to be refused too, since in a registry shared across users the reservation is keyed by scope and name without the owner — a cost of sharing one registry that §6.4 already names. The name is absent to `get`, `getEditor` and `list`, so nothing reaches the collection, and present to the duplicate checks of `createCollection`, `register` and `adopt`, which refuse it with `RAG_DUPLICATE_COLLECTION`. `createCollection` already returns that code in its `Result`; `register` and `adopt` are synchronous and return `void`, so they **throw** a `RagError` carrying it — `register` today throws a plain `Error` for a duplicate (`simple-rag-registry.ts:91-93`), and since `RagError` extends `Error` through `SmartAgentError`, a caller catching `Error` is unaffected while one that checks the code can now tell a reservation or a duplicate from any other failure. Their signatures do not change. The reservation ends when the provider answers: replaced by the restored entry on `CatalogRecordDeleteError`, dropped otherwise. It is keyed like every registry entry, by scope and name (§6.4), so reserving the user collection `docs` leaves a session collection `docs` untouched.

  **A registry is one session's, and a user's collections are seen by several — so a deletion reaches the other sessions through the store, not through their registries.** Two sessions of one user hydrate the same `user`-scoped collection into two registries, each with its own handles, and a reservation or an unregister in one is invisible to the other. Coordinating them would need a registry shared by the owner's sessions — the shared object §6.4 exists to remove — so the design does not coordinate them. It does not need to, because of the two rules above: no handle creates its store, so a handle whose collection was deleted elsewhere **fails** on its next use instead of resurrecting the store; and a collection created again under the same identity is the same collection, so a handle that reaches it reaches its own owner's data. That is true for isolation and not more, and the rest is stated: a stale handle in another session whose collection was deleted and created again **writes into the new collection** — including `rag_correct` and `rag_deprecate` aimed at document ids and canonical keys the new collection never had — and identity does not include the embedder, so a collection re-created with another one takes that handle's vectors either not at all (another dimension: the write fails) or silently incompatibly (the same dimension, another model). A consumer for whom that matters rebuilds the other sessions' registries when it deletes; the framework does not track them. What the other session sees is stated rather than improved: its list still names a deleted collection until its registry is rebuilt, and each use fails loudly; a collection another session created appears only at the next hydration. Deleting a `user` collection while the user has other sessions is therefore allowed and safe, but not coherent across them, and a consumer that needs coherence builds it on its own side.
- **The record is gone and the data's deletion fails** → as today: unregistered, gone for the caller, and the orphaned store named in the warning (`:220-225`). Nothing adopts it by accident: a later create of that identity is refused with `RAG_ORPHAN_STORE` naming it (above), until it is removed or adopted with `adoptExisting`.

**The two phases must be tellable apart, and one `Result` cannot do it.** `IRagProvider.deleteCollection?` returns an undifferentiated `Result<void, RagError>` (`interfaces/rag.ts:218`), and the tool turns *any* error into `{ ok: true, warning: "… was removed, but its data could not be deleted" }` (`:220-225`) — so a record failure would be reported as data loss after a successful removal, which is wrong twice. The failure therefore names itself, which is how this codebase already works (`ReadOnlyError`, `DeleteUnsupportedError`, `SessionCloseIncompleteError` and the rest of `rag/corrections/errors.ts`) and what interfaces decision 25 asks for: a `CatalogRecordDeleteError extends RagError` (code `RAG_CATALOG_RECORD_DELETE`, carrying the `storeName`), no phase flag on the result. The tool then answers `{ ok: false }` for that one and keeps today's warning for the rest.

**`closeSession` inherits this, but less automatically than claimed.** It does call `deleteCollection` per victim and aggregate what failed into `SessionCloseIncompleteError` (`:324-334`), so the mechanism carries over — with one change, that it now deletes each victim with `scope: 'session'` (§6.4). What it cannot do by itself is distinguish a retryable record failure from an orphaned store — the typed error is what carries that through the aggregate, which is the second reason for typing it rather than flagging it. And because the registry restores the entry on that error, a `closeSession` retried after a record failure finds the same victim again.

Each is a **new** optional member rather than a widening, for the reason §4.6.2 gives: a provider is something consumers *implement*, so widening a return type breaks every implementation, while an optional addition breaks none. A provider without a catalog simply does not declare it.

**Hydration is explicit, consumer-triggered, and per caller — never automatic.** The framework does not repopulate a registry at startup, for two reasons. When to do it depends on the assembly, and choosing a moment would install a privileged topology (§1.3). More importantly, hydrating one shared registry with every collection the catalog holds would hand every caller an address space containing everyone else's collections — precisely the widening §5.1 exists to prevent. So the consumer reads the catalog and registers what belongs to the caller whose pipeline it is building, which is the same construction-time act as §5.1: the registry a caller reaches contains that caller's collections because that is what was put in it.

**Hydration is also, from this release, the only way back to a collection after a restart — and that is a break, not an option.** Today a fresh registry reattaches a `user` or `global` collection by **creating it again**: the same identity yields the same store, which the `storeNameFor` comment promises (*"so a user or global collection finds its data again after a restart"*, `simple-rag-registry.ts:25-27`) and a test pins (`__tests__/simple-rag-registry.test.ts:531-542`). A taken name is now refused, so that call returns `RAG_DUPLICATE_COLLECTION` for a collection with a record and `RAG_ORPHAN_STORE` for one without; the comment and the test change with the rule. `SmartServer` hydrates (§6.4), so the shipped server is unaffected; every other assembly that re-creates its collections at startup must hydrate instead, and §8's migration note says so. Until something hydrates the registry is empty, and a collection whose `attributes` were never written hands back `undefined` — which the bullet above already covers.

Who writes `attributes`: the component that knows the caller, and that is never the model. A consumer calling `createCollection` directly passes them. For a collection created **through the tool**, the consumer supplies them when it builds the tool entries, as an optional callback bound beside the identity:

```ts
buildRagCollectionToolEntries({
  registry,
  identity,
  /** What a collection this caller creates through the tool is recorded with.
   *  Called by rag_create_collection with what the model asked for; its result is
   *  stored unread. Absent → the collection has no attributes. */
  attributesFor?: (created: { name: string } & RagCollectionOwner) => RagJsonValue | undefined,
});
```

An earlier revision said the handler took them "from its `RagToolContext`", which declares no such field and — after §5.1 removed identity from it — is no place for anything about the caller; and the tool's input is the **model's**, so taking `attributes` there would let the model write the policy that later decides who reads the collection. The callback is neither a check nor a policy inside the client (§5.1): the framework never reads what it returns, it only records it, exactly as `createCollection` records what a direct caller passes. The registry passes them through and never invents them (§9.5).

### 6.4 Which registry is shared, and which is the caller’s

`SimpleRagRegistry` is shared across per-session builds and receives providers through `setProviderRegistry` (`llm-agent-libs/src/builder.ts:855`); its own comment explains why some collections opt into idempotent registration. **The question that stood here has dissolved rather than been answered.** It asked how a registry outliving a caller may hold a provider bound to that caller — and what bound one was the `AccessCheck` inside `createFor`'s facade, which §6.2 deletes. What can still be caller-bound is a provider constructed with a caller's own credential, and §4.1 already places that: the pipeline that owns the caller constructs it, and it is not registered anywhere outliving that pipeline. The **provider** registry goes on holding shared, service-credentialed providers exactly as today.

**The collection registry is a different object, and it is the address space.** §6.3 has the consumer hydrate the records belonging to one caller; §5.1 has the tool entries built for one caller. Both are about the registry those tools are handed, and a *shared* one cannot be that registry — which is not an argument, it is the key. `SimpleRagRegistry.entries` is a `Map` keyed on the logical name alone (`:61`). So a shared registry handed caller A's collections and then caller B's fails in two different ways: for two callers with a collection of the **same** name it throws — `register` refuses a duplicate (`:91`) and `createCollection` guards identically (`:163`) — and for **differently** named ones it quietly accumulates, so A's tools address B's collections. A loud failure and a silent leak, from one missing dimension in a key.

**Within one caller's registry, the key gains the scope — and only the scope.** A caller may legitimately have a `global` collection, a `user` collection and a `session` collection all called `docs`: they are three collections, with three stores already (`storeNameFor` digests the scope), and only the registry's key says otherwise. So entries are keyed by **scope and name**. The owner does not join the key, because the registry is one caller's and its owner is implied; that is the difference from the composite key refused below, which would add the owner to make one registry hold several callers. `get`, `getEditor`, `unregister` and `deleteCollection` gain an optional `scope`: given, it selects the entry; omitted, the name must be unambiguous — one scope holds it — or the call fails with `RAG_AMBIGUOUS_COLLECTION` naming the scopes that do. `deleteCollection` returns it in its `Result`; `get`, `getEditor` and `unregister` return `IRag | undefined`, `IRagEditor | undefined` and `boolean`, so they **throw** a `RagError` carrying it, like `register` and `adopt` (§6.3) — returning `undefined` would make an ambiguous name indistinguishable from an absent one. No existing probe changes behaviour, because an ambiguous name could not exist before: `register` refused any duplicate name. No silent precedence between scopes, for the same reason a misspelled model key is an error (§4.6.7): a caller who meant the user's `docs` and got the global one would not find out. `list()` returns every entry with its scope, as `RagCollectionMeta` already carries it — optional in the type, but `register` defaults it to `global` (`simple-rag-registry.ts:105`), so every entry has one, and that default stays. Adding an optional parameter keeps every call site compiling; an **implementation** of `IRagRegistry` must accept it, which §8 lists.

**Every caller that addresses the registry by name alone changes with the key**, and compiling is not the test — each would start failing at runtime once a name is held in two scopes:

- **`closeSession`** collects its victims by `sessionId` and deletes them by name (`simple-rag-registry.ts:324-334`); it passes `scope: 'session'`, which is the only scope a `sessionId` selects.
- **The `ragStores` projection** (`llm-agent-libs/src/builder.ts:946-952`) rebuilds `Record<name, IRag>` from `list()` with `get(m.name)`, inside the mutation listener — and it is what the query path reads: `rag-query` resolves a stage's `store:` in it (`pipeline/handlers/rag-query.ts:35`), `DefaultPipeline` queries every entry (`default-pipeline.ts:337`), and `tool-select` and `skill-select` iterate it. So its key becomes deterministic in the scope: a **global** keeps its bare name, and a `user` or `session` collection is keyed `user/<name>` or `session/<name>`. The two prefixes are therefore **reserved for globals**: `register`, `createCollection` and `adopt` refuse a `global` whose name begins with `user/` or `session/`, with `RAG_RESERVED_COLLECTION_NAME`, since it would take a key the projection gives another scope and one entry would silently overwrite the other in the rebuild. Nothing else in the query path reads the key — `tool-select` and `skill-select` iterate entries, `rag-query` treats `store:` as opaque, and `DefaultPipeline` special-cases only `tools` and `history` — so no other name is affected. Every key is unambiguous and nothing takes precedence over anything; `tools`, `history` and every configured store — all registered as globals — keep the keys stage configurations already name, and only a user or session collection that a configuration addressed by bare name changes, which §8 lists.
- **The fallback-RAG wrapping** (`builder.ts:998-1003`) finds, unregisters and re-registers by name; it carries the entry's scope through all three.
- **`addRagStore` / `removeRagStore`** (`agent.ts:396-397`, `:427`) register deployment stores and address them as globals, with `scope: 'global'`.
- **`rag_describe_collection` and `rag_delete_collection`** find their target with `list().find(m => m.name === name)` (`rag-collection-tools.ts:173`, `:189`) — a first match, the silent precedence this paragraph refuses; they resolve through the registry with the tool's `scope` argument instead.

**So the registry a caller's tools see holds that caller's collections and the globals, and this design does not add an owner to the key to make a shared one hold more.** A registry per pipeline is the arrangement, and an earlier draft claimed it needed "no contract change". That was false, and measuring the shipped session assembly says so: `SessionGraphFactoryOptions.ragRegistry` is a single `IRagRegistry` (`session-graph-factory.ts:93`), handed to every session build (`:228`), and the object `closeSession` is called on at dispose (`:280`). There is no way for a session to own its collection registry through that API.

Its own comment is the more telling part — *“GLOBAL RAG provider/registry — shared; **the per-call scope filter isolates**”*. That is the model §5.1 replaces, written down: isolation resting on a filter applied at each call, which is the forgettable per-call mechanism, not the instance. So this is not plumbing to be tidied later; the assembly currently depends on the assumption being removed.

**The seam, therefore:** `SessionGraphFactoryOptions` gains an optional `ragRegistryFactory?: (identity: SessionGraphIdentity) => Promise<IRagRegistry>`. When it is given, the session owns the registry it returns and `dispose()` closes **that** one instead of calling `closeSession` on a global; when it is absent, `ragRegistry` behaves exactly as today, so a consumer that assembles its own sessions is not forced. **The shipped server is not such a consumer, and is not given the choice.** `SmartServer` hands the session lifecycle one `globalRagRegistry` (`smart-server.ts:1550`), so left alone the reference deployment would keep exactly the collisions and accumulation measured above. It therefore always supplies `ragRegistryFactory`: a registry per session, hydrated for that session's identity, seeing the globals. Two limits of today's `SmartServer` make that smaller than it sounds, and they are stated rather than fixed here. It registers **no RAG providers**, so until a deployment configures one there is no catalog to hydrate from and each session's registry holds only the deployment's globals; and its sessions carry a `sessionId` and **no `userId`** (`session-registry.ts:91` builds them from `{ sessionId }`), so `user` collections are neither hydrated nor creatable through it. The per-session registry is still the right shape to ship — it removes the shared one the leak depends on — and carrying a caller's `userId` into `SmartServer`'s sessions is a separate change, out of scope here (§11). The API stays optional; the leak does not stay in the example every other consumer copies (principle 2).

**It returns a promise, and that is not a stylistic choice.** Hydration is asynchronous by construction — `describeCollections()` and `openCollection()` both are — so a synchronous factory could not hydrate what it returns, and an earlier draft of this paragraph declared one. Nor can the work be deferred to `buildAgent`: `SessionAgentParts` carries `sessionId` and no `userId` (`session-graph-factory.ts:33`), so a build callback cannot filter `user`-scoped records by the caller's full identity — it would have to guess, or skip them. The factory has what is needed, because `SessionGraphIdentity` is `{ sessionId, userId? }` (`:21-24`), and awaiting it costs nothing: `build` is already `async build(identity): Promise<SessionGraph>` (`:166`), so its signature does not change either.

So **the factory is where hydration happens** — it is handed the identity, reads the catalog, keeps that caller's records, opens and adopts them, and returns a registry already populated. One seam, full identity, and no second hook to forget. How a session registry comes to see the `global` collections — seeded with references to the shared instances, or resolved through the shared one — is that function's business, because composing topology is the consumer's (§1.3). The framework's job is only to make the session-owned arrangement expressible, which today it is not. A composite key would instead build a structure whose purpose is to hold several callers' collections at once — the wide address space §5.1 exists to prevent — and every read of it would then need the dimension applied correctly, every time, by every caller. That is the class of mistake this whole section removes.

The framework does not *mandate* the arrangement on other consumers (§1.3); it states what the tools require of whatever registry they are given, and its own server meets it. A consumer that hands them a shared one gets collisions and accumulation rather than a diagnostic, which is reason enough for the requirement to be written here rather than discovered.

---

## 7. One job, one contract: the logger

`@mcp-abap-adt/llm-agent` declares `ILogger { log(event: LogEvent) }` (10 event kinds, 22 non-test source files); `@mcp-abap-adt/interfaces-utils` declares `ILogger { info/warn/error/debug(message, meta?) }`. Same job, two contracts. The cost is not hypothetical: a consumer that already has a text logger cannot hand it to `withLogger` — it must first write an adapter that turns every call into a `LogEvent`. cloud-llm-hub simply declined to: it passes no logger to llm-agent at all, and its own `ILogger` imports come from `@mcp-abap-adt/connection` and `@mcp-abap-adt/interfaces`, not from here.

**What must not change.** `ILogger` is not only an input — llm-agent hands it **out**: `PipelineContext.logger` and `IPipelinePlugin` are typed by it, so a consumer's plugin calls `logger.log({ … })` on our type. Changing the shape of the exported name would break every such plugin, which is a major. So:

| seam | type | rule |
|---|---|---|
| exported `ILogger` | `{ log(event: LogEvent): void }` | **unchanged** |
| `ITextLogger` (re-exported `interfaces-utils` shape) | `info/warn/error/debug(message, meta?)` | new name, new import |
| input seams — the eight declarations listed in the plan’s Global Constraints, and whatever accepts those types | `ILogger \| ITextLogger` | accept both, normalise at the boundary |
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

The text shape is the general one: a structured event fits in `meta`, a closed union cannot carry arbitrary text. `interfaces-utils` needs no change, and the rename that finally leaves one name is a separate, later change (§9.9). This workstream is additive at runtime; the release carrying it is a major because of the read-side break below — §10 says why that is a release decision rather than a workstream one.

**One source-level caveat.** Widening these properties is safe for a consumer that *sets* one and hands it over. A consumer that *reads* one — `options.logger?.log(event)` — no longer compiles, because the property is now the union: `error TS2339: Property 'log' does not exist on type 'AnyLogger'`. Handing a logger in is unaffected. Reading one needs a definedness check first: these properties are optional and `normaliseLogger` takes a non-optional `AnyLogger`, so `normaliseLogger(options.logger)` on its own does not compile either (`error TS2345: Argument of type 'AnyLogger | undefined' is not assignable to parameter of type 'AnyLogger'`). What compiles, measured: `if (options.logger) normaliseLogger(options.logger).log(event);` Nothing changes at runtime, and the inputs that deliberately stay event-only are unaffected.

---

## 8. What changes, and where

| package | change | breaking |
|---|---|---|
| `@mcp-abap-adt/llm-agent` | **`IPipelinePlugin` loses `parseConfig` and `build`'s `config` parameter, and `PluginExports` gains `pipelinePluginFactories` (§4.6.7)** — a plugin's constructor takes typed settings and its instances arrive through `ctx`, so no configuration travels through its usage contract, and a configurable third-party plugin is exported as a factory the server calls; **`IPipelineContext` gains `resolveNamedLlm(key)`**, the strict lookup for a key a plugin's settings named, beside `resolveLlm(role)`'s defaulting one, so a misspelled key is an error rather than `main` (§4.6.7) — additive for a plugin, but a consumer that *implements* `IPipelineContext` must add it; **`LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` removed** — a contract carries no secret (§4.6.2) — plus `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated as a consumer seam; `attributes` and the logical `collectionName` on provider collection creation, the optional `describeCollections()` catalog read — returning valid `records`, each a `RagCollectionRecord` whose required `scope` selects its owner key through `RagCollectionOwner` — the type both `createCollection` contracts now take too, refusing a missing key with `RAG_INVALID_OWNER` — and the malformed rows as `rejected` —, `attributes` typed `RagJsonValue` and refused with `RAG_INVALID_ATTRIBUTES` when JSON would change them, the optional `openCollection()` that builds handles for an existing store, the optional `IRagRegistry.adopt()` that registers one, the `CatalogRecordDeleteError` type and the tool that answers `{ ok: false }` to it rather than warning about data (§6.3), with `SimpleRagRegistry` keyed by scope and name, its lookups taking an optional `scope` and refusing an ambiguous name with `RAG_AMBIGUOUS_COLLECTION`, the collection tools gaining the same optional `scope` argument, `get`/`getEditor`/`unregister` throwing that code, `closeSession` deleting with `scope: 'session'`, the `ragStores` projection keying globals by bare name and user/session collections as `user/<name>`/`session/<name>`, `adoptExisting?` on `createCollection`, the `user/` and `session/` name prefixes reserved for globals (a runtime refusal on `register` for a name that registers today), the registry reserving a name while it is being deleted and re-registering the entry on that error so the delete retries in place; `attributes?` on `IRagRegistry.createCollection`, forwarded to the provider and not added to `RagCollectionMeta` — the deletion itself belongs to the providers, below; the caller's identity bound into `buildRagCollectionToolEntries` and used by all seven handlers, with an optional `attributesFor` callback beside it for collections the tool creates, with `RagToolContext`'s declared `sessionId?`/`userId?` removed so there is one source (§5.1); `ITextLogger` re-exported from `interfaces-utils`, **exported `ILogger` unchanged** | **breaking** at source level: `IPipelinePlugin` loses a member and a parameter, and `IPipelineContext` **gains a required** `resolveNamedLlm`, so every implementation of it — a consumer's, a test fixture's — must add one (§4.6.7), and an implementation of `IRagRegistry` must accept the new optional `scope` on its lookups (§6.4); otherwise additive at runtime, and a consumer that *reads* a widened option property must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-libs` | **the plugin loader validates what it loads and records what it refuses (§4.6.7)** — it checked `build` and then silently skipped, while recording an error for a duplicate name, so it was inconsistent with itself; `withMcpServers` on the builder; start in `build()`, `stop()` into `closeFns`; optional `mcpServerFactory` on the session factory; **`makeLlm`, `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` removed** (§4.6.2), `MakeLlmConfig` with them, and `DefaultModelResolver` with them — `IModelResolver` itself is **unchanged** (`model-resolver.ts:7`), since what held a config was the implementation; optional `ragRegistryFactory(identity)` with session-owned disposal, which makes `SessionGraphFactoryOptions.ragRegistry` optional where it was required — a consumer that *reads* it must now handle `undefined` (§6.4) | **breaking**: exported functions and `DefaultModelResolver` are removed; the `IModelResolver` contract is untouched. Also additive at runtime for the MCP and RAG seams, and `SessionGraphFactoryOptions.logger` is widened, so a consumer that *reads* it must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-server-libs` | **`IServerPipelineContext` loses `makeLlm`, `llmMap` and `pipelineFallback` (the last already dead) and keeps the framework's existing `resolveLlm(role)` and the new strict `resolveNamedLlm(key)` as the only two ways an LLM reaches a pipeline — whose key space stays the consumer's, and `IRoleLlmResolver` loses `makeLlm(lc)` (§4.6.6) — a usage-side contract may not construct, so the per-step authorization path closes by type**; **the four shipped plugins with a dialect (`linear`, `stepper`, `dag`, `controller`) lose their parsers to the server, which parses the selected section in `start()` and constructs that plugin with typed settings through a registry of factories, and `controller`'s `subagents.<role>` and a DAG worker's own config file name a key of the main file's `llm:` map instead of holding an LLM configuration (§4.6.7; a worker file resolves with the main map in scope and its three LLM slots come from the resolver, its RAG and MCP slots staying cached per worker; `RoleLlmResolver` answers a key with no `llm:` entry with the held `main` instance instead of a fresh build from `llm.main`; and the in-memory search knobs move under `rag.store`, taking the config watcher and the section defaults with them (§4.6.4, §4.6.6, §4.6.7)**; the resolver's shape admits two scopes, deployment-wide and per-session, with disposal following the identity (§4.6.5, §4.6.6) — which scope a role lands in is the app's policy, and `SmartServer`, whose sessions carry no caller credential (§6.4), ships the deployment scope only; consumes the builder seam; **always supplies `ragRegistryFactory`, so each session owns a registry hydrated for its identity instead of sharing `globalRagRegistry` (§6.4)**; `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` deprecated, not deleted; **and it constructs providers the way the library used to** — `makeLlm({…})` at `build-dag-coordinator-deps.ts:89` — and its `SmartServerLlmConfig.apiKey` (`:129`) is a passenger too, so it goes while the DTO stays **serializable**, gaining a non-secret `credentialRef` so a role can still name its account — and **`SmartServerRagConfig` splits into `store` and `embedder`, each with its own `credentialRef` (§4.6.4)**, because one flat shape described two independently authenticated targets and `url` meant either one's address depending on its neighbours — construction goes through `BuildAgentDeps.makeLlm`, which already exists (`:360`) and becomes **non-optional** so a missing seam is a build error rather than a deployment that stops starting (§4.6.3), because a YAML file holds neither an object nor a function (§4.6.2). The loader, env substitution and schema validation stay here; only the rule requiring `AICORE_SERVICE_KEY` (`config-validator.ts:72`) leaves with the credential | **breaking**: an exported DTO loses a required secret field, two unread legacy DTOs (`PipelineLlmProviderConfig`, `PipelineRagStoreConfig`) are deleted, and `ControllerSkillPipelineBuilder` stops reading `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`DEEPSEEK_API_KEY` and its `BuilderLlmInput.apiKey` — a library-side env read the rest of this design removes everywhere else — `modelResolver?` stays optional (`:334`), and the dispatch and the resolver implementation land in `llm-agent-server`, the app |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`. `IMcpServer` arrives here as the generic `mcpServerFromFactory` adapter (workstream 1); the typed implementations, whose constructors demand a credential per §3.3, land with the credential contracts in workstream 2 — **http first** (the main protocol; `start()` holds a connection rather than spawning), stdio beside it for the local case | additive |
| `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | a credential in their own constructors, replacing `apiKey`/`user`/`password`, with a connection string that carries the address only; persist `attributes` in a catalog of their own, hand them back unread through the new optional `describeCollections()`, build handles for an existing store through `openCollection()`, **create the store in `createCollection` and nowhere else** — `qdrant-rag` stops creating lazily on write and learns the vector size from one probe embedding — **commit a creation by writing the record last, create-if-absent**, leaving the store in place as a named orphan if that write fails — never removing it, since another session may already have adopted it — **refuse a collection whose record already exists** and, with `RAG_ORPHAN_STORE`, one whose store exists without a record unless `adoptExisting` asks to take it over, **build pg and hana `openCollection` handles with the schema marked ready**, since their handles otherwise create on first use, so no handle ever creates its store and a stale one fails rather than resurrecting it, and **delete the catalog record before the data inside their own `deleteCollection`, raising `CatalogRecordDeleteError` and leaving the data untouched when that first step fails** — these packages own the backend catalog, so resurrection is stopped here or nowhere (§6.3). **No check is asked here** (§5) | **breaking**, in three ways: source-level, because `apiKey`/`user`/`password` are removed from the configs (§4.6.2); at runtime for one input, because a connection string carrying credentials is now refused at construction rather than used; and at runtime through the catalog (§6.3) — the store's account needs rights to it, a taken name is refused, and re-creating a collection no longer reattaches it (migration items 10 and 11). What the measurement in §4.6.1 still buys is narrower than an earlier draft of this cell claimed: the *resolvers* are absent from both barrels and unreachable through a closed `exports` map, and their only caller is already `async`, so making them async is invisible — but the config type is public, so removing a field from it is not |
| `llm-agent-rag` | **it holds no store, no config and no catalog of its own** — an earlier draft of this matrix listed it beside the three store packages and attributed their work to it, which is why the first plan derived from this spec left it owned by nobody. Its whole content is the **resolution bridge** between serializable configuration and a constructed provider: `resolveEmbedder`, `resolveRag` and `makeRag`. Its option bags must therefore carry `credential` — and `apiBaseUrl` for the SAP targets, which no longer read the environment — in place of `apiKey`/`user`/`password`, and must forward the credential **object itself**, since quota scoping keys on its identity (§4.6.2) and a copy would split one account into two buckets. Two properties of this package made the omission silent rather than loud, and both were measured, not supposed: the option bags were `Record<string, unknown>` reaching cast constructors — the store's through a second cast — so a removed field produced **no compile error here**; and neither resolver spread its input, each copying a hand-picked whitelist, so a member the whitelist omitted was dropped in silence whatever the types permitted. **Those two properties are the defect, not the premise, and they go.** An earlier draft of this cell concluded that a runtime `kind` check was "consequently the only place a mismatch can be caught" — which was true only for as long as the casts stood, and principle 10 asks the opposite question: which cast made the check necessary. The path is typed end to end instead. The resolution input becomes a **discriminated union** whose arms carry what each backend's own constructor demands, and the dispatch runs over **literal** import specifiers, which type-resolve at compile time while each package stays an optional peer (they are declared in both `peerDependencies` and `devDependencies`). Then the wrong credential kind, a missing required one and a leftover `apiKey`/`user`/`password` are **build errors**, and `RagFactoryOpts`, the constructor casts and the name maps are deleted rather than improved — none had a consumer outside this package. Two runtime checks survive because no type can make them: a **missing optional peer**, and a legacy secret field arriving from an **untyped** source, since a loaded YAML object is not a fresh literal and no excess-property check ever sees it. The embedder half has the same castful shape and gets the same treatment: `EmbedderResolution` is a union discriminated by `provider` — the name the YAML uses, replacing the bag's `embedder` — with a consumer factory named by its own arm, and each provider handed its own URL field, which the bag never did (`ollamaUrl`, `baseURL`; §8 migration, "Also changed"). **No access check is asked here** (§5) | **breaking**: the resolution config types are public, so removing a field from them is source-breaking, and a configuration that named a secret by the old field now fails at resolution with the target named instead of constructing a provider that cannot authenticate |
| concrete LLM and embedder providers | a credential **replacing** `apiKey?: string` in their own constructors, with the AI Core `AICORE_SERVICE_KEY` fallback moved **out** of the provider (§4.6.2): a provider that reads an env var when no credential was passed has two sources again, and the precedence this section deleted would be back. The composition root reads the env and builds the one `IBearerCredential` the provider is constructed with — same behaviour for a deployment that sets nothing else, one source for the provider | **breaking**: the plain field is removed, `staticApiKey` converts a call site in one line (§4.6.2) |
| `@mcp-abap-adt/interfaces-auth` | gains the three credential contracts — and **not** `AccessCheck`, which has no acceptor here (§5) | minor |
| `@mcp-abap-adt/sap-aicore-auth` (**new**) | `serviceKeyCredential(raw): { credential: IBearerCredential; apiBaseUrl: string }` and `parseServiceKey` — the existing `TokenProvider` and parser moved out of `sap-aicore-embedder` with their tests, so both SAP packages and the composition root can use one implementation (§4.6.2) | new package |
| cloud-llm-hub | **may** adopt the seams; it is not required to | its own work |
| `llm-agent-server` | **must** change: it becomes the composition root — reading the environment, building credentials, dispatching providers, and implementing `IModelResolver` behind `PUT /v1/config` (§4.6.2). Being the example is its job (principle 2) | required, and it is the reference every other consumer copies |

### What each workstream needs from another repository

Read this rather than deriving it. Every row was checked against the packages, not remembered.

| workstream | needs from `mcp-abap-adt-interfaces` | package and version | state |
|---|---|---|---|
| 1. MCP lifetime and identity | nothing | — | merged (#305), unreleased |
| 2. Credential contracts | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | `interfaces-auth` 1.1.0, published 2026-09-20; the three are byte-identical in 1.2.0, and the branch locks 1.2.0 under a `^1.1.0` floor | in progress on `feat/credentials-and-rag-identity` |
| 3. RAG identity and attributes | nothing — `AccessCheck` left this design (§5) | — | not written |
| 4. Text-logger acceptance | `ILogger`, consumed unchanged | `interfaces-utils` 1.0.0, published 2026-09-16 | merged (#306), unreleased |

**`interfaces-auth` is touched once, and now by one row rather than two.** Row 3 stopped needing it when admission left the design, so what lands is the **three credential contracts** in one change and one minor release — which is, by coincidence worth noting, exactly what the paused PR #90 already contains. Releasing that package twice, each time for whatever this repository happened to need next, is the failure this table exists to prevent: it makes the contract package a servant of one consumer’s schedule rather than a vocabulary.

**Order, and it is not negotiable.** The contract is published, then adopted. An acceptor cannot merge a dependency on an unpublished version, so a plan that interleaves them describes a state that cannot exist. `interfaces-utils` in row 4 shows the easy case — the contract was already on the shelf, so that workstream needed no release at all.

**Release shape.** Two kinds of change travel together, and an earlier version of this paragraph — and of the TL;DR — called them all optional, which the migration note below contradicts item by item.

**Declinable: new capability.** `IMcpServer` with `withMcpServers` and `mcpServerFactory` (§3), the `closePipeline` hook that carries the safer teardown order (§3.4), `ragRegistryFactory` for a consumer's own session assembly (§6.4), the RAG catalog's **read** members — `describeCollections`, `openCollection`, `adopt` (§6.3) — and `ITextLogger` acceptance (§7). A consumer that uses none of them keeps today's behaviour on those paths. The catalog's **writes** are not in this list: they happen on the existing create and delete paths, below.

**Not declinable: the contract migration.** Every one of these needs an edit or changes what a running deployment does, and each is a numbered item of the migration note:

- **Secrets leave every contract** (§4.6.2; items 1–3). `LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` are removed, the concrete providers and stores take a credential instead of `apiKey`/`user`/`password`, `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` leave `llm-agent-libs`, the SAP providers stop reading `AICORE_SERVICE_KEY`, and a connection string carrying credentials is refused at construction where it used to be used.
- **Three construction seams become required** (§4.6.3, §4.6.4; item 4). `BuildAgentDeps.makeLlm`, `resolveEmbedder` and `makeRag` are no longer defaulted, so passing `{}` as `deps` stops compiling, and a deployment that never injected them stops starting — `SmartServer` fills `makeLlm` with `_makeLlmDefault` today (`smart-server.ts:954`). The validator refuses at startup and names the seam, for callers with no types to check.
- **The serializable configuration changes shape** (§4.6.2, §4.6.4, §4.6.7; items 4 and 8). `apiKey: ${VAR}` becomes `credentialRef`; `rag:` splits into `store` and `embedder`, and the in-memory search knobs move under `store`; `controller`'s subagents and a DAG worker's file name `llm:` keys instead of holding LLM configurations.
- **The pipeline contracts change** (§4.6.6, §4.6.7; items 5 and 8). `IServerPipelineContext` loses `makeLlm`, `llmMap` and `pipelineFallback`, `IRoleLlmResolver` loses `makeLlm(lc)`, `IPipelinePlugin` loses `parseConfig` and `build`'s `config` parameter, and `IPipelineContext` **gains** the required `resolveNamedLlm(key)`, which every implementation and fixture of it must add.
- **The plugin loader reports what it used to skip** (§4.6.7; item 8). A malformed export, or a plugin whose `name` differs from its key, becomes an `errors` entry or a startup error — the one change here that can reject something that runs today.
- **The RAG tools are built for one caller** (§5.1; items 6 and 7). `rag_create_collection` no longer creates a `global` — its `scope` is `session | user` — and `buildRagCollectionToolEntries` requires an `identity` — no overload without it is kept, since an optional `identity?` would mean "do not narrow", an unnarrowed address space reached by forgetting a field — and `RagToolContext` loses its declared `sessionId?`/`userId?`. Against the repository's own tsc (6.0.3) a call site *passing* those keys still compiles, because the type declares `[key: string]: unknown`, while a *reader* gets `error TS2322`; no reader exists today because nothing mounts these tools.
- **The shipped stores keep a catalog, on the paths that exist today** (§6.3; item 10). `qdrant-rag`, `pg-vector-rag` and `hana-vector-rag` create their catalog if absent and write a record in `createCollection`, and delete it — first — in `deleteCollection`, with `CatalogRecordDeleteError` as a new way for that call to fail. No new method has to be called for this to happen, so a deployment that uses none of the new members still gets extra backend writes, needs the rights to make them, and can see the new error. With the catalog come four more: `register`, `createCollection` and `adopt` refuse a `global` named `user/…` or `session/…`, since those prefixes now key user and session collections in `ragStores`; `createCollection` refuses a collection whose record exists — which ends today's reattach-by-re-creating after a restart, so hydration becomes the only way back (item 11) — `qdrant-rag` creates at `createCollection` with one probe embedding instead of on the first write, and a registry key gains the scope, so a name held in several scopes must be addressed with one.
- **`SmartServer`'s sessions each own their collection registry** (§6.4). Not an edit for a consumer, but a changed runtime: the shipped server supplies `ragRegistryFactory` itself.
- **Six readable logger options widen** (§7; item 9) — a consumer that reads one must narrow first.

The deprecations — `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` — are markers for a later major, not part of this one. `McpClientFactory` is a special case: it stays as the default implementation's factory, which `mcpServerFromFactory` consumes, and is deprecated only as the **consumer-facing** seam. The version this ships as is decided at the release by what has accumulated (§10), not here: as it stands the set carries workstream 4's read-side break and §5.1's two, so it is a major.

### Migration — what a consumer on the old contract must do

Eleven changes need an edit or a check, and none of them is optional — nothing here is deprecated-but-working, because §4.6.2 removes rather than deprecates. Everything *else* is declinable as usual: a consumer that leaves a new seam unused keeps today’s behaviour.

**1. Replace a plain key with a credential** (§4.6.2). `apiKey` is gone from `LLMProviderConfig`, from `EmbedderFactoryConfig` and from the concrete providers' own configs; a static key is already a credential, and core ships the conversion.

```ts
- new OpenAiEmbedder({ model: 'text-embedding-3-small', apiKey: key });
+ new OpenAiEmbedder({ model: 'text-embedding-3-small', credential: staticApiKey(key) });

- new PgVectorRagProvider({ connectionString: 'postgres://u:pw@host/db', … });
+ new PgVectorRagProvider({ connectionString: 'postgres://host/db',
+                          credential: staticLogin('u', 'pw'), … });
```

A connection string carrying credentials is now **refused at construction**, with `staticLogin` named in the message — it is not silently ignored. And a consumer's own embedder factory stops receiving `cfg.apiKey`: it closes over the credential it already holds, which is why the framework no longer carries one.

**2. Construct your LLM provider yourself, and hand in the instance** (§4.6.2). `makeLlm` and `makeDefaultLlm` are gone from `llm-agent-libs`, along with `MakeLlmConfig`: a dispatch that restates five constructors it does not own is the consumer's, not the library's.

```ts
- const llm = await makeLlm({ provider: 'openai', apiKey: key, model: 'gpt-4o' });
- builder.withMainLlm(llm);
+ const provider = new OpenAIProvider({ credential: staticApiKey(key), model: 'gpt-4o' });
+ builder.withMainLlm(new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model }));
```

`DefaultModelResolver` goes too, and `IModelResolver` does **not** change. If you relied on the
library's implementation for `PUT /v1/config` model switching, implement the same one-method
contract where your credential lives — which is what `llm-agent-server`, the app, now does for
the shipped server (an earlier draft of this line said `llm-agent-server-libs`, which §4.6.2
withdrew):

```ts
- new DefaultModelResolver({ provider: 'openai', apiKey: key })
+ const modelResolver: IModelResolver = {
+   async resolve(modelName, role) {
+     const provider = new OpenAIProvider({ credential: myCredential, model: modelName });
+     return new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model });
+   },
+ };
```

Pick your own temperature per role if you want one: the library's `main ? 0.7 : 0.1` was a policy
with our numbers in it and does not move. And note that per-call `CallOptions.model` is **not** a
substitute — by its own contract it does not reach the reviewer, finalizer, planner or
evaluator roles (`types.ts:35-42`).

**3. Build the SAP AI Core credential in your composition root** (§4.6.2). The providers no longer read `AICORE_SERVICE_KEY`, and a service key is OAuth client credentials rather than a token — so the exchange, its cache and its refresh live in one place you call:

```ts
import { serviceKeyCredential } from '@mcp-abap-adt/sap-aicore-auth';

- new SapCoreAIProvider({ model });                    // read AICORE_SERVICE_KEY itself
+ const { credential, apiBaseUrl } = serviceKeyCredential(process.env.AICORE_SERVICE_KEY!);
+ new SapCoreAIProvider({ model, credential, apiBaseUrl });
```

That function is the package's existing `TokenProvider` and `parseServiceKey` moved out with their tests, so behaviour is unchanged for a deployment that sets the same env var — it is now read one level up, by you. The SAP packages' `credentials` option and its exported `SapAICoreCredentials` shape (`clientId`/`clientSecret`/`tokenServiceUrl`/`servicUrl` — the last misspelt in the source, `sap-core-ai-provider.ts:37` on `main`) are gone with it: the credential and `apiBaseUrl` above replace them.

**4. Supply all three construction seams, and move your secrets to `credentialRef`** (§4.6.2, §4.6.3, §4.6.4). An earlier version of this item asked only for `makeLlm`; it is three. The library no longer defaults this seam, so a server that never injected one must now do so — without it there is no LLM and startup refuses.

```yaml
  llm:
    main:
      provider: deepseek
-     apiKey: ${DEEPSEEK_API_KEY}
+     # nothing here: the root's default entry applies. A value never enters the
+     # loaded config, which is what ${...} substitution got wrong.
      model: deepseek-chat
    classifier:
      provider: openai
+     credentialRef: OPENAI_KEY_CHEAP     # name a second account when you want one
      model: gpt-4o-mini
```

```ts
// Your composition root — the design reference. Task B17 of the plan implements it as
// packages/llm-agent-server/src/composition/* and compiles it against the real
// provider types; an earlier version of this block claimed to have been compiled
// under --strict against stubs, and six defects the real types expose (below) show
// what that claim was worth.

type AnyCredential = IApiKeyCredential | IBearerCredential | ISecretLoginCredential;

type CredentialEntry = {
  /** Absent means this target needs none. A store entry holds a secret-login,
   *  an LLM entry an api key or a bearer token. */
  credential?: AnyCredential;
  /** SAP AI Core only; it travels with the credential from the same service key,
   *  so it is never also written in YAML (one source, §4.6.2). */
  apiBaseUrl?: string;
};

// One default per ROLE, because an entry holds one credential and a store's kind
// need not match an embedder's. A deployment where they are one account names that
// account in each section.
const DEFAULT_LLM_REF = 'LLM';
const DEFAULT_STORE_REF = 'RAG_STORE';
const DEFAULT_EMBEDDER_REF = 'RAG_EMBEDDER';

// A function, not a map literal — nothing is read until a ref asks — and memoized,
// so the same ref always hands back the SAME credential object: the 429 gate keys a
// quota bucket on that identity (§4.6.5).
function memoize(buildEntry: (ref: string) => CredentialEntry | undefined) {
  const entries = new Map<string, CredentialEntry | undefined>();
  return (ref: string) => {
    if (!entries.has(ref)) entries.set(ref, buildEntry(ref));
    return entries.get(ref);
  };
}

// The shipped server's rule: a ref names a family of environment variables.
//   <REF>_API_KEY               → api-key credential
//   <REF>_SERVICE_KEY           → SAP AI Core service key: bearer + apiBaseUrl
//   <REF>_USER + <REF>_PASSWORD → secret-login credential
// None set → no entry; more than one → refused, an entry holds ONE credential.
// A consumer with its own root passes its own buildEntry instead.
const credentialFor = memoize((ref) => {
  const apiKey = process.env[`${ref}_API_KEY`];
  const serviceKey = process.env[`${ref}_SERVICE_KEY`];
  const user = process.env[`${ref}_USER`];
  const password = process.env[`${ref}_PASSWORD`];
  const set = [apiKey, serviceKey, user || password].filter(Boolean).length;
  if (set > 1) throw new Error(`credentialRef '${ref}' is ambiguous: several kinds are set`);
  if (apiKey) return { credential: staticApiKey(apiKey) };
  if (serviceKey) {
    const k = serviceKeyCredential(serviceKey);
    return { credential: k.credential, apiBaseUrl: k.apiBaseUrl };
  }
  if (user || password) {
    if (!user || !password) throw new Error(`credentialRef '${ref}' needs ${ref}_USER and ${ref}_PASSWORD`);
    return { credential: staticLogin(user, password) };
  }
  return undefined;
});

// "Optional" means a ref may be OMITTED — never that a NAMED ref may fail to resolve.
// And the role default is read only when a target asks for a credential, so a target
// that takes none never parses it.
function lookup(ref: string | undefined, roleDefault: string, target: string) {
  const named = ref !== undefined;
  const key = ref ?? roleDefault;
  const namedEntry = named ? credentialFor(key) : undefined;
  if (named && !namedEntry) throw new Error(`credentialRef '${key}' for ${target} has no entry configured`);
  const entry = () => (named ? namedEntry : credentialFor(key));
  const wrongKind = (kind: string): never => {
    throw new Error(`credentialRef '${key}' must hold a ${kind} credential for ${target}, got ${entry()?.credential?.kind ?? 'none'}`);
  };
  return {
    require<K extends AnyCredential['kind']>(kind: K) {
      const c = entry()?.credential;
      if (c?.kind !== kind) return wrongKind(kind);
      return c as Extract<AnyCredential, { kind: K }>;
    },
    optional<K extends AnyCredential['kind']>(kind: K): { credential?: Extract<AnyCredential, { kind: K }> } {
      const c = entry()?.credential;
      if (!c) return named ? wrongKind(kind) : {};
      if (c.kind !== kind) return wrongKind(kind);
      return { credential: c as Extract<AnyCredential, { kind: K }> };
    },
    requireApiBaseUrl() {
      const url = entry()?.apiBaseUrl;
      if (!url) throw new Error(`credentialRef '${key}' must carry an apiBaseUrl for ${target}`);
      return url;
    },
    refuseAny() {
      if (named) throw new Error(`${target} takes no credential, so credentialRef '${key}' cannot apply`);
    },
  };
}

const deps: BuildAgentDeps = {
  async makeLlm(cfg) {
    const entry = lookup(cfg.credentialRef, DEFAULT_LLM_REF, cfg.provider ?? 'llm');
    // Every provider config is built from NAMED fields — nothing spreads cfg — and the
    // knobs the library's makeLlm forwarded are forwarded here: without temperature the
    // server's main (0.7) and classifier (0.1) roles collapse onto one default.
    const knobs = { model: cfg.model, temperature: cfg.temperature, maxTokens: cfg.maxTokens, whenThrottled: cfg.whenThrottled };
    const provider = (() => {
      switch (cfg.provider) {
        case 'openai':    return new OpenAIProvider({ ...knobs, baseURL: cfg.url, credential: entry.require('api-key') });
        case 'anthropic': return new AnthropicProvider({ ...knobs, baseURL: cfg.url, credential: entry.require('api-key') });
        case 'deepseek':  return new DeepSeekProvider({ ...knobs, baseURL: cfg.url, credential: entry.require('api-key') });
        case 'ollama':
          // only from a ref that NAMES one: the LLM default usually holds a hosted
          // provider's key, and sending it to whatever sits at cfg.url leaks it
          return new OllamaProvider({ ...knobs, baseURL: cfg.url, ...(cfg.credentialRef === undefined ? {} : entry.optional('api-key')) });
        case 'sap-ai-sdk':
          return new SapCoreAIProvider({ ...knobs, credential: entry.require('bearer'), apiBaseUrl: entry.requireApiBaseUrl() });
        default:
          throw new Error(`unknown llm provider '${String(cfg.provider)}'`);
      }
    })();
    return new LlmAdapter(new LlmProviderBridge(provider), {
      model: provider.model,
      getModels: () => provider.getModels?.() ?? Promise.resolve([]),          // or GET /v1/models lists nothing
      getEmbeddingModels: () => provider.getEmbeddingModels?.() ?? Promise.resolve([]),
    });
  },

  resolveEmbedder(cfg, options) {
    // The ref ends HERE, and the switch is on `rest.provider` — only the switched
    // variable narrows, and `rest` is what is spread.
    const { credentialRef, ...rest } = cfg;
    const entry = lookup(credentialRef, DEFAULT_EMBEDDER_REF, rest.provider ?? 'ollama');
    switch (rest.provider) {
      case 'openai':
        return resolveEmbedder({ ...rest, credential: entry.require('api-key') }, options);
      case 'sap-ai-core':
        return resolveEmbedder({ ...rest, credential: entry.require('bearer'), apiBaseUrl: entry.requireApiBaseUrl() }, options);
      default:
        // ollama sends nothing; a consumer factory closes over its own credential (§4.6.2)
        entry.refuseAny();
        return resolveEmbedder(rest, options);
    }
  },

  async makeRag(input) {
    // The pair's discriminant is nested (store.type), which does not narrow the pair —
    // so a guard narrows the whole input before `embedder` is known to be present.
    if (isInMemoryInput(input)) {
      const { credentialRef, ...address } = input.store;
      lookup(credentialRef, DEFAULT_STORE_REF, 'in-memory').refuseAny();
      return input.embedder
        ? makeRag({ ...address, embedder: input.embedder })
        : new InMemoryRag({ dedupThreshold: address.dedupThreshold });  // keyword-only: built directly
    }
    const { embedder, store } = input;
    const { credentialRef, ...address } = store;
    const entry = lookup(credentialRef, DEFAULT_STORE_REF, store.type);
    switch (address.type) {
      case 'qdrant':      return makeRag({ ...address, embedder, ...entry.optional('api-key') });
      case 'pg-vector':   return makeRag({ ...address, embedder, ...entry.optional('secret-login') });
      case 'hana-vector': return makeRag({ ...address, embedder, credential: entry.require('secret-login') });
    }
  },
};
```

What in it is the model rather than decoration — each is where an earlier version went wrong:

- **`credentialFor` is a memoized function over a naming rule, not a switch.** An earlier version shipped one deployment's switch (`PRIMARY` → `DEEPSEEK_API_KEY`) as though a CLI served one deployment; the rule serves every one, and a consumer with its own root keeps `memoize` and `lookup` and supplies its own `buildEntry`. Nothing is read until a ref asks, and the same ref always returns the same object.
- **An entry holds one credential, and SAP's address travels with it.** `apiBaseUrl` comes from the service key, so the embedder and LLM sections never also carry one — two sources for one value is what §4.6.2 removes. Admitting `ISecretLoginCredential` is what lets the same rule answer for a PostgreSQL or HANA store.
- **The role default is read lazily, and never sent where nobody authorized it.** An in-memory store or an Ollama embedder never parses `RAG_STORE`/`RAG_EMBEDDER`; an Ollama LLM gets a credential only from a ref that names one, because the `LLM` default typically holds a hosted provider's key.
- **The forwarded knobs and the model listing are part of the seam.** `temperature`, `maxTokens`, `whenThrottled` and `baseURL` were forwarded by the library's `makeLlm`, and `getModels` is what `GET /v1/models` reads.

`credentialRef` is optional **in each section independently**, and the fallback is therefore **per role**: omitting a ref means "that role's default" — `LLM`, `RAG_STORE`, `RAG_EMBEDDER` — which a single-account deployment sets once per role it uses. The same swap applies to the store configs: `rag.apiKey`, `rag.user`/`rag.password` and a qdrant skill store's `apiKey` all become `credentialRef`, resolved through the same `credentialFor`. The store constructors then take the credential itself (§4.5).

**The same `deps` object carries the other two seams, and both are now required** (§4.6.3 item 3, §4.6.4). `resolveEmbedder` and `makeRag` stop being defaulted for the same reason `makeLlm` did: a library that may not construct an authenticated LLM from configuration may not construct an authenticated embedder or store from it either. `BuildAgentDeps`'s doc comment used to promise that passing `{}` preserved existing behaviour, and it no longer can — every call site, tests included, names the seams. `isInMemoryInput` is the one-line guard `input.store.type === 'in-memory'`, exported beside `MakeRagInput`; and `InMemoryStoreConfig` carries `credentialRef?` precisely so that a ref named for a store that takes none is refused by name.

A deployment that authenticates nothing — Ollama embeddings into an in-memory store — still writes these three, and that is the price of the library never holding construction. Both `resolveEmbedder` and `makeRag` remain the library's functions; what changes is who calls them and who owns the credential when they do.

**Split your `rag:` section in two, because it described two accounts as one** (§4.6.4). The old shape held a store's connection settings beside an embedder's, with `url` meaning Qdrant's address or Ollama's depending on its neighbours — so one `credentialRef` could not have said which target it named. Mechanical to apply, and a rename plus a nesting:

```yaml
# before — one flat section, two targets, and no way to name two accounts
rag:
  type: qdrant
  url: http://localhost:6333          # the store's
  collectionName: docs
  apiKey: ${QDRANT_API_KEY}           # which target? the YAML could not say
  embedder: openai
  model: text-embedding-3-small
  dedupThreshold: 0.95                # read by the in-memory store only; Qdrant ignored it

# after — each target states its own address, its own model, its own account
rag:
  store:
    type: qdrant
    url: http://localhost:6333
    collectionName: docs
    credentialRef: QDRANT
  embedder:
    provider: openai
    model: text-embedding-3-small
    credentialRef: OPENAI
  # dedupThreshold is gone: with an in-memory store it goes under store:, beside type
```

`PipelineRagStoreConfig` and `PipelineLlmProviderConfig` are deleted, not reshaped — nothing has read them since v19. `SkillPluginsConfig`'s store does **not** split — it already keeps its embedder separately and describes persistence only, so its qdrant entry just gains `credentialRef`. A keyword-only deployment writes `store: { type: in-memory }` with no `embedder:` section at all, and the seam's union accepts that arm without one.

**5. Stop constructing inside the pipeline: name the model, resolve the instance** (§4.6.6, §4.6.7). If you
implement a pipeline or a step against `IServerPipelineContext`, three members are gone: `makeLlm`, `llmMap`
and `pipelineFallback` (the last was already always `undefined`). A step that called
`ctx.makeLlm(someConfig)` names the model by a key instead — a key of the `llm:` map, arriving in its
plugin's typed settings — and calls `ctx.resolveNamedLlm(key)` at build time, or `ctx.resolveLlm(role)` with
the role's own name when no key was given. Use the first for anything a file named: it throws on a key with
no entry, where the second would quietly answer with `main`. If you implement `IPipelineContext` yourself,
add `resolveNamedLlm`. The instance comes from the server,
which decides whether it is the deployment's or the session caller's and hands back the current one after a
`PUT /v1/config` swap; do not take an `ILlm` in your plugin's constructor, which would freeze both decisions.
**Do not reach for a per-call `model`** — by `CallOptions`' own contract that override does not reach the
reviewer, finalizer, planner or evaluator (§4.6.2), which are exactly the roles a controller or DAG path
builds, so it would leave those calls on the old model while the main path looked migrated.
`IRoleLlmResolver` loses `makeLlm(lc)` for the same reason. If you were relying on constructing a provider
mid-pipeline from a config you assembled at runtime, that is the capability this release removes on purpose:
add the model to `llm:`, or register it in your composition root, and resolve it by key. And if the
credential is the **caller's** rather than the deployment's, register it in the session-scoped resolver,
which disposes what it built when the session ends (§4.6.5).

**6. Build the RAG collection tools with an identity** (§5.1). The identity is the caller the pipeline is being built for — the same one whose collections the instance may address.

```ts
// before
const entries = buildRagCollectionToolEntries({ registry });
// after
const entries = buildRagCollectionToolEntries({ registry, identity });

// and, if collections the model creates through rag_create_collection must carry
// your policy attributes (who may read them, a role), return them here — the
// framework records what you return and never reads it; absent → none
const entriesWithPolicy = buildRagCollectionToolEntries({
  registry,
  identity,
  attributesFor: ({ name, scope }) => ({ authorization: 'owner', createdVia: 'tool' }),
});
```

**7. Stop reading identity from the tool context** (§5.1). A handler no longer needs to: the entries were built for one caller, so the owner keys come from the bound identity. Call sites that *pass* `sessionId`/`userId` keep compiling and can be left alone — the values simply stop being read — but code that *reads* them must change.

```ts
// before: the field was typed, and authoritative
const owner = ctx.userId;                  // string | undefined
// after: TS2339/TS2322 — there is no such declared field, and no need for one
```

And if a model or a client created **global** collections through `rag_create_collection`, it can no longer: the tool's `scope` is `session | user`. Create a deployment's shared collections in your own code with `IRagRegistry.createCollection({ scope: 'global', … })`, behind whatever check you apply.

**8. Construct your pipeline plugin with typed settings, drop `parseConfig`, and point subagents at `llm:`
keys** (§4.6.7). If you ship an `IPipelinePlugin`, the contract is now `name` and `build(ctx)`, and the
plugin reads no configuration. Its constructor takes a **typed settings object** — knobs, kinds, and the
**keys** naming which `llm:` entry each of its roles uses — parsed and validated by whoever constructs it;
at `build(ctx)` it resolves each key its settings **named** through `ctx.resolveNamedLlm(key)`, and each
role whose key was **omitted** through `ctx.resolveLlm(role)` with the role's own name — never the other way
round, because `resolveLlm` answers an unknown name with `main` and would turn a misspelled key into a silent
model change — and takes its other per-session objects from `ctx`. A key is a value; an LLM configuration or a `credentialRef` never reaches the plugin. If your plugin
is loaded dynamically and needs settings, export a **factory** under `pipelinePluginFactories` instead of an
instance — `(raw: unknown) => IPipelinePlugin`, parsing your own shape inside it — since the server cannot
call a constructor it has never seen; that factory is assembly code you ship beside the plugin, and by
convention your section carries no secret and no `credentialRef`, because nothing on the server resolves one
for it. A plugin that needs no settings keeps a plain instance export, which among the shipped ones is `flat`
alone. Whichever you export, the plugin's `name` must equal the key you export it under — the loader
refuses an instance whose `name` differs, and startup refuses a factory result that does; until now the two
were never compared, and a mismatched plugin was selected by one name and reported itself by the other. Every instance your plugin uses arrives through `ctx`, never through its constructor — the registry
constructs it once, process-wide, so a constructor argument would be shared by every session and frozen
against a model swap. If your plugin needs an authorized backend `ctx` does not offer — the caller's or the
deployment's — it cannot get one from the file or from its constructor: the remedy is a named, typed `ctx`
capability backed by the session-scoped resolver (§4.6.5), and `ctx` offers no credential lookup by design.

The YAML changes shape in two places, both the same rule: a subagent names a key of the top-level `llm:`
map instead of carrying an LLM configuration, so the file configures each model in one place and every role
that names a key shares its instance. An omitted `llm` means the role's own name — `planner`, `executor`, … —
resolved like any key, which is what `linear` and `stepper` already do; an absent `reviewer` or `finalizer`
block keeps meaning "the planner's"; `hint` stays where it
was, and a per-role temperature moves onto the `llm:` entry — a role that wants a colder model names a colder
entry. A DAG worker's own config file names keys of the main file's `llm:` map the same way — a string for
its `main`, or `{ main, helper }` — and an inline LLM configuration there is refused.

```yaml
# before — a full LLM configuration per subagent, inside the plugin's section
pipeline:
  name: controller
  config:
    subagents:
      planner:  { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY}, hint: … }
      executor: { provider: sap-ai-sdk, model: anthropic--claude-4.5-sonnet }
      evaluator: { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY} }

# after — models live in llm:, the plugin's section only names them
llm:
  main:  { provider: sap-ai-sdk, model: anthropic--claude-4.5-sonnet }
  cheap: { provider: openai, model: gpt-4o-mini, credentialRef: OPENAI }
pipeline:
  name: controller
  config:
    subagents:
      planner:   { llm: cheap, hint: … }
      executor:  {}                  # the role's own name: llm.executor if present, else the main instance
      evaluator: { llm: cheap }      # the same instance the planner uses

# a DAG worker's own file (./agents/sap-reader.yaml), the same rule
# before
llm:
  main: { provider: openai, model: gpt-4o-mini, apiKey: ${OPENAI_API_KEY} }
# after — a key of the MAIN file's llm: map
llm: cheap
```

**9. Narrow a widened logger option before reading it** (§7). Six readable option properties accept `ILogger | ITextLogger`, so a consumer that *reads* one must narrow first; a consumer that only *passes* a logger is unaffected. The guarded form is the one that compiles — the property is optional, so `normaliseLogger(options.logger)` alone fails with `TS2345`:

```ts
// before
options.logger.log(event);
// after
if (options.logger) normaliseLogger(options.logger).log(event);
```

**10. Give each store's account the rights its catalog needs, and handle one new error** (§6.3). `qdrant-rag`, `pg-vector-rag` and `hana-vector-rag` now keep a small catalog of their own beside the collections: created if absent, a record written by every `createCollection`, and a record deleted — before the data — by every `deleteCollection`. The catalog's physical form is each provider's own (a table, a collection), so what to grant is that provider's to document; what this release requires is that the account a store's credential names can create and write it, or `createCollection` now fails where it used to succeed. With `autoCreateSchema: false` the provider issues **no DDL at all**, the catalog table included: the operator creates it, with the statement the package exports for the purpose. A catalogued **Qdrant** store needs **Qdrant 1.17 or later**, for the insert-only write that makes a record's creation lose cleanly to a concurrent one. And `deleteCollection` can return `CatalogRecordDeleteError`: the record could not be removed, so nothing was deleted and the collection is still registered — retry it (§6.3). Three more things the catalog brings with it: `createCollection` now **refuses** a collection whose record exists, so creating the same (scope, owner, name) again works only after its deletion has finished; `qdrant-rag` creates its collection at `createCollection` rather than on the first write, spending **one embedding call** per collection created to learn the vector size; and a collection name held in several scopes of one registry must be addressed with its `scope` — by the tools and by `get`/`getEditor`/`unregister`/`deleteCollection` — or the call fails with `RAG_AMBIGUOUS_COLLECTION`. If you implement `IRagRegistry` yourself, accept that optional `scope`. **Collections created by v26.x before this release** have a store and no record, so creating one again is now refused with `RAG_ORPHAN_STORE` naming the store: call `createCollection` for it once with `adoptExisting: true`, which records the existing store instead of creating one, and it hydrates like any other from then on. A collection from v25 or earlier sits under its logical name, where the registry never looks; reach it with the provider's own `createCollection(oldName, { adoptExisting: true })`. And if a stage configuration named a **user or session** collection by its bare name in `ragStores`, it now names `user/<name>` or `session/<name>`; globals — `tools`, `history`, every configured store — keep their names, **except** one whose name begins with `user/` or `session/`, which is now refused at registration and must be renamed. Collections created before this release have no record, and read back `attributes` as `undefined`.

**11. Reattach collections after a restart by hydrating them, not by creating them again** (§6.3). Until this release a fresh registry got a `user` or `global` collection back by calling `createCollection` with the same identity, which reached the same store. That call is now refused — `RAG_DUPLICATE_COLLECTION` for a collection with a record, `RAG_ORPHAN_STORE` for one without — so an assembly that re-creates its collections at startup must instead read the catalog and adopt what it finds: `describeCollections()`, `openCollection(record)`, `adopt(record, rag, editor, providerName)`, for the records belonging to the caller whose registry it is building. The shipped `SmartServer` does this already. A collection created by v26.x before this release has no record: adopt it once with `createCollection(…, { adoptExisting: true })` (item 10), after which it hydrates like any other.

**Also changed, and worth checking against your deployment** — behaviour that moves with the items above without being an edit of its own:

- **A `dag` planner key now has to exist.** `plannerLlm: helper` or `planner` with no `llm:` entry of that name used to fall back quietly; a named key is now resolved strictly and refused at startup (§4.6.7). And an **omitted** `dag` planner key now resolves as the role name `planner` — the helper when one is configured — where it used to get `main`.
- **A configured embedder URL now arrives.** The old resolution bag passed `url`, while the Ollama embedder reads `ollamaUrl` and the OpenAI one `baseURL`, so a configured embedder URL has been silently ignored; the typed resolution passes each provider its own field. A deployment that set one and never noticed it was unused now reaches it.
- **`llm-agent-rag`'s resolution API is typed per target.** `resolveRag` and the flat `RagResolutionConfig` are gone for the `RagResolution` union, and embedder resolution takes a union discriminated by `provider` (formerly `embedder`), with a consumer factory named by its own arm.
- **An `llm:` entry without a `temperature` no longer inherits main's.** The library's `makeLlm` default filled in main's temperature for every role it built; a role entry now reaches the composition root as written, since a model's temperature is a property of its `llm:` entry (§4.6.6). The held main and classifier keep `temperature`/`classifierTemperature` as before; set a `temperature` on any other entry that relied on inheriting.
- **A declared `llm.classifier` is now used.** The held classifier was always built from `llm.main` at `classifierTemperature`, so a `classifier` entry — its model and its `credentialRef` — was validated and ignored. It is now built from that entry when declared.
- **`PUT /v1/config` model switching works in the shipped server.** It needs an `IModelResolver`, which the CLI never set, so the route answered 400; the composition root now supplies one.

---

## 9. Questions, and which of them block a plan

Numbering is load-bearing — other sections cite these by number, so an answered question keeps its place rather than being removed. **Nothing in this list blocks a plan any more.** Items 3, 4 and 5 are answered below because a plan needs their signatures; items 1, 6, 7, 8 and 10 are marked as outside this release’s path, with the reason, which is a different thing from being unanswered.

1. **HANA and Qdrant delegation.** Which `@sap/hana-client` properties carry a JWT; whether our Qdrant version supports claim-restricted tokens (§6.2). **Not blocking.** Delegated identity is §6.2’s far end, not workstream 3’s: that workstream ships persisted attributes, the two axes and the typed owner keys, none of which needs a JWT to reach HANA. It stays a later capability, and the plan declares the delegated path unimplemented rather than describing it as measured.
2. ~~**SAP AI Core.** Whether the SDK accepts a token source at all.~~ **Answered 2026-09-16 by reading the SDK, not its docs** (SAP/ai-sdk-js at `2315f43`, `@sap-ai-sdk/orchestration` 2.15, `@sap-cloud-sdk/connectivity` 4.x). It accepts one, by three separate routes:

   - **Orchestration** — every `OrchestrationClient` / `OrchestrationEmbeddingClient` overload takes a third argument `destination?: HttpDestinationOrFetchOptions`, and that type is an XOR: either a lookup by name **or a destination object you construct yourself**. A constructed one carries `headers?: Record<string, any>` ("additional headers to be used for calls against the destination"), so `{ url, authentication: 'NoAuthentication', headers: { Authorization: 'Bearer …' } }` is a complete, supported answer. `authTokens?: DestinationAuthToken[]` is the other route — but note the TypeScript type is `{ type; value; expiresIn?; error: string | null }`, with **no `http_header` field** and a required `error`. Blog posts showing `authTokens: [{ http_header: { key, value } }]` describe the destination service's REST payload, not the SDK's type; writing that would not compile.
   - **Freshness is already solved by our own call shape.** `sap-aicore-llm` builds a new `OrchestrationClient` **per call** (`sap-core-ai-provider.ts:561`, because tools change between calls) and already passes a destination there (`:71`, `:165`, `:564`) — today filled with `OAuth2ClientCredentials`. Moving that construction from the constructor into the per-call path lets `IBearerCredential.token()` be awaited for every request, which is exactly why it is a function. No callback or middleware inside the SDK is needed, and the official docs' "no per-request token refresh" is about *registered* destinations, not constructed ones.
   - **`foundation-models` is a separate, easier case.** `sap-aicore-embedder` does not use the SDK's auth at all there: it has its own `TokenProvider` (`auth.ts`) doing `grant_type=client_credentials` over `fetch`, and sets `Authorization: Bearer ${token}` by hand (`foundation-embedder.ts:98-101`). `IBearerCredential` replaces that provider directly.

   So `IBearerCredential` is viable for both packages. The `AICORE_SERVICE_KEY` fallback **moves to the composition root** rather than staying inside the provider (§4.6.2): a provider that reads an env var when it was handed no credential has two sources again, and the precedence rule this design deleted would be back. The root reads the env and builds the one credential the provider is constructed with — unchanged behaviour for a deployment that sets nothing else, and one source where it matters. **One gap to plan for:** `sap-aicore-embedder`'s orchestration path constructs `new OrchestrationEmbeddingClient(config, deploymentConfig)` with only two arguments (`orchestration-embedder.ts:50`) — the destination seam exists in the SDK but is not wired on our side, so the embedder needs that thread-through, which the LLM provider already has.
3. **`SessionGraphIdentity`'s home** — `llm-agent-libs` today; moving it into `@mcp-abap-adt/llm-agent` lets `IRagProviderSource` sit with the other contracts. **Moot: the only thing that wanted it moved was `IRagProviderSource`, which §6.2 deletes.** `SessionGraphIdentity` stays where it is — declared at `llm-agent-libs/src/session/session-graph-factory.ts:21`, exported at `llm-agent-libs/src/index.ts:209`. Moving a public type with no acceptor asking is churn, and §11 excludes it.
4. **The registry and `createFor`** — a provider obtained for one caller cannot live in a registry that outlives it. Per-caller registry, or a shared registry holding the `IRagProviderSource` and resolving per call (§6.4). **Answered in two halves** (§6.4). The question as asked dissolved: what made a *provider* caller-bound was the check, and the check has left the design, so the provider registry stays shared and unchanged. But the **collection** registry is a different object — the address space — and it is the caller's, because `SimpleRagRegistry` keys on the logical name alone (`:61`) and a shared one therefore throws on two callers' same-named collections (`:91`, `:163`) and accumulates the rest. A registry per pipeline is the arrangement, and it does need an API change — the optional `ragRegistryFactory(identity): Promise<IRagRegistry>` on `SessionGraphFactoryOptions` plus session-owned disposal, because `ragRegistry` there is one shared object handed to every build (`session-graph-factory.ts:93`, `:228`, `:280`). No composite key is added, and §6.4 says why.
5. **Who writes `attributes` at creation** — tool handler, consumer, or both; and the final signatures of `IRagRegistry.createCollection` / `IRagProvider.createCollection` (§6.3). **Answered in §6.3: whoever knows the caller, never the model** — a consumer calling `createCollection` directly, or, for a collection created through the tool, the consumer's `attributesFor` callback bound into `buildRagCollectionToolEntries` beside the identity — with the registry passing them through and never inventing them. The two signatures are fixed in §6.3 — `IRagProvider.createCollection`'s options gain `collectionName?`, `attributes?` and `adoptExisting?`; `IRagRegistry.createCollection` gains `attributes?` and `adoptExisting?` and forwards them with `collectionName`; `RagCollectionMeta` gains nothing — so nothing about them is left to a plan.
6. **An optional marker on authenticated clients.** A seam *may* declare that it accepts only clients a factory produced, making "forgot the caller's credentials" a compile error. It must stay opt-in: mandatory, it would dictate policy. Precedent for the risk: cloud-llm-hub PR #236 (`fix(security): stop caching MCP tool results across callers`, open) — a `ToolCache` shared by every caller returned one user's ABAP result to another within 30 s, below the role check and below their own SAP connection. **Not blocking, and deliberately not in this release:** it must stay opt-in, and an opt-in marker nobody has asked for is a contract without an acceptor (§11).
7. **`buildRagCollectionToolEntries`** — mounted by a consumer, or deleted. **Answered: it stays, and workstream 3 narrows it** (§5.1). Deleting it would hand the problem to every consumer; leaving it as written would ship five handlers that ignore the identity they are given. It gains the caller's identity at construction, the five handlers start using it, and which globals a caller reads is decided by the consumer when it builds that caller's registry, never by the tools, which only refuse to mutate a global. That it has no consumer today (§5) is why the defect went unnoticed, not a reason to keep it.
8. **The server's YAML `mcp:` block.** Injection already outranks it. It belongs to the `llm-agent-server` assembly, not to the library — but stdio genuinely requires spawning, so "the library never starts anything" is not an option. **Not blocking.** Workstream 1 merged without touching it, which is the evidence: injection already outranks it, so the question belongs to the `llm-agent-server` assembly and not to any contract here.
9. **One logger name, at the next major.** This release keeps `ILogger` (the event sink, handed out through `PipelineContext` and `IPipelinePlugin`) and adds `ITextLogger`. Converging them means renaming what consumers' plugins are typed by, which breaks them — so it is a major, scheduled, not silently deferred. Until then llm-agent carries two names for one job, and §7's own argument stands against it.
10. **`IF NOT EXISTS` is sent to every server version.** `CREATE TABLE IF NOT EXISTS` goes to both PostgreSQL and SAP HANA from one string (`pg-vector-rag/src/schema.ts:25`, `hana-vector-rag/src/schema.ts:21`, plus `CREATE EXTENSION IF NOT EXISTS` at `pg:20`), with no version negotiation anywhere. That clause is a server-version capability and those two products are each many versions, HANA Cloud differing from on-premise again. **Not blocking, and not this design's:** it predates it and affects the existing providers whatever happens here. Recorded because it was found while writing §6.3, and because a design must not lean on it — which an earlier draft of that section did.
11. ~~**One input for one job, at the next major.**~~ **Resolved by doing it now, not scheduling it.** The plain secret fields are removed in this release rather than deprecated: a way of *obtaining* a secret does not belong in a contract that says what an acceptor *needs*, and a static key is already a credential. `staticApiKey` / `staticLogin` make each call site a one-line change (§4.6.2). Unlike the logger (§9.9), `apiKey` is an input only — nothing hands it out — so nothing forced this to wait.

---

## 10. Workstreams

Four independent changes under one umbrella. Workstreams 1 and 4 are additive; 2 and 3 carry the breaks §8 lists, so “take one and decline the rest” holds for the *capability* in each, not for the migration — but that is about what a *consumer* may adopt, not about how the work is cut.

**One plan, and one PR per repository.** A workstream is a decomposition of the change, not of the paperwork. Four plans releasing the contract package four times would make it the servant of whatever this repository needed next, which is the failure §8 exists to prevent; and a plan per workstream cannot describe a path start to finish, because each would stop where the next begins.

Workstreams 1 and 4 are already merged, each as its own PR, before this rule was written — that is history and is not undone. What remains is workstreams 2 and 3, and they land as **one plan** across **two PRs**: one in `mcp-abap-adt-interfaces` carrying the three credential contracts, then — after that package is published, per §8’s order — one in this repository adopting them. **What version carries them is decided once, at the release, by what has accumulated — never per workstream.** Merging a workstream publishes nothing: its entries sit under `[Unreleased]` until the set is cut. Workstream 4 widens six readable option properties, which breaks a consumer that *reads* one (§7), so the release that carries this set is a major.

1. **MCP lifetime and identity** — `IMcpServer`, `withMcpServers`, optional `mcpServerFactory`, the optional `closePipeline` hook with `stop()` last (§3.4), stdio `env`.
2. **Credential contracts** — write them where §4.4 settles, and adopt them **in place of** the existing fields, not beside them (§4.6.2). Each **concrete** provider config declares its own `credential`, typed for what that target speaks. `apiKey` leaves `LLMProviderConfig` and `EmbedderFactoryConfig` with **nothing** replacing it in either — a shared base could only type the union, and the framework must not carry a secret between a consumer's own components. And `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig`, `DefaultModelResolver` and the five dynamic-import shims **leave `llm-agent-libs` altogether**: a dispatch that restates five constructors it does not own is a variation point the consumer owns (principle 5) and glue that belongs to the assembly (principle 2) — it was also the only reason a secret ever had to sit in a framework config. `IModelResolver` itself is **unchanged** — what held a config was `DefaultModelResolver`, and it leaves because building a provider for a newly chosen model needs a credential. The rest of this workstream's scope, which an earlier draft of this line omitted: **`SmartServerLlmConfig`, `SmartServerRagConfig`'s `user`/`password` (`smart-server.ts:167-168`) and `SkillPluginsConfig`'s qdrant store (`skill-plugins-config.ts:19`)** lose their secret fields and gain a non-secret `credentialRef`, staying serializable, while the unread legacy `PipelineLlmProviderConfig` and `PipelineRagStoreConfig` (`pipeline.ts:14-32`) are deleted — and the two RAG shapes **split into `store` and `embedder`, each with its own ref**, because one config names two independently authenticated targets (§4.6.4) — while construction goes through `BuildAgentDeps.makeLlm` (`:360`), whose signature is unchanged but which becomes **required** (§4.6.3) — no `role` parameter is added, because its twenty call sites name roles a closed union cannot; the YAML swaps `apiKey: ${VAR}` for `credentialRef: VAR` and its loader, substitution and validation stay in `-libs`; a new `@mcp-abap-adt/sap-aicore-auth` holds `serviceKeyCredential` and `parseServiceKey`, moved with their tests; `IPipelinePlugin` loses `parseConfig` and `build`'s config parameter, the shipped plugins' dialects move to the server, and `controller`'s subagents and the DAG workers name `llm:` keys (§4.6.7); `IServerPipelineContext` loses `makeLlm`/`llmMap`/`pipelineFallback`, `IPipelineContext` gains the required strict `resolveNamedLlm(key)` beside `resolveLlm(role)` — the only two ways an LLM reaches a plugin, and every implementation and test fixture of that contract gains the member — `IRoleLlmResolver` loses `makeLlm(lc)`, and the resolver admits a per-session scope beside the deployment one, disposal following the identity (§4.6.5, §4.6.6), though `SmartServer` — no caller credential in its sessions — ships the deployment scope only; and `llm-agent-server` becomes the composition root — env, credentials, provider dispatch, and the `IModelResolver` implementation behind `PUT /v1/config`.
3. **RAG identity and attributes** — persisted opaque `attributes` **plus the logical name beside them, the `describeCollections()` read, `openCollection()`, the `adopt()` hydration path, and catalog-record removal on delete, record-before-data **inside each provider's own `deleteCollection`** with `CatalogRecordDeleteError` when that first step fails and the registry restoring the entry on it** (§6.3); **and on the create side, which is what actually stops a resurrection** (§6.3): a collection is (scope, owner, name); `createCollection` creates the store with an operation that fails when it exists, writes the record **last** and create-if-absent, refuses a taken name with `RAG_DUPLICATE_COLLECTION` (record) or `RAG_ORPHAN_STORE` (store without record), takes a store over only with `adoptExisting?` on both the provider's and the registry's `createCollection`, and on a failed record write leaves the store in place as a named orphan rather than removing it, since no removal can be made atomic against another registry's adoption; no handle creates its store — `qdrant-rag` drops lazy `_ensureCollection` for one probe embedding in `createCollection`, and pg/hana `openCollection` handles are built with the schema marked ready; the registry (§6.4) is keyed by scope and name, its lookups take an optional `scope` and throw or return `RAG_AMBIGUOUS_COLLECTION` on an ambiguous name, a `deleting` reservation replaces the `deletions` wait, `closeSession` deletes with `scope: 'session'`, the `ragStores` projection keys user and session collections as `user/<name>`/`session/<name>` with those prefixes reserved for globals, and the collection tools gain the `scope` argument; the `storeNameFor` comment and three registry tests (`simple-rag-registry.test.ts:531-542`, `:544-557`, `:559-590`) change on purpose, since re-creating no longer reattaches; the collection registry a caller's tools see is that caller's, per pipeline, which needs the optional **async** `ragRegistryFactory(identity): Promise<IRagRegistry>` on `SessionGraphFactoryOptions` — async because hydration happens inside it and `SessionAgentParts` has no `userId` to defer it with — plus session-owned disposal, so this workstream **does** touch the session wiring (§6.4) — and `SmartServer` always supplies that factory, so the shipped server's sessions each own their registry rather than sharing `globalRagRegistry` (`smart-server.ts:1550`); the two axes; the typed owner keys; the caller's identity bound into the collection tool entries as the single source, with the optional `attributesFor` callback beside it through which `rag_create_collection` records the consumer's attributes — never the model's — for a collection it creates, closing the five handlers that ignore the context and the one that trusts it, and refusing every mutation of a global, creation included — `rag_create_collection`'s `scope` becomes `session | user` (§5.1); a credential on each store constructor **replacing** `apiKey`/`user`/`password`, with the connection string carrying the address only. No source union and no check (§5, §6.2). Registry rewiring is **in** scope, contrary to an earlier draft of this line: the provider registry stays shared and untouched, while the session gains an optional factory for its own collection registry (§6.4).
4. **Text-logger acceptance** — `ITextLogger`, the boundary adapter and its levels (§7). Convergence to one name is deferred to the next major (§9.9).

---

## 11. Out of scope

- Writing a contract nobody is specified to accept. Decision 11 asks who calls a thing; it does not ask the acceptor to exist first, and it cannot — an acceptor in another repository cannot depend on an unpublished contract. The criterion is §4.4’s: a contract may be written once a concrete accepting change has been specified and checked against the acceptor’s actual API, and it is published before that change adopts it.
- **cloud-llm-hub's** own implementation — its per-session graph and XSUAA-backed check — is theirs.
- `llm-agent-server`'s configuration **is no longer out of scope**, and an earlier draft of this list said it was. §10 requires it to become the composition root: env resolution, credential construction, provider dispatch and the `IModelResolver` implementation behind `PUT /v1/config`. It is the reference every other consumer copies, which is principle 2's whole point.
- **Anything that judges an incoming caller.** No admission step, no access-check contract, no per-request authorization, and nothing that wraps a server (§1.4). A consumer that needs those builds them where the request actually arrives, and §5 says what we hand it to decide with.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
- **Secrets outside this design's DTOs**, measured while planning it and left for the next release rather than widening this one: `HttpMarketplaceSource.apiKey` (`llm-agent-libs`), `skillPlugins.sources[].token`, `skillPlugins.catalog.connectionString`, `mcp[].headers`, and `skillPlugins.embedder`, which has no `credentialRef`. Each fails §4.6.2's test the same way the DTOs here did; they are listed so the next release starts from a measured list.
- **A caller's `userId` in `SmartServer`'s sessions.** Sessions are built from `{ sessionId }` alone (`session-registry.ts:91`), so the shipped server hydrates and creates no `user` collections (§6.4).
- **Merging DAG worker config files into the main one.** §4.6.7 moves a worker's model to a key of the main file's `llm:` map, so every model is configured in one place; the worker file keeps its prompts and its `rag:`, split like the main file's. Whether a worker needs a file of its own at all is a configuration-shape question, not an authentication one.
