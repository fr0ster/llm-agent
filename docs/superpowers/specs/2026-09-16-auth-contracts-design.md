# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review round 8 · **Date:** 2026-09-16 · **Base:** `main` at `bd5c464c` (v26.0.0)

## TL;DR

- **This is a framework, not an application.** Every seam below is **offered**; a consumer may decline it and keep what it has. Nothing here decides policy on anyone's behalf.
- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **Admission is the consumer's, and none of it is ours.** Every provider here is a *client* of an outside service; a client proves who it is and judges nobody, because nothing calls it. So there is no authorization at request time anywhere in this framework and no access-check contract in it — a deliberate limit on what we build, not a gap to fill (§1.4, §5).
- **MCP lifetime and identity are today app-local glue**, written once in `llm-agent-server-libs` and differently in cloud-llm-hub. The seam moves to `SmartAgentBuilder`, where every assembly already passes.
- **Collections have two axes**: `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Scope and the owner keys stay typed; only role and policy become opaque.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- **New capability is additive and declinable; what breaks is source-level and listed.** Every new seam is optional — the safer teardown order arrives through a new hook rather than a changed one (§3.4) — and no existing path changes behaviour by itself **with one exception, named because a blanket claim that is false once is worse than a qualified one**: the plugin loader begins **reporting** a malformed export it used to skip in silence, and refuses a plugin whose `name` differs from the key it is registered under (§4.6.7), so a deployment that has been running without a pipeline it thought it had will now be told. **What does break**, all of it deliberate and all of it in §8's migration note: §4.6.2 removes `apiKey` from `LLMProviderConfig` and `EmbedderFactoryConfig`, removes `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` from `llm-agent-libs`, strips the secret fields from `SmartServerLlmConfig` and `PipelineLlmProviderConfig`, stops the SAP providers reading `AICORE_SERVICE_KEY` (a new `sap-aicore-auth` package holds the exchange instead), and makes a connection string carrying credentials a construction-time error; §4.6.3 makes `BuildAgentDeps.makeLlm`, `resolveEmbedder` and `makeRag` **required**, so passing `{}` as `deps` stops compiling; §4.6.4 **splits** `SmartServerRagConfig` and `PipelineRagStoreConfig` into `store` and `embedder`, each with its own `credentialRef`, and adds `makeRag` to `BuildAgentDeps`; §4.6.6 removes `makeLlm`, `llmMap` and `pipelineFallback` from `IServerPipelineContext` and `makeLlm(lc)` from `IRoleLlmResolver`, and §4.6.7 adds a **required** `resolveNamedLlm(key)` to `IPipelineContext` — the strict lookup for a key a file named — so every implementation of that contract must add it, leaving the framework's own `resolveLlm(role)` — with the strict `resolveNamedLlm(key)` beside it — as the only way in — a usage-side contract may not construct; §4.6.7 removes `IPipelinePlugin.parseConfig` and the `config` parameter of `build` — configuration is read only by the server that assembles the pipeline, a plugin is constructed with typed settings that name each role's model by key and resolves the instance through `ctx`, `controller`'s `subagents.<role>` and a DAG worker's own config file name an `llm:` key instead of holding an LLM configuration, and a configurable dynamic plugin exports a **factory** rather than an instance; §5.1 removes `RagToolContext`'s declared `sessionId?`/`userId?` and requires `identity` on `buildRagCollectionToolEntries`; §7 widens six readable option properties. `IModelResolver`, `ILogger` and every contract not named above keep their shape. What version carries the set is §10's to state — it is a major.
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

   **And the rule is general, not an LLM rule — two more DTOs carry the same passenger.** *(Both of those two are RAG shapes, and §4.6.4 below shows why one `credentialRef` on either is not enough — read the two together.)* `PipelineRagStoreConfig.apiKey` is a plain secret, documented as “API key (for openai type or Qdrant auth)” (`pipeline.ts:32`); `SmartServerRagConfig` — the **exported** YAML DTO, and the one a PostgreSQL or HANA deployment actually fills — carries `user?: string` and `password?: string` (`smart-server.ts:167-168`); and `SkillPluginsConfig`'s store variant is `{ type: 'qdrant'; url: string; apiKey?: string }` (`skill-plugins-config.ts:19`, threaded at `skill-plugins-host-factory.ts:271`, `:310` and `controller-skill-pipeline-builder.ts:16`, `:47`). Both are YAML DTOs, and by this section's test both fail it the same way: remove the key and a complete store configuration remains. Two earlier drafts narrowed this: the first applied `credentialRef` to the LLM configs alone, the second added the pipeline and skill stores but missed `SmartServerRagConfig` — which is the one carrying `user`/`password`, so the rule would have held everywhere except the PostgreSQL and HANA path it matters most on.
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
       credentialRef: AICORE
       apiBaseUrl: https://api.ai.example
   ```

   Each nested shape carries **its own** `credentialRef`, which is what makes two accounts expressible; the ambiguous `url` and `model` land on the target that actually owns each; and the search knobs land on the one target that reads them. `dedupThreshold`, `vectorWeight` and `keywordWeight` were read **only** by the in-memory branch of `makeRag` — `VectorRag` with an embedder, `InMemoryRag` without one — and never by Qdrant, pgvector or HANA (`main:packages/llm-agent-rag/src/rag-factories.ts:266-286`), so an earlier draft of this example was wrong to leave them at `rag.` level as "belonging to neither target": they are the in-memory store's own settings, and the in-memory section carries them:

   ```ts
   type InMemoryStoreConfig = {
     type: 'in-memory';
     collectionName?: string;   // → VectorRag's namespace — new on this branch; main built neither store with one
     dedupThreshold?: number;
     vectorWeight?: number;     // hybrid scoring — read only when an embedder is present
     keywordWeight?: number;
   };
   ```

   A flat config that set them beside a Qdrant store was setting values nothing read, and the migration note says so rather than moving them to a new place where they would still do nothing. Two readers move with them, or hot reload of the weights silently stops: the config watcher reads `rag.vectorWeight`/`rag.keywordWeight` and applies them to live stores through `updateWeights` (`llm-agent-libs/src/config/config-watcher.ts:141-144`, `config-reload-watcher.ts:117-129` — only `VectorRag` implements it), and the section resolver defaults all three at `rag.` level (`resolve-config-sections.ts:199-201`, 0.92 / 0.7 / 0.3). Both read `rag.store` instead, and only when its `type` is `in-memory`. Two things the in-memory arm now does differently, stated rather than hidden: `collectionName` reaches `VectorRag` as its `namespace`, where `main` built it without one; and the keyword-only `InMemoryRag` in the reference below gets `dedupThreshold` alone — `main` also passed `queryPreprocessors`/`documentEnrichers`, which are programmatic objects no YAML can carry, so nothing a file configured is lost. `PipelineRagStoreConfig` splits the same way. **`SkillPluginsStoreConfig` does not**, and an earlier draft of this paragraph was wrong to say it should: it is already a discriminated union — `{ type: 'in-memory' } | { type: 'qdrant'; url; apiKey?; collection? }` — describing persistence only, with no embedder target in it to separate. Its qdrant arm simply gains its own `credentialRef?`. And it is worth noticing why that config needed no rescuing: `SkillPluginsConfig` **already** keeps its embedder in a separate `embedder` member, read at `skill-plugins-host-factory.ts:240`. The split asked of `SmartServerRagConfig` is therefore not an invention of this section — it is the shape a sibling config in the same package has been using all along. This is a **breaking** change to a YAML shape, and §8's migration note carries the before/after — it is a rename plus a nesting, mechanical for a consumer to apply.

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
   pipeline written against it, a consumer's included. And the framework's own contract is already
   sufficient: two of the four pipelines need nothing beyond `resolveLlm`.

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

   **What replaces them already exists, and that is the finding.** The **core** pipeline context contract
   — the framework's, in `llm-agent` — declares `resolveLlm(role: string): Promise<ILlm>`
   (`llm-agent/src/interfaces/pipeline-plugin.ts:48`),
   with its own comment saying why — *"Core-only; the server closes over its own config"*. A role in,
   an instance out: no config, no construction, no credential. So the right shape was designed at the
   start, `smart-server.ts:2462` already supplies it, and **two of the four pipelines already use it** —
   `pipelines/linear.ts:35` and `pipelines/stepper.ts:64` wire `makeRoleLlm: (role) => ctx.resolveLlm(role)`.
   `controller.ts:335` and `dag.ts:49` reach for `ctx.makeLlm` instead. So nothing needs inventing: the
   server-libs additions `makeLlm`, `llmMap` and `pipelineFallback` are a **duplicate of a core contract,
   weaker than it**, and they go — an earlier draft of this paragraph proposed a new `resolveRole`, which
   was that same mistake a third time. One of the three costs nothing to remove: `pipelineFallback` is
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
   requirement: `SmartServer` answers `main`, `classifier` and `helper` (and `planner`, read as `helper`
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
     path unvalidated. `SmartServerConfig.pipeline.config` stays `unknown` in the public shape — its meaning
     depends on which plugin is selected, and the server's parser for that plugin is what narrows it.
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

**Where addressing genuinely cannot answer, the framework declines instead of deciding.** A `global` collection with `authorization: 'role'` (§6.1) is addressable by everyone by construction, so narrowing says nothing about who may write it. The framework's own tools therefore do not serve that case at all. The line runs between reading and mutating, and it is not the same line for globals as for owned collections:

| | the caller's `session` / `user` collections | `global`, `public` | `global`, `role` |
|---|---|---|---|
| read (`rag_list_collections`, `rag_describe_collection`, query) | yes — the address space is the caller's | yes — `public` *means* everyone may read, so the value settles it | **refused** — who holds the role is policy |
| mutate (`rag_add`, `rag_correct`, `rag_deprecate`) | yes — the caller owns them | **refused** | **refused** |
| delete (`rag_delete_collection`) | yes, owner keys compared | **refused** (already true today, `:193`) | **refused** |

**`public` licenses reading, never writing**, and nothing in §6.1's two axes says otherwise: `public` and `role` are values about who may *reach* a global, and neither describes who may change one. Letting `rag_add` write a `public` global because it is public would be the framework inventing the rule that reachable implies writable — a policy, decided by us, on shared data, for every consumer. So framework tools mutate **no** global, whatever its authorization value, exactly as `rag_delete_collection` already refuses every global delete. A consumer that wants global writes mounts its own tool with its own check; that is not a limitation of this design but the whole of it. Refusing is not policy; it is declining to act with no basis, which is §1.2. A consumer that wants that case mounts its own tool, with its own check, on its own side of the boundary.

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
createCollection(name, {
  scope: RagCollectionScope;      // lifetime and addressing — typed
  sessionId?: string;             // owner key for scope 'session' — typed
  userId?: string;                // owner key for scope 'user' — typed
  attributes?: unknown;           // role and policy only — opaque, persisted, never interpreted
})
```

- Both owner keys stay typed. §6.1's "owner is implied by scope" needs a typed owner to read it from; only role and policy are opaque.
- **The provider persists `attributes`** and hands them back **unread**, to whoever asks. It does not consult them, because it has nothing to decide (§1.4). Today it persists nothing: pg and qdrant use the creation options only for `checkScope` and the id strategy, so a provider decides nothing after a restart or in a second instance.
- **This needs a catalog, not row metadata.** In pg a collection *is* a table, created per collection with `metadata JSONB` on each **row** (`schema.ts`) — there is nowhere to put a collection-level fact. Each provider therefore gains a small catalog of its own, **created if absent by whatever means its backend supports** — which statement that is belongs to the implementation and not to this design, for the same reason the paragraph on `openCollection` gives. In Qdrant it would be a catalog collection holding one point per collection (**unverified**: Qdrant exposes no collection-level metadata we have checked). Written on create, read on every decision. Additive: the catalog appears on first use.
- **A collection created before the catalog existed hands back `undefined`.** The provider does not invent attributes for it, and what an absent value means is the consumer's check to decide, outside this framework — which holds no opinion (§1.2, §5).
- `supportedScopes` keeps its meaning — what a provider can make *outlive* — which is lifetime, not permission.

**Persisting them is half a contract; reading them back is the other half.** As written above this section promised survival across a restart and specified only the write. Measured, there is no path back: `IRagProvider.listCollections?()` returns `Promise<Result<string[], RagError>>` — names and nothing else (`interfaces/rag.ts:219`) — and `IRagRegistry.list()` returns `readonly RagCollectionMeta[]` from memory (`:173`), which after a restart is empty. So the guarantee was unimplementable as specified. The read contract is therefore part of this design, not of the plan:

```ts
type RagCollectionRecord = {
  /** What the PROVIDER knows the store by — `storeNameFor`'s output. */
  readonly storeName: string;
  /** The LOGICAL name the registry registers it under. Must be persisted; see below. */
  readonly name: string;
  readonly scope?: RagCollectionScope;
  readonly sessionId?: string;        // owner key, typed (as above)
  readonly userId?: string;           // owner key, typed
  readonly attributes?: unknown;      // opaque, returned exactly as stored
};

// on IRagProvider — NEW and optional, never a widening of listCollections()
describeCollections?(): Promise<Result<readonly RagCollectionRecord[], RagError>>;

// on IRagProvider.createCollection's opts — the logical name and the attributes,
// because a catalog cannot return what it was never given
createCollection(name: string, opts: {
  scope: RagCollectionScope; sessionId?: string; userId?: string;
  collectionName?: string;           // the logical name; `name` is the store name
  attributes?: unknown;
}): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

// on IRagProvider — NEW and optional: build handles for a store that EXISTS.
// Creates nothing, ensures nothing, writes no catalog row.
openCollection?(record: RagCollectionRecord): Promise<Result<{ rag: IRag; editor: IRagEditor }, RagError>>;

// on IRagRegistry — NEW and optional: register an EXISTING store, no creation
adopt?(record: RagCollectionRecord, rag: IRag, editor?: IRagEditor): void;
```

**Two identifiers, because the provider never sees one of them.** `SimpleRagRegistry.createCollection` computes `storeName = storeNameFor(params)` and calls `provider.createCollection(storeName, …)` (`simple-rag-registry.ts:189`, `:193`), so the provider is handed the store name *as* the name. It does already receive the owner keys — `{ scope, sessionId, userId }` are in its signature (`interfaces/rag.ts:209-216`) — and what it never receives is the **logical** `collectionName`.

And it cannot derive it. `storeNameFor` (`:31`) returns `${base}_${digest}`, where `digest` is 12 hex characters of a SHA-256 and `base` is the logical name with every `[^a-zA-Z0-9_]` replaced by `_` and then truncated to fit 63 characters. The prefix is a readable hint, not the name: two different logical names collapse onto one base, and a long one loses its tail. So a catalog keyed only on what the provider was given can return the physical name and nothing else, and after a restart a consumer would know a store exists without knowing what to call it. The logical name must therefore be **written** into the catalog, which is why `createCollection` gains it alongside `attributes`.

**And hydration needs its own member, because `register` cannot express it.** `SimpleRagRegistry.register(name, …)` sets `storeName: name` (`:99`) — it assumes the two are the same, which is true for a collection registered directly and false for every hydrated one. `adopt?()` takes the record whole, so the logical name and the store name stay distinct, and it never creates anything: the store is already there. Optional on `IRagRegistry` so an external implementation of that interface is not broken by gaining a member.

**`adopt` needs handles, and a record is not one — so opening is its own member.** `describeCollections()` returns metadata; the only existing way to obtain an `IRag` and an `IRagEditor` is `IRagProvider.createCollection`, and it cannot serve here. Measured across the three shipped providers, they do not even agree on what it does: `pg-vector-rag` and `hana-vector-rag` call `await rag.ensureSchema()` inside it (`pg-vector-rag-provider.ts:84`, `hana-vector-rag-provider.ts:87`), issuing DDL; `qdrant-rag` issues nothing and defers creation to `_ensureCollection` on first use. **And whether a second call is harmless is not something this design may reason about.** An earlier draft of this paragraph argued it was safe today because the DDL says `IF NOT EXISTS`. That argument is inadmissible twice over. It answers a question about a *contract* with the text of one implementation, which §4 forbids. And it is not even a fact: `IF NOT EXISTS` on `CREATE TABLE` is a server-version capability, PostgreSQL and SAP HANA are each many versions, HANA Cloud and on-premise differ again, and the same statement is sent to all of them from one string. What a given backend does with a repeated create is unknown from here and must stay irrelevant here. The contract never promised idempotence, so nothing may rely on it — that alone settles it, and it settles it for every backend rather than for the two we happened to read.

And the accident ends with this very workstream: once `createCollection` also writes a catalog row, calling it to hydrate would rewrite that row, and — since a hydrating caller passes no `attributes`, it is reading them — overwrite what it was trying to recover. So `openCollection?(record)` is separate by necessity, and it is cheap: it is qdrant's existing body, and pg's and hana's minus the `ensureSchema` call.

**The hydration flow, whole:** the consumer calls `describeCollections()`, keeps the records belonging to the caller whose pipeline it is building, calls `openCollection(record)` for each, and `adopt(record, rag, editor)` to register them under their logical names. Nothing in that path creates a store, ensures a schema, or writes a catalog row — which is what "creates nothing" has to mean to be worth saying. The registry it hydrates into is that caller's, not a shared one (§6.4).

**Deletion has to reach the catalog, or hydration undoes it.** A record that outlives its collection is not a stale row, it is a resurrection: the next hydration adopts a collection whose data is gone and hands the caller something that looks valid. So the **provider's** `deleteCollection` removes the catalog record too.

**Where the ordering lives: inside the provider.** The catalog is the provider's own storage — each gains one, per the catalog bullet above — so record-before-data is its invariant to keep, and the registry's algorithm does not change — it unregisters, then makes the one `provider.deleteCollection(storeName)` call it makes today, and the typed failure travels back up through the `Result` it already returns. A registry orchestrating two phases would have to know whether a given provider has a catalog at all, which is precisely the implementation detail a contract must not carry (§4).

**The order is unregister, then — within that one provider call — the record, then the data** — and an earlier draft of this paragraph got it wrong in a way worth recording. It asked for a failed record deletion to “fail the operation and leave the collection accessible”, which cannot be done and should not be: `SimpleRagRegistry.deleteCollection` unregisters as its first act and says why in its own comment — *“It is unregistered first, whatever follows, so nothing can reach it again”* (`:246-258`). That invariant exists so nothing reaches a collection mid-deletion, and trading it away to satisfy a sentence would be the worse bargain.

Keeping it costs nothing, because reachability was never the point:

- **The record's deletion fails** → stop, and do not touch the data. The collection is unregistered in this process, but its record and its data both survive intact, so the next hydration adopts it whole. That is a **failed delete, fully retryable** — not the resurrection this section is about, which is a record pointing at data that is gone.
- **The record is gone and the data's deletion fails** → as today: unregistered, gone for the caller, and the orphaned store named in the warning (`:220-225`). Nothing will adopt it, because nothing records it.

**The two phases must be tellable apart, and one `Result` cannot do it.** `IRagProvider.deleteCollection?` returns an undifferentiated `Result<void, RagError>` (`interfaces/rag.ts:218`), and the tool turns *any* error into `{ ok: true, warning: "… was removed, but its data could not be deleted" }` (`:220-225`) — so a record failure would be reported as data loss after a successful removal, which is wrong twice. The failure therefore names itself, which is how this codebase already works (`ReadOnlyError`, `DeleteUnsupportedError`, `SessionCloseIncompleteError` and the rest of `rag/corrections/errors.ts`) and what interfaces decision 25 asks for: a `CatalogRecordDeleteError extends RagError`, no phase flag on the result. The tool then answers `{ ok: false }` for that one and keeps today's warning for the rest.

**`closeSession` inherits this, but less automatically than claimed.** It does call `deleteCollection` per victim and aggregate what failed into `SessionCloseIncompleteError` (`:324-334`), so the mechanism carries over untouched. What it cannot do by itself is distinguish a retryable record failure from an orphaned store — the typed error is what carries that through the aggregate, which is the second reason for typing it rather than flagging it.

Each is a **new** optional member rather than a widening, for the reason §4.6.2 gives: a provider is something consumers *implement*, so widening a return type breaks every implementation, while an optional addition breaks none. A provider without a catalog simply does not declare it.

**Hydration is explicit, consumer-triggered, and per caller — never automatic.** The framework does not repopulate a registry at startup, for two reasons. When to do it depends on the assembly, and choosing a moment would install a privileged topology (§1.3). More importantly, hydrating one shared registry with every collection the catalog holds would hand every caller an address space containing everyone else's collections — precisely the widening §5.1 exists to prevent. So the consumer reads the catalog and registers what belongs to the caller whose pipeline it is building, which is the same construction-time act as §5.1: the registry a caller reaches contains that caller's collections because that is what was put in it.

Until something hydrates, the registry answers exactly as it does today, and a collection whose `attributes` were never written hands back `undefined` — which the bullet above already covers.

Who writes `attributes`: the component that knows the caller — the tool handler from its `RagToolContext`, or the consumer calling `createCollection` directly. The registry passes them through and never invents them (§9.5).

### 6.4 Which registry is shared, and which is the caller’s

`SimpleRagRegistry` is shared across per-session builds and receives providers through `setProviderRegistry` (`llm-agent-libs/src/builder.ts:855`); its own comment explains why some collections opt into idempotent registration. **The question that stood here has dissolved rather than been answered.** It asked how a registry outliving a caller may hold a provider bound to that caller — and what bound one was the `AccessCheck` inside `createFor`'s facade, which §6.2 deletes. What can still be caller-bound is a provider constructed with a caller's own credential, and §4.1 already places that: the pipeline that owns the caller constructs it, and it is not registered anywhere outliving that pipeline. The **provider** registry goes on holding shared, service-credentialed providers exactly as today.

**The collection registry is a different object, and it is the address space.** §6.3 has the consumer hydrate the records belonging to one caller; §5.1 has the tool entries built for one caller. Both are about the registry those tools are handed, and a *shared* one cannot be that registry — which is not an argument, it is the key. `SimpleRagRegistry.entries` is a `Map` keyed on the logical name alone (`:61`). So a shared registry handed caller A's collections and then caller B's fails in two different ways: for two callers with a collection of the **same** name it throws — `register` refuses a duplicate (`:91`) and `createCollection` guards identically (`:163`) — and for **differently** named ones it quietly accumulates, so A's tools address B's collections. A loud failure and a silent leak, from one missing dimension in a key.

**So the registry a caller's tools see holds that caller's collections and the globals, and this design does not add a composite key to make a shared one hold more.** A registry per pipeline is the arrangement, and an earlier draft claimed it needed "no contract change". That was false, and measuring the shipped session assembly says so: `SessionGraphFactoryOptions.ragRegistry` is a single `IRagRegistry` (`session-graph-factory.ts:93`), handed to every session build (`:228`), and the object `closeSession` is called on at dispose (`:280`). There is no way for a session to own its collection registry through that API.

Its own comment is the more telling part — *“GLOBAL RAG provider/registry — shared; **the per-call scope filter isolates**”*. That is the model §5.1 replaces, written down: isolation resting on a filter applied at each call, which is the forgettable per-call mechanism, not the instance. So this is not plumbing to be tidied later; the assembly currently depends on the assumption being removed.

**The seam, therefore:** `SessionGraphFactoryOptions` gains an optional `ragRegistryFactory?: (identity: SessionGraphIdentity) => Promise<IRagRegistry>`. When it is given, the session owns the registry it returns and `dispose()` closes **that** one instead of calling `closeSession` on a global; when it is absent, `ragRegistry` behaves exactly as today, so nothing breaks and no consumer is forced.

**It returns a promise, and that is not a stylistic choice.** Hydration is asynchronous by construction — `describeCollections()` and `openCollection()` both are — so a synchronous factory could not hydrate what it returns, and an earlier draft of this paragraph declared one. Nor can the work be deferred to `buildAgent`: `SessionAgentParts` carries `sessionId` and no `userId` (`session-graph-factory.ts:33`), so a build callback cannot filter `user`-scoped records by the caller's full identity — it would have to guess, or skip them. The factory has what is needed, because `SessionGraphIdentity` is `{ sessionId, userId? }` (`:21-24`), and awaiting it costs nothing: `build` is already `async build(identity): Promise<SessionGraph>` (`:166`), so its signature does not change either.

So **the factory is where hydration happens** — it is handed the identity, reads the catalog, keeps that caller's records, opens and adopts them, and returns a registry already populated. One seam, full identity, and no second hook to forget. How a session registry comes to see the `global` collections — seeded with references to the shared instances, or resolved through the shared one — is that function's business, because composing topology is the consumer's (§1.3). The framework's job is only to make the session-owned arrangement expressible, which today it is not. A composite key would instead build a structure whose purpose is to hold several callers' collections at once — the wide address space §5.1 exists to prevent — and every read of it would then need the dimension applied correctly, every time, by every caller. That is the class of mistake this whole section removes.

The framework does not *mandate* the arrangement (§1.3); it states what the tools require of whatever registry they are given. A consumer that hands them a shared one gets collisions and accumulation rather than a diagnostic, which is reason enough for the requirement to be written here rather than discovered.

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
| `@mcp-abap-adt/llm-agent` | **`IPipelinePlugin` loses `parseConfig` and `build`'s `config` parameter, and `PluginExports` gains `pipelinePluginFactories` (§4.6.7)** — a plugin's constructor takes typed settings and its instances arrive through `ctx`, so no configuration travels through its usage contract, and a configurable third-party plugin is exported as a factory the server calls; **`IPipelineContext` gains `resolveNamedLlm(key)`**, the strict lookup for a key a plugin's settings named, beside `resolveLlm(role)`'s defaulting one, so a misspelled key is an error rather than `main` (§4.6.7) — additive for a plugin, but a consumer that *implements* `IPipelineContext` must add it; **`LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` removed** — a contract carries no secret (§4.6.2) — plus `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated as a consumer seam; `attributes` and the logical `collectionName` on provider collection creation, the optional `describeCollections()` catalog read, the optional `openCollection()` that builds handles for an existing store, the optional `IRagRegistry.adopt()` that registers one, the `CatalogRecordDeleteError` type and the tool that answers `{ ok: false }` to it rather than warning about data (§6.3) — the deletion itself belongs to the providers, below; the caller's identity bound into `buildRagCollectionToolEntries` and used by all seven handlers, with `RagToolContext`'s declared `sessionId?`/`userId?` removed so there is one source (§5.1); `ITextLogger` re-exported from `interfaces-utils`, **exported `ILogger` unchanged** | **breaking** at source level: `IPipelinePlugin` loses a member and a parameter, and `IPipelineContext` **gains a required** `resolveNamedLlm`, so every implementation of it — a consumer's, a test fixture's — must add one (§4.6.7); otherwise additive at runtime, and a consumer that *reads* a widened option property must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-libs` | **the plugin loader validates what it loads and records what it refuses (§4.6.7)** — it checked `build` and then silently skipped, while recording an error for a duplicate name, so it was inconsistent with itself; `withMcpServers` on the builder; start in `build()`, `stop()` into `closeFns`; optional `mcpServerFactory` on the session factory; **`makeLlm`, `makeDefaultLlm`, `MakeLlmConfig` and `DefaultModelResolver` removed** (§4.6.2), `MakeLlmConfig` with them, and `DefaultModelResolver` with them — `IModelResolver` itself is **unchanged** (`model-resolver.ts:7`), since what held a config was the implementation; optional `ragRegistryFactory(identity)` with session-owned disposal (§6.4) | **breaking**: exported functions and `DefaultModelResolver` are removed; the `IModelResolver` contract is untouched. Also additive at runtime for the MCP and RAG seams, and `SessionGraphFactoryOptions.logger` is widened, so a consumer that *reads* it must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-server-libs` | **`IServerPipelineContext` loses `makeLlm`, `llmMap` and `pipelineFallback` (the last already dead) and keeps the framework's existing `resolveLlm(role)` and the new strict `resolveNamedLlm(key)` as the only two ways an LLM reaches a pipeline — whose key space stays the consumer's, and `IRoleLlmResolver` loses `makeLlm(lc)` (§4.6.6) — a usage-side contract may not construct, so the per-step authorization path closes by type**; **the four shipped plugins with a dialect (`linear`, `stepper`, `dag`, `controller`) lose their parsers to the server, which parses the selected section in `start()` and constructs that plugin with typed settings through a registry of factories, and `controller`'s `subagents.<role>` and a DAG worker's own config file name a key of the main file's `llm:` map instead of holding an LLM configuration (§4.6.7; a worker file resolves with the main map in scope and its three LLM slots come from the resolver, its RAG and MCP slots staying cached per worker; `RoleLlmResolver` answers a key with no `llm:` entry with the held `main` instance instead of a fresh build from `llm.main`; and the in-memory search knobs move under `rag.store`, taking the config watcher and the section defaults with them (§4.6.4, §4.6.6, §4.6.7)**; the resolver becomes **scoped**, deployment-wide and per-session, with disposal following the identity (§4.6.5, §4.6.6); consumes the builder seam; `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` deprecated, not deleted; **and it constructs providers the way the library used to** — `makeLlm({…})` at `build-dag-coordinator-deps.ts:89` — and its `SmartServerLlmConfig.apiKey` (`:129`) and `PipelineLlmProviderConfig` secrets (`pipeline.ts:14-26`) are passengers too, so they go while those DTOs stay **serializable**, gaining a non-secret `credentialRef` so a role can still name its account — and **`SmartServerRagConfig` and `PipelineRagStoreConfig` split into `store` and `embedder`, each with its own `credentialRef` (§4.6.4)**, because one flat shape described two independently authenticated targets and `url` meant either one's address depending on its neighbours — construction goes through `BuildAgentDeps.makeLlm`, which already exists (`:360`) and becomes **non-optional** so a missing seam is a build error rather than a deployment that stops starting (§4.6.3), because a YAML file holds neither an object nor a function (§4.6.2). The loader, env substitution and schema validation stay here; only the rule requiring `AICORE_SERVICE_KEY` (`config-validator.ts:72`) leaves with the credential | **breaking**: two exported DTOs lose secret fields, one required. `modelResolver?` stays optional (`:334`), and the dispatch and the resolver implementation land in `llm-agent-server`, the app |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`. `IMcpServer` arrives here as the generic `mcpServerFromFactory` adapter (workstream 1); the typed implementations, whose constructors demand a credential per §3.3, land with the credential contracts in workstream 2 — **http first** (the main protocol; `start()` holds a connection rather than spawning), stdio beside it for the local case | additive |
| `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | a credential in their own constructors, replacing `apiKey`/`user`/`password`, with a connection string that carries the address only; persist `attributes` in a catalog of their own, hand them back unread through the new optional `describeCollections()`, build handles for an existing store through `openCollection()`, and **delete the catalog record before the data inside their own `deleteCollection`, raising `CatalogRecordDeleteError` and leaving the data untouched when that first step fails** — these packages own the backend catalog, so resurrection is stopped here or nowhere (§6.3). **No check is asked here** (§5) | **breaking**, and in two ways: source-level, because `apiKey`/`user`/`password` are removed from the configs (§4.6.2), and at runtime for one input, because a connection string carrying credentials is now refused at construction rather than used. What the measurement in §4.6.1 still buys is narrower than an earlier draft of this cell claimed: the *resolvers* are absent from both barrels and unreachable through a closed `exports` map, and their only caller is already `async`, so making them async is invisible — but the config type is public, so removing a field from it is not |
| `llm-agent-rag` | **it holds no store, no config and no catalog of its own** — an earlier draft of this matrix listed it beside the three store packages and attributed their work to it, which is why the first plan derived from this spec left it owned by nobody. Its whole content is the **resolution bridge** between serializable configuration and a constructed provider: `resolveEmbedder`, `resolveRag` and `makeRag`. Its option bags must therefore carry `credential` — and `apiBaseUrl` for the SAP targets, which no longer read the environment — in place of `apiKey`/`user`/`password`, and must forward the credential **object itself**, since quota scoping keys on its identity (§4.6.2) and a copy would split one account into two buckets. Two properties of this package made the omission silent rather than loud, and both were measured, not supposed: the option bags were `Record<string, unknown>` reaching cast constructors — the store's through a second cast — so a removed field produced **no compile error here**; and neither resolver spread its input, each copying a hand-picked whitelist, so a member the whitelist omitted was dropped in silence whatever the types permitted. **Those two properties are the defect, not the premise, and they go.** An earlier draft of this cell concluded that a runtime `kind` check was "consequently the only place a mismatch can be caught" — which was true only for as long as the casts stood, and principle 10 asks the opposite question: which cast made the check necessary. The path is typed end to end instead. The resolution input becomes a **discriminated union** whose arms carry what each backend's own constructor demands, and the dispatch runs over **literal** import specifiers, which type-resolve at compile time while each package stays an optional peer (they are declared in both `peerDependencies` and `devDependencies`). Then the wrong credential kind, a missing required one and a leftover `apiKey`/`user`/`password` are **build errors**, and `RagFactoryOpts`, the constructor casts and the name maps are deleted rather than improved — none had a consumer outside this package. Two runtime checks survive because no type can make them: a **missing optional peer**, and a legacy secret field arriving from an **untyped** source, since a loaded YAML object is not a fresh literal and no excess-property check ever sees it. The embedder half has the same castful shape and gets the same treatment; until it does, its bag is the one place this package still checks at runtime what a type could have refused. **No access check is asked here** (§5) | **breaking**: the resolution config types are public, so removing a field from them is source-breaking, and a configuration that named a secret by the old field now fails at resolution with the target named instead of constructing a provider that cannot authenticate |
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

**Release shape.** **New capability** arrives as optional seams a consumer may decline, and none of those changes an existing path's behaviour. That is the whole of what is additive here, and an earlier draft of this paragraph said it about the release as a whole — which the rest of this section then contradicted. What is **not** declinable: exported LLM factories and `DefaultModelResolver` are removed (§4.6.2), the SAP providers stop reading `AICORE_SERVICE_KEY`, a connection string carrying credentials is refused where it used to be used, and §5.1's identity changes land. Every seam that *is* declinable — including the safer teardown order, which arrives as the optional `closePipeline` hook (§3.4). Two things are not declinable, both from §5.1's single-identity rule:

- **A required input.** `buildRagCollectionToolEntries` now takes an `identity`, so the old one-field call stops compiling. Deliberate, and §5.1 says why no overload without it is kept: an optional `identity?` would mean “do not narrow”, which is an unnarrowed address space reached by forgetting a field.
- **A library default that is no longer supplied.** `SmartServer` fills `BuildAgentDeps.makeLlm` with `_makeLlmDefault` today (`smart-server.ts:954`), so a deployment that never injected one **stops starting** once the default goes — a runtime break, not only a source one. The validator refuses at startup and names the seam; migration item 4 shows the call.
- **Two contract removals.** `LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` go (§4.6.2): a contract carries what an acceptor *needs*, and a plain key is one way of *obtaining* it. `staticApiKey(key)` converts a call site in one line. The concrete providers replace their own fields the same way, and a connection string that carries credentials is refused at construction rather than silently outranked.
- **A removal, measured rather than assumed.** `RagToolContext` loses its declared `sessionId?`/`userId?`. Against the repository's own tsc (6.0.3), a call site passing those keys still compiles — the type declares `[key: string]: unknown`, which absorbs them — while a *reader* of one gets `error TS2322: Type 'unknown' is not assignable to type 'string | undefined'`. That is workstream 4's read-side class (§7), and no reader exists today because nothing mounts these tools.

The deprecations — `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` — are markers for a later major, not part of this one. `McpClientFactory` is a special case: it stays as the default implementation's factory, which `mcpServerFromFactory` consumes, and is deprecated only as the **consumer-facing** seam. The version this ships as is decided at the release by what has accumulated (§10), not here: as it stands the set carries workstream 4's read-side break and §5.1's two, so it is a major.

### Migration — what a consumer on the old contract must do

Nine changes need an edit, and none of them is optional — nothing here is deprecated-but-working, because §4.6.2 removes rather than deprecates. Everything *else* is declinable as usual: a consumer that leaves a new seam unused keeps today’s behaviour.

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

That function is the package's existing `TokenProvider` and `parseServiceKey` moved out with their tests, so behaviour is unchanged for a deployment that sets the same env var — it is now read one level up, by you.

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
// Your composition root, in full. This block is extracted back out of this file and
// compiled under --strict against stub declarations of the contracts, so what is
// written here is exactly what was checked — an earlier version was verified as a
// file and then pasted without its type aliases, which is not the same thing.

type AnyCredential = IApiKeyCredential | IBearerCredential | ISecretLoginCredential;

type CredentialEntry = {
  /** Absent means this target needs none. Any of the three kinds is admissible: a
   *  store entry holds a secret-login, an LLM entry an api key or a bearer token. */
  credential?: AnyCredential;
  /** SAP AI Core only, and it travels with the credential from the same service key. */
  apiBaseUrl?: string;
};

/** What an entry with no `credentialRef` resolves to. One per deployment, and the
 *  root's own choice — NOT a provider's. An OpenAI-only deployment points it at its
 *  OpenAI key, a SAP-only one at its service key, a keyless one at `{}`. */
// One default per role, because an entry holds one credential and a store's kind
// need not match an embedder's. All three may name the same entry when they truly
// are one account — that is this line, not anything in YAML.
const DEFAULT_LLM_REF = 'PRIMARY';
const DEFAULT_STORE_REF = 'PRIMARY';
const DEFAULT_EMBEDDER_REF = 'PRIMARY';

/**
 * A function, not a Map literal, so nothing is read or parsed until it is asked for —
 * and memoized, so the same reference always hands back the SAME credential object.
 * That identity is load-bearing, not tidiness: the 429 gate keys a quota bucket on it
 * (§4.6.5), so building a fresh one per lookup would give one account a new bucket
 * every time and quietly stop the gate gating.
 */
const entries = new Map<string, CredentialEntry | undefined>();
function credentialFor(ref: string): CredentialEntry | undefined {
  if (entries.has(ref)) return entries.get(ref);
  const entry = buildEntry(ref);
  entries.set(ref, entry);
  return entry;
}

function buildEntry(ref: string): CredentialEntry | undefined {
  switch (ref) {
    case 'PRIMARY':
      // This deployment's one account. Whatever it is — here, an api key.
      return { credential: staticApiKey(requireEnv('DEEPSEEK_API_KEY')) };
    case 'OPENAI_KEY_CHEAP':
      return { credential: staticApiKey(requireEnv('OPENAI_KEY_CHEAP')) };
    case 'AICORE_PROD': {
      const k = serviceKeyCredential(requireEnv('AICORE_SERVICE_KEY'));
      return { credential: k.credential, apiBaseUrl: k.apiBaseUrl };
    }
    case 'RAG_PG':
      return { credential: staticLogin(requireEnv('PG_USER'), requireEnv('PG_PASSWORD')) };
    case 'LOCAL_OLLAMA':
      return {};
    default:
      return undefined;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set, but a credentialRef asked for it`);
  return v;
}

const deps: BuildAgentDeps = {
  async makeLlm(cfg) {
    // One helper for all three seams (defined below), so one rule about what a named
    // ref must resolve to. Note that every provider config is built from NAMED fields:
    // nothing spreads cfg, so credentialRef cannot ride along into a provider.
    const entry = lookup(cfg.credentialRef, DEFAULT_LLM_REF, cfg.provider);

    const provider = (() => {
      switch (cfg.provider) {
        case 'openai':
          return new OpenAIProvider({ credential: entry.require('api-key'), model: cfg.model! });
        case 'anthropic':
          return new AnthropicProvider({ credential: entry.require('api-key'), model: cfg.model! });
        case 'deepseek':
          return new DeepSeekProvider({ credential: entry.require('api-key'), model: cfg.model! });
        case 'ollama':
          // optional, because a bare Ollama needs none — but a ref NAMED here must
          // still resolve, or a typo would quietly send no Authorization to a gateway
          return new OllamaProvider({
            baseURL: cfg.url, model: cfg.model!, ...entry.optional('api-key'),
          });
        case 'sap-ai-sdk':
          return new SapCoreAIProvider({
            credential: entry.require('bearer'),
            apiBaseUrl: entry.requireApiBaseUrl(),
            model: cfg.model!,
          });
        default:
          throw new Error(`unknown llm provider '${cfg.provider}'`);
      }
    })();

    return new LlmAdapter(new LlmProviderBridge(provider), { model: provider.model });
  },
};
```

Four things in it are the model rather than decoration, and each is where an earlier version went wrong:

- **`credentialFor` is a function, not a `Map` literal.** A literal built every entry at startup, so a DeepSeek-only deployment had to have an `AICORE_SERVICE_KEY` — and `process.env.X!` only hid the `undefined` from the compiler, it did not make the value present. Nothing is read or parsed until a reference asks for it, and `requireEnv` fails with the variable's name when it is missing.
- **A reference resolves to an *entry*, and the entry admits all three credential kinds.** SAP's service key yields an address as well as a credential, and both belong to the same account — so the SAP branch reads `apiBaseUrl` from the entry rather than re-reading a global env var, which is what makes two AI Core accounts expressible. Admitting `ISecretLoginCredential` is what lets the same registry answer for `rag.user`/`rag.password`; an earlier version typed it to api-key and bearer only, so a PostgreSQL entry could not be added to the registry it was told to use.
- **Narrowing is explicit, and optional where the target's is.** `apiKey()` refuses anything else for the three providers that need a key; `optionalApiKey()` keeps Ollama's key optional, because `OllamaProvider` accepts one today (`providers.ts:204`) and a gateway in front of it may require it — the design replaces plain keys with typed credentials rather than removing the capability.
- **The default reference is a name the root chooses — and one per role, not a provider's and not one globally.** Two earlier versions failed this differently: the first said so in prose and passed `undefined` through a cast, which would have failed at the first request; the second hardcoded the fallback to `'DEEPSEEK_API_KEY'`, so an OpenAI-only, SAP-only or keyless deployment that omitted the reference would have been made to produce a DeepSeek variable. One named default entry per deployment, pointed at whatever that deployment actually holds — an api key, a service key, or `{}`.

`llm-agent-server` carries exactly this switch as the reference implementation — that is what makes it the example (principle 2), and why §11 no longer lists its configuration as out of scope.

`credentialRef` is optional **in each section independently** — and the fallback is therefore **per role**, not one global name. An earlier version of this paragraph said `DEFAULT_REF` for all of them, which cannot work: an entry holds **one** credential, so the same default cannot be an `ISecretLoginCredential` for a PostgreSQL store and an `IApiKeyCredential` for an OpenAI embedder at once. The root nominates one default per role — `DEFAULT_LLM_REF`, `DEFAULT_STORE_REF`, `DEFAULT_EMBEDDER_REF` — and a deployment where all three genuinely are one account points all three names at the same entry, which is a line in the root rather than anything in YAML. Omitting a ref means "that role's default", and a deployment whose targets want different credential kinds names them explicitly. This is what a single-account setup wants. The same swap applies to the store configs: `rag.apiKey`, `rag.user`/`rag.password` and a qdrant skill store's `apiKey` all become `credentialRef`, resolved through the **same `credentialFor`** as the LLM entries, which is why its entry type admits `ISecretLoginCredential` (the `RAG_PG` case above). The store constructors then take the credential itself (§4.5).

**The same `deps` object carries the other two seams, and both are now required** (§4.6.3 item 3, §4.6.4). `resolveEmbedder` and `makeRag` stop being defaulted for the same reason `makeLlm` did: a library that may not construct an authenticated LLM from configuration may not construct an authenticated embedder or store from it either. `BuildAgentDeps`'s doc comment used to promise that passing `{}` preserved existing behaviour, and it no longer can — every call site, tests included, names the seams:

```ts
const deps: BuildAgentDeps = {
  async makeLlm(cfg) { /* as above — same lookup helper */ },

  // The embedder's own account. Spreading the entry's credential in unnarrowed
  // would let an OpenAI embedder receive a login, so this dispatches on the
  // provider and narrows to the kind that provider can actually use — the same
  // shape as makeLlm above, for the same reason.
  resolveEmbedder(cfg, options) {
    // The ref ends HERE: destructured out, so no spread can carry it onward into a
    // runtime object. `rest` holds only what the embedder itself needs.
    const { credentialRef, ...rest } = cfg;
    const entry = lookup(credentialRef, DEFAULT_EMBEDDER_REF, cfg.provider);
    switch (cfg.provider) {
      case 'openai':
        return resolveEmbedder({ ...rest, credential: entry.require('api-key') }, options);
      case 'sap-ai-core':
        return resolveEmbedder(
          { ...rest, credential: entry.require('bearer'), apiBaseUrl: entry.requireApiBaseUrl() },
          options,
        );
      default:
        // ollama sends nothing on the wire, so a credential here would be a member
        // nobody calls — and naming one explicitly is a misconfiguration, not a hint
        entry.refuseAny();
        return resolveEmbedder(rest, options);
    }
  },

  // The store's own account. The seam receives the SERIALIZABLE store section
  // plus the embedder resolved above, and this body is the conversion: resolve
  // the ref, narrow to what the backend speaks, then build the typed arm.
  async makeRag({ store, embedder }) {
    // Same two rules as above: the ref is destructured out so nothing spreads it
    // onward, and a ref that WAS named must resolve.
    const { credentialRef, ...address } = store;
    const entry = lookup(credentialRef, DEFAULT_STORE_REF, store.type);
    switch (address.type) {
      case 'in-memory':
        entry.refuseAny();
        // makeRag's in-memory arm requires an embedder (§4.6.3 item 4), so the
        // keyword-only store is constructed directly — an earlier version of this
        // block passed makeRag an arm without one, which does not compile
        return embedder
          ? makeRag({ ...address, embedder })
          // no namespace, as on main; preprocessors/enrichers are not YAML fields
          : new InMemoryRag({ dedupThreshold: address.dedupThreshold });
      case 'qdrant':
        return makeRag({ ...address, embedder, ...entry.optional('api-key') });
      case 'pg-vector':
        return makeRag({ ...address, embedder, ...entry.optional('secret-login') });
      case 'hana-vector':
        return makeRag({ ...address, embedder, credential: entry.require('secret-login') });
    }
  },
};

// The lookup that makes "optional" mean what it says. Optional means the ref may be
// OMITTED — never that a ref you named may fail to resolve, which is the difference
// between a deployment that chose anonymous access and one with a typo in it.
function lookup(ref: string | undefined, roleDefault: string, target: string) {
  const named = ref !== undefined;
  const key = ref ?? roleDefault;
  const entry = credentialFor(key);
  if (named && !entry) {
    throw new Error(`credentialRef '${key}' for ${target} has no entry configured`);
  }
  const wrongKind = (kind: string): never => {
    throw new Error(
      `credentialRef '${key}' must hold a ${kind} credential for ${target}, ` +
        `got ${entry?.credential?.kind ?? 'none'}`,
    );
  };
  return {
    // a target that cannot work without one
    require<K extends AnyCredential['kind']>(kind: K) {
      const c = entry?.credential;
      if (c?.kind !== kind) wrongKind(kind);
      return c as Extract<AnyCredential, { kind: K }>;
    },
    // a target that can work without one — but only when none was asked for
    optional<K extends AnyCredential['kind']>(kind: K) {
      const c = entry?.credential;
      if (!c) {
        if (named) wrongKind(kind);   // named, resolved, and empty is a misconfiguration
        return {};                    // omitted and undefined: anonymous, on purpose
      }
      if (c.kind !== kind) wrongKind(kind);   // configured wrongly is never "ignore it"
      return { credential: c as Extract<AnyCredential, { kind: K }> };
    },
    requireApiBaseUrl() {
      if (!entry?.apiBaseUrl) {
        throw new Error(`credentialRef '${key}' must carry an apiBaseUrl for ${target}`);
      }
      return entry.apiBaseUrl;
    },
    // a target that sends nothing: naming a ref for it is a mistake worth reporting
    refuseAny() {
      if (named) {
        throw new Error(`${target} takes no credential, so credentialRef '${key}' cannot apply`);
      }
    },
  };
}
```

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

`PipelineRagStoreConfig` moves the same way. `SkillPluginsConfig`'s store does **not** split — it already keeps its embedder separately and describes persistence only, so its qdrant entry just gains `credentialRef`. A keyword-only deployment writes `store: { type: in-memory }` with no `embedder:` section at all, and the seam's union accepts that arm without one.

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
```

**7. Stop reading identity from the tool context** (§5.1). A handler no longer needs to: the entries were built for one caller, so the owner keys come from the bound identity. Call sites that *pass* `sessionId`/`userId` keep compiling and can be left alone — the values simply stop being read — but code that *reads* them must change.

```ts
// before: the field was typed, and authoritative
const owner = ctx.userId;                  // string | undefined
// after: TS2339/TS2322 — there is no such declared field, and no need for one
```

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

**Not a migration, but worth knowing:** hydrating collections after a restart is new and optional (§6.3). A consumer that does not hydrate behaves exactly as today — an empty registry, and `attributes` that read back as `undefined`.

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
5. **Who writes `attributes` at creation** — tool handler, consumer, or both; and the final signatures of `IRagRegistry.createCollection` / `IRagProvider.createCollection` (§6.3). **Answered in §6.3: whoever knows the caller** — the tool handler from its `RagToolContext`, or a consumer calling `createCollection` directly — with the registry passing them through and never inventing them. What remains is the two signatures, which is plan work rather than a design question.
6. **An optional marker on authenticated clients.** A seam *may* declare that it accepts only clients a factory produced, making "forgot the caller's credentials" a compile error. It must stay opt-in: mandatory, it would dictate policy. Precedent for the risk: cloud-llm-hub PR #236 (`fix(security): stop caching MCP tool results across callers`, open) — a `ToolCache` shared by every caller returned one user's ABAP result to another within 30 s, below the role check and below their own SAP connection. **Not blocking, and deliberately not in this release:** it must stay opt-in, and an opt-in marker nobody has asked for is a contract without an acceptor (§11).
7. **`buildRagCollectionToolEntries`** — mounted by a consumer, or deleted. **Answered: it stays, and workstream 3 narrows it** (§5.1). Deleting it would hand the problem to every consumer; leaving it as written would ship five handlers that ignore the identity they are given. It gains the caller's identity at construction, the five handlers start using it, and a `role`-authorized global is refused rather than judged. That it has no consumer today (§5) is why the defect went unnoticed, not a reason to keep it.
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
2. **Credential contracts** — write them where §4.4 settles, and adopt them **in place of** the existing fields, not beside them (§4.6.2). Each **concrete** provider config declares its own `credential`, typed for what that target speaks. `apiKey` leaves `LLMProviderConfig` and `EmbedderFactoryConfig` with **nothing** replacing it in either — a shared base could only type the union, and the framework must not carry a secret between a consumer's own components. And `makeLlm`, `makeDefaultLlm`, `MakeLlmConfig`, `DefaultModelResolver` and the five dynamic-import shims **leave `llm-agent-libs` altogether**: a dispatch that restates five constructors it does not own is a variation point the consumer owns (principle 5) and glue that belongs to the assembly (principle 2) — it was also the only reason a secret ever had to sit in a framework config. `IModelResolver` itself is **unchanged** — what held a config was `DefaultModelResolver`, and it leaves because building a provider for a newly chosen model needs a credential. The rest of this workstream's scope, which an earlier draft of this line omitted: `SmartServerLlmConfig`, `PipelineLlmProviderConfig`, **`PipelineRagStoreConfig` (`pipeline.ts:32`), `SmartServerRagConfig`'s `user`/`password` (`smart-server.ts:167-168`) and `SkillPluginsConfig`'s qdrant store (`skill-plugins-config.ts:19`)** lose their secret fields and gain a non-secret `credentialRef`, staying serializable — and the two RAG shapes **split into `store` and `embedder`, each with its own ref**, because one config names two independently authenticated targets (§4.6.4) — while construction goes through `BuildAgentDeps.makeLlm` (`:360`), whose signature is unchanged but which becomes **required** (§4.6.3) — no `role` parameter is added, because its twenty call sites name roles a closed union cannot; the YAML swaps `apiKey: ${VAR}` for `credentialRef: VAR` and its loader, substitution and validation stay in `-libs`; a new `@mcp-abap-adt/sap-aicore-auth` holds `serviceKeyCredential` and `parseServiceKey`, moved with their tests; `IPipelinePlugin` loses `parseConfig` and `build`'s config parameter, the shipped plugins' dialects move to the server, and `controller`'s subagents and the DAG workers name `llm:` keys (§4.6.7); `IServerPipelineContext` loses `makeLlm`/`llmMap`/`pipelineFallback`, `IPipelineContext` gains the required strict `resolveNamedLlm(key)` beside `resolveLlm(role)` — the only two ways an LLM reaches a plugin, and every implementation and test fixture of that contract gains the member — `IRoleLlmResolver` loses `makeLlm(lc)`, and the resolver becomes scoped — deployment and per-session, disposal following the identity (§4.6.5, §4.6.6); and `llm-agent-server` becomes the composition root — env, credentials, provider dispatch, and the `IModelResolver` implementation behind `PUT /v1/config`.
3. **RAG identity and attributes** — persisted opaque `attributes` **plus the logical name beside them, the `describeCollections()` read, `openCollection()`, the `adopt()` hydration path, and catalog-record removal on delete, record-before-data **inside each provider's own `deleteCollection`** with `CatalogRecordDeleteError` when that first step fails, so nothing resurrects** (§6.3); the collection registry a caller's tools see is that caller's, per pipeline, which needs the optional **async** `ragRegistryFactory(identity): Promise<IRagRegistry>` on `SessionGraphFactoryOptions` — async because hydration happens inside it and `SessionAgentParts` has no `userId` to defer it with — plus session-owned disposal, so this workstream **does** touch the session wiring (§6.4); the two axes; the typed owner keys; the caller's identity bound into the collection tool entries as the single source, closing the five handlers that ignore the context and the one that trusts it, and refusing every mutation of a global (§5.1); a credential on each store constructor **replacing** `apiKey`/`user`/`password`, with the connection string carrying the address only. No source union and no check (§5, §6.2). Registry rewiring is **in** scope, contrary to an earlier draft of this line: the provider registry stays shared and untouched, while the session gains an optional factory for its own collection registry (§6.4).
4. **Text-logger acceptance** — `ITextLogger`, the boundary adapter and its levels (§7). Convergence to one name is deferred to the next major (§9.9).

---

## 11. Out of scope

- Writing a contract nobody is specified to accept. Decision 11 asks who calls a thing; it does not ask the acceptor to exist first, and it cannot — an acceptor in another repository cannot depend on an unpublished contract. The criterion is §4.4’s: a contract may be written once a concrete accepting change has been specified and checked against the acceptor’s actual API, and it is published before that change adopts it.
- **cloud-llm-hub's** own implementation — its per-session graph and XSUAA-backed check — is theirs.
- `llm-agent-server`'s configuration **is no longer out of scope**, and an earlier draft of this list said it was. §10 requires it to become the composition root: env resolution, credential construction, provider dispatch and the `IModelResolver` implementation behind `PUT /v1/config`. It is the reference every other consumer copies, which is principle 2's whole point.
- **Anything that judges an incoming caller.** No admission step, no access-check contract, no per-request authorization, and nothing that wraps a server (§1.4). A consumer that needs those builds them where the request actually arrives, and §5 says what we hand it to decide with.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
- **Merging DAG worker config files into the main one.** §4.6.7 moves a worker's model to a key of the main file's `llm:` map, so every model is configured in one place; the worker file keeps its prompts and its `rag:`, split like the main file's. Whether a worker needs a file of its own at all is a configuration-shape question, not an authentication one.
