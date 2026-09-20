# Authentication and authorization contracts — umbrella design

**Status:** design, revised after review round 8 · **Date:** 2026-09-16 · **Base:** `main` at `bd5c464c` (v26.0.0)

## TL;DR

- **This is a framework, not an application.** Every seam below is **offered**; a consumer may decline it and keep what it has. Nothing here decides policy on anyone's behalf.
- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **Admission is the consumer's, and none of it is ours.** Every provider here is a *client* of an outside service; a client proves who it is and judges nobody, because nothing calls it. So there is no authorization at request time anywhere in this framework and no access-check contract in it — a deliberate limit on what we build, not a gap to fill (§1.4, §5).
- **MCP lifetime and identity are today app-local glue**, written once in `llm-agent-server-libs` and differently in cloud-llm-hub. The seam moves to `SmartAgentBuilder`, where every assembly already passes.
- **Collections have two axes**: `scope` (`session`/`user`/`global`) and `authorization` (`public`/`owner`/`role`). Scope and the owner keys stay typed; only role and policy become opaque.
- **One contract per job.** `ILogger` is the counter-example we pay for today.
- **No behaviour on any existing path changes, and the version is decided at the release.** New capability arrives through new optional seams — the safer teardown order through a new hook rather than a changed one (§3.4). **What does break is source-level, and deliberate in every case:** §4.6.2 removes `apiKey` from `LLMProviderConfig` and from `EmbedderFactoryConfig`, because a contract does not carry a secret and construction is the authorization; §5.1 removes `RagToolContext`'s declared `sessionId?`/`userId?` and makes `identity` required on `buildRagCollectionToolEntries`, because an optional one would mean “do not narrow” and could be forgotten; and §7 widens six readable option properties. What version carries the set is §10’s to state, not this summary’s — it is a major, and §8 carries the migration note for each.
- Umbrella: four workstreams (§10), **one plan**, and **one PR per repository**. Two of the four are already merged; the rest land together.

---

## 1. The framework's position

`@mcp-abap-adt/llm-agent` is a framework for assembling agents and pipelines of arbitrary shape. It does not know who assembles them: `llm-agent-server` is one assembly, cloud-llm-hub is another, and the next one is unknown. **It offers capabilities and adapts to nobody.**

Three rules follow, and every section below is bound by them:

1. **Declinable.** A new seam left unused changes nothing. No credential is mandatory, no access check is mandatory, no lifetime contract is mandatory.
2. **No default policy.** Where the framework cannot know the answer, it holds no opinion — it does not invent one. An absent access check means the framework does not judge, not that it permits on someone's behalf.
3. **No privileged topology.** Per-session, shared, single-user, multi-tenant — all are assemblies, and none is the reference.
4. **We build the client side, and only it.** Every provider here — LLM, embedder, RAG store, foreign MCP — is a *client* of something outside. A client proves who it is; it does not judge who is calling it, because nothing calls it. So there is **no authorization at request time anywhere in this framework**, and nothing in it wraps a server. This is a deliberate limit on what we build rather than a gap to fill later: the assembly that faces users — cloud-llm-hub, `llm-agent-server` — is the server, and admission is its job (§5).

The framework also imports nothing from `@mcp-abap-adt/interfaces*` today and declares its own `ILogger` and `IMcpRequestHeadersStrategy`. Where that changes below, the imports are **types-only** (`import type`, so nothing enters the runtime graph) though the package is still a regular dependency, and the contracts are plain shapes with `kind` literals, so a consumer can satisfy them without importing anything.

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
| `LLMProviderConfig.apiKey?: string` (`llm-agent/src/types.ts:78`) | a string on a **framework contract**, with a comment admitting it cannot describe SAP AI Core | **removed** — a contract carries no secret (§4.6.2); the credential goes to each concrete provider's constructor |
| `EmbedderFactoryConfig.apiKey?: string` | a second key seam, and one the **framework** carries to a consumer's factory | **removed** — the factory is the consumer's code and closes over its own credential (§4.6.2) |
| `sap-aicore-llm`, `sap-aicore-embedder` | `clientId` + `clientSecret`, **or** the `AICORE_SERVICE_KEY` env fallback | `IBearerCredential` — confirmed viable, §9.2: a constructed destination's `headers.Authorization`, rebuilt per call for freshness; the `foundation-models` embedder swaps its own `TokenProvider` instead |
| `qdrant-rag` | `url` + `apiKey?: string` | `IApiKeyCredential` |
| `pg-vector-rag`, `hana-vector-rag` | `host`/`port`/`user`/`password`/`database`, **or** `connectionString` | `ISecretLoginCredential` |
| an http MCP implementation | `headers` | whatever its server speaks |

Every one of these is **optional and additive**: the credential sits beside the existing field, and a provider constructed the old way keeps working unchanged.

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

Decision 26 of `@mcp-abap-adt/interfaces` places a contract in the package that accepts it: several acceptors on the SAP side share `interfaces-adt`; contracts accepted **across families** go to `interfaces-auth`, `-network` or `-utils`.

- `AccessCheck<R>` **does not go to `interfaces-auth`.** Decision 26 named llm-agent and the hub as its two acceptors, and that was true of an earlier draft of this design. §1.4 removes llm-agent as an acceptor, which leaves one — the hub — and a single acceptor keeps its own contract (§5).
- The three credential contracts go to `interfaces-auth`, and that no longer waits on a second acceptor. `@mcp-abap-adt/connection` has not rebuilt `BasicAuthProvider`/`TokenAuthProvider` on them — it implements `IAuthProvider` and `IRenewableCredential` directly (`src/auth/providers.ts:21`, `:59`) and still depends on `@mcp-abap-adt/interfaces` ^39.0.0, the pre-split facade. That is not a reason to move the contracts: a contract is a shared vocabulary, and whoever needs an implementation writes one — this family, `connection` later if it chooses, or a consumer with a credential source neither of us anticipated. That is what strategies and injection are for, and it is why the contract must not live where only one implementation happens to live today.

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

Each was measured in the packages on 2026-09-20, not reasoned about. Two of the three turned out to be additive, which the earlier wording of this section and of §8 denied.

1. **Passwords in connection strings: additive, and nothing needs forbidding.** The worry assumed a credential has to displace the connection string. It does not, because the code that reads either one is not public. `resolvePgConnectArgs` and `resolveHanaConnectArgs` are absent from their package barrels — `index.ts` exports only the config type and the class — and both packages declare a **closed `exports` map with only `"."`**, so `dist/connection.js` ships in `files` but Node refuses the subpath. Each resolver has exactly one production caller and it is **already `async`**: `private async createDriverClient` (`pg-vector-rag.ts:62`, `hana-vector-rag.ts:54`). Awaiting `secret()` there costs no signature anyone can see, and the config interfaces gain one optional property.

   **Precedence looked like the next question and turned out to be the wrong one.** Two drafts of this item ranked the sources, because the two packages disagree with each other: in `pg`, `if (cfg.connectionString) return { connectionString, … }` is an early return, so discrete `user`/`password` are ignored outright (`connection.ts:31-37`), while in `hana` `??=` lets the connection string fill only the gaps, so the discrete fields win (`connection.ts:33-40`). A credential dropped into each would silently inherit opposite precedence from its neighbour, so a rule seemed necessary.

   **It is not, because §4.6.2 leaves one source.** Ranking is only ever needed where a config carries several, and “did this object get authorized?” should have one answer. So the discrete `user`/`password` go, the **connection string carries the address only**, and a string with credentials in it is **refused at construction** — loudly, with the `staticLogin` fix in the message — rather than silently losing to the credential. The disagreement between the two packages disappears with the fields that caused it, which is a better outcome than reconciling it.

   What the measurement above still buys: because both resolvers are internal and unreachable, and their only caller is already `async`, none of this is visible in either package's public surface beyond the config type itself.

2. **The property: there is none, because a contract does not carry a credential at all.** Two earlier drafts of this item argued about *how* to put a secret in a config — widen `apiKey` or add a field beside it, then deprecate the old one. Both answered the wrong question.

   **Construction is the authorization.** A credential is a constructor argument, and a constructor is not part of an interface. Once the object exists it is authorized, and every method on the contract is just the job — `embed(texts)`, `chat(messages)`, `query(text)` — needing no secret and nothing else auth-shaped. So the credential is read by exactly one thing, the **concrete implementation**, and read nowhere a contract can see.

   It follows that llm-agent's own contracts gain nothing and lose what they should not have had:

   | type | today | after |
   |---|---|---|
   | `LLMProviderConfig` (`llm-agent/src/types.ts:78`) | `apiKey?: string` | — nothing auth-shaped |
   | `EmbedderFactoryConfig` (`interfaces/rag.ts:20`) | `apiKey?: string` | — nothing auth-shaped |
   | a concrete provider's own config (`OpenAiEmbedder`, `QdrantRag`, …) | `apiKey: string` | `credential` — its constructor, not a contract |

   **`EmbedderFactoryConfig` is the case that proves it.** The framework passes that object *to a consumer's factory*, so today the framework carries a secret on the consumer's behalf. It never needs to: the factory is the consumer's own code and closes over whatever credential it already holds — `() => new MyEmbedder({ credential: mine })`. Removing `apiKey` from it means the framework stops handling secrets rather than handling them more politely.

   **And it removes the precedence rules instead of ranking them.** §4.6.1 had to decide whether a credential outranks a connection string and the discrete fields, and §4.6.2 whether it outranks `apiKey`. Both questions exist only while a config carries several sources; with one source, “did this object get authorized?” has one answer, checkable at construction, and there is nothing to rank. A connection string therefore carries the **address** only — a string with a password in it is refused at construction, loudly, rather than silently losing to the credential.

   **The cost, stated plainly.** Consumers pass `apiKey` today, so this is a break: in llm-agent's contracts it is a removal, and in the concrete packages it replaces the field. The release is already a major (§7), and core ships the conversion so each call site is one line:

   ```ts
   staticApiKey('sk-…')       // => IApiKeyCredential, for a key that does not rotate
   staticLogin('user', 'pw')   // => ISecretLoginCredential
   ```

   **§1.1 does not argue against this, and an earlier draft misused it to.** “A new seam left unused changes nothing” governs a new *capability*, which a consumer may decline. Authentication was never declinable — only how to express it was — so replacing the expression is a migration (§8), not an opinion imposed on anyone.

   The asymmetry with the logger stands and explains why *that* convergence still waits: llm-agent hands `ILogger` **out** through `PipelineContext` and `IPipelinePlugin`, so renaming it breaks every consumer's plugin (§7, §9.9). Nothing hands a secret out.

3. **Where the endpoint goes: it stays in the provider's own config.** An address is not a credential by this section's own rule, so `IBearerCredential` carries the token and nothing else, and the service URL keeps the home it has — `sap-aicore-llm`'s provider config (`sap-core-ai-provider.ts:29`, read at `:164`) and `sap-aicore-embedder`'s `apiBaseUrl` (`foundation-embedder.ts:8`). What changes is only that the two stop being one object: today the URL sits in the same structure as the OAuth input, and the credential replaces that input's half of it. §9.2's measurement shows the resulting shape exactly — a constructed destination `{ url, authentication: 'NoAuthentication', headers: { Authorization } }`, where `url` comes from config and the header from `token()`.

---

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
| `@mcp-abap-adt/llm-agent` | **`LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` removed** — a contract carries no secret (§4.6.2) — plus `IMcpServer` (+ `mcpServerFromFactory`); `McpClientFactory` deprecated as a consumer seam; `attributes` and the logical `collectionName` on provider collection creation, the optional `describeCollections()` catalog read, the optional `openCollection()` that builds handles for an existing store, the optional `IRagRegistry.adopt()` that registers one, the `CatalogRecordDeleteError` type and the tool that answers `{ ok: false }` to it rather than warning about data (§6.3) — the deletion itself belongs to the providers, below; the caller's identity bound into `buildRagCollectionToolEntries` and used by all seven handlers, with `RagToolContext`'s declared `sessionId?`/`userId?` removed so there is one source (§5.1); `ITextLogger` re-exported from `interfaces-utils`, **exported `ILogger` unchanged** | additive at runtime; a consumer that *reads* a widened option property must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-libs` | `withMcpServers` on the builder; start in `build()`, `stop()` into `closeFns`; optional `mcpServerFactory` on the session factory; optional `ragRegistryFactory(identity)` with session-owned disposal (§6.4) | additive at runtime; `SessionGraphFactoryOptions.logger` widened, so a consumer that *reads* it must narrow first (§7) |
| `@mcp-abap-adt/llm-agent-server-libs` | consumes the builder seam; `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` deprecated, not deleted | additive |
| `@mcp-abap-adt/llm-agent-mcp` | stdio passes its own `env`. `IMcpServer` arrives here as the generic `mcpServerFromFactory` adapter (workstream 1); the typed implementations, whose constructors demand a credential per §3.3, land with the credential contracts in workstream 2 — **http first** (the main protocol; `start()` holds a connection rather than spawning), stdio beside it for the local case | additive |
| `llm-agent-rag`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | a credential in their own constructors, replacing `apiKey`/`user`/`password`, with a connection string that carries the address only; persist `attributes` in a catalog of their own, hand them back unread through the new optional `describeCollections()`, build handles for an existing store through `openCollection()`, and **delete the catalog record before the data inside their own `deleteCollection`, raising `CatalogRecordDeleteError` and leaving the data untouched when that first step fails** — these packages own the backend catalog, so resurrection is stopped here or nowhere (§6.3). **No check is asked here** (§5) | additive — measured, not assumed (§4.6.1): the connection resolvers are absent from both barrels and unreachable through a closed `exports` map, and their only caller is already `async`. The credential outranks both the connection string and the discrete fields |
| concrete LLM and embedder providers | a credential **replacing** `apiKey?: string` in their own constructors, keeping the AI Core env fallback (§9.2) | **breaking**: the plain field is removed, `staticApiKey` converts a call site in one line (§4.6.2) |
| `@mcp-abap-adt/interfaces-auth` | gains the three credential contracts — and **not** `AccessCheck`, which has no acceptor here (§5) | minor |
| cloud-llm-hub, `llm-agent-server` | **may** adopt the seams; neither is required to | their own work |

### What each workstream needs from another repository

Read this rather than deriving it. Every row was checked against the packages, not remembered.

| workstream | needs from `mcp-abap-adt-interfaces` | package and version | state |
|---|---|---|---|
| 1. MCP lifetime and identity | nothing | — | merged (#305), unreleased |
| 2. Credential contracts | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | `interfaces-auth` 1.1.0 | not written |
| 3. RAG identity and attributes | nothing — `AccessCheck` left this design (§5) | — | not written |
| 4. Text-logger acceptance | `ILogger`, consumed unchanged | `interfaces-utils` 1.0.0, published 2026-09-16 | merged (#306), unreleased |

**`interfaces-auth` is touched once, and now by one row rather than two.** Row 3 stopped needing it when admission left the design, so what lands is the **three credential contracts** in one change and one minor release — which is, by coincidence worth noting, exactly what the paused PR #90 already contains. Releasing that package twice, each time for whatever this repository happened to need next, is the failure this table exists to prevent: it makes the contract package a servant of one consumer’s schedule rather than a vocabulary.

**Order, and it is not negotiable.** The contract is published, then adopted. An acceptor cannot merge a dependency on an unpublished version, so a plan that interleaves them describes a state that cannot exist. `interfaces-utils` in row 4 shows the easy case — the contract was already on the shelf, so that workstream needed no release at all.

**Release shape.** No existing path changes behaviour, and every seam is declinable — including the safer teardown order, which arrives as the optional `closePipeline` hook (§3.4). Two things are not declinable, both from §5.1's single-identity rule:

- **A required input.** `buildRagCollectionToolEntries` now takes an `identity`, so the old one-field call stops compiling. Deliberate, and §5.1 says why no overload without it is kept: an optional `identity?` would mean “do not narrow”, which is an unnarrowed address space reached by forgetting a field.
- **Two contract removals.** `LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` go (§4.6.2): a contract carries what an acceptor *needs*, and a plain key is one way of *obtaining* it. `staticApiKey(key)` converts a call site in one line. The concrete providers replace their own fields the same way, and a connection string that carries credentials is refused at construction rather than silently outranked.
- **A removal, measured rather than assumed.** `RagToolContext` loses its declared `sessionId?`/`userId?`. Against the repository's own tsc (6.0.3), a call site passing those keys still compiles — the type declares `[key: string]: unknown`, which absorbs them — while a *reader* of one gets `error TS2322: Type 'unknown' is not assignable to type 'string | undefined'`. That is workstream 4's read-side class (§7), and no reader exists today because nothing mounts these tools.

The deprecations — `mcpClientFactory`, `mcpClientFactoryWithDescriptors`, `buildPerSessionMcpClients`, `mcpSharedClient`, `closeBySession` — are markers for a later major, not part of this one. `McpClientFactory` is a special case: it stays as the default implementation's factory, which `mcpServerFromFactory` consumes, and is deprecated only as the **consumer-facing** seam. The version this ships as is decided at the release by what has accumulated (§10), not here: as it stands the set carries workstream 4's read-side break and §5.1's two, so it is a major.

### Migration — what a consumer on the old contract must do

Four changes need an edit, and none of them is optional — nothing here is deprecated-but-working, because §4.6.2 removes rather than deprecates. Everything *else* is declinable as usual: a consumer that leaves a new seam unused keeps today’s behaviour.

**1. Replace a plain key with a credential** (§4.6.2). `apiKey` is gone from `LLMProviderConfig`, from `EmbedderFactoryConfig` and from the concrete providers' own configs; a static key is already a credential, and core ships the conversion.

```ts
- new OpenAiEmbedder({ model: 'text-embedding-3-small', apiKey: key });
+ new OpenAiEmbedder({ model: 'text-embedding-3-small', credential: staticApiKey(key) });

- new PgVectorRagProvider({ connectionString: 'postgres://u:pw@host/db', … });
+ new PgVectorRagProvider({ connectionString: 'postgres://host/db',
+                          credential: staticLogin('u', 'pw'), … });
```

A connection string carrying credentials is now **refused at construction**, with `staticLogin` named in the message — it is not silently ignored. And a consumer's own embedder factory stops receiving `cfg.apiKey`: it closes over the credential it already holds, which is why the framework no longer carries one.

**2. Build the RAG collection tools with an identity** (§5.1). The identity is the caller the pipeline is being built for — the same one whose collections the instance may address.

```ts
// before
const entries = buildRagCollectionToolEntries({ registry });
// after
const entries = buildRagCollectionToolEntries({ registry, identity });
```

**3. Stop reading identity from the tool context** (§5.1). A handler no longer needs to: the entries were built for one caller, so the owner keys come from the bound identity. Call sites that *pass* `sessionId`/`userId` keep compiling and can be left alone — the values simply stop being read — but code that *reads* them must change.

```ts
// before: the field was typed, and authoritative
const owner = ctx.userId;                  // string | undefined
// after: TS2339/TS2322 — there is no such declared field, and no need for one
```

**4. Narrow a widened logger option before reading it** (§7). Six readable option properties accept `ILogger | ITextLogger`, so a consumer that *reads* one must narrow first; a consumer that only *passes* a logger is unaffected. The guarded form is the one that compiles — the property is optional, so `normaliseLogger(options.logger)` alone fails with `TS2345`:

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

   So `IBearerCredential` is viable for both packages, and the `AICORE_SERVICE_KEY` fallback stays as the no-credential default (§4). **One gap to plan for:** `sap-aicore-embedder`'s orchestration path constructs `new OrchestrationEmbeddingClient(config, deploymentConfig)` with only two arguments (`orchestration-embedder.ts:50`) — the destination seam exists in the SDK but is not wired on our side, so the embedder needs that thread-through, which the LLM provider already has.
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

Four independent changes under one umbrella. They are additive at runtime and a consumer may take one and decline the rest — but that is about what a *consumer* may adopt, not about how the work is cut.

**One plan, and one PR per repository.** A workstream is a decomposition of the change, not of the paperwork. Four plans releasing the contract package four times would make it the servant of whatever this repository needed next, which is the failure §8 exists to prevent; and a plan per workstream cannot describe a path start to finish, because each would stop where the next begins.

Workstreams 1 and 4 are already merged, each as its own PR, before this rule was written — that is history and is not undone. What remains is workstreams 2 and 3, and they land as **one plan** across **two PRs**: one in `mcp-abap-adt-interfaces` carrying the three credential contracts, then — after that package is published, per §8’s order — one in this repository adopting them. **What version carries them is decided once, at the release, by what has accumulated — never per workstream.** Merging a workstream publishes nothing: its entries sit under `[Unreleased]` until the set is cut. Workstream 4 widens six readable option properties, which breaks a consumer that *reads* one (§7), so the release that carries this set is a major.

1. **MCP lifetime and identity** — `IMcpServer`, `withMcpServers`, optional `mcpServerFactory`, the optional `closePipeline` hook with `stop()` last (§3.4), stdio `env`.
2. **Credential contracts** — write them where §4 settles, adopt them beside the existing fields.
3. **RAG identity and attributes** — persisted opaque `attributes` **plus the logical name beside them, the `describeCollections()` read, `openCollection()`, the `adopt()` hydration path, and catalog-record removal on delete, record-before-data **inside each provider's own `deleteCollection`** with `CatalogRecordDeleteError` when that first step fails, so nothing resurrects** (§6.3); the collection registry a caller's tools see is that caller's, per pipeline, which needs the optional **async** `ragRegistryFactory(identity): Promise<IRagRegistry>` on `SessionGraphFactoryOptions` — async because hydration happens inside it and `SessionAgentParts` has no `userId` to defer it with — plus session-owned disposal, so this workstream **does** touch the session wiring (§6.4); the two axes; the typed owner keys; the caller's identity bound into the collection tool entries as the single source, closing the five handlers that ignore the context and the one that trusts it, and refusing every mutation of a global (§5.1); optional credentials on the store constructors. No source union and no check (§5, §6.2). Registry rewiring is **in** scope, contrary to an earlier draft of this line: the provider registry stays shared and untouched, while the session gains an optional factory for its own collection registry (§6.4).
4. **Text-logger acceptance** — `ITextLogger`, the boundary adapter and its levels (§7). Convergence to one name is deferred to the next major (§9.9).

---

## 11. Out of scope

- Writing a contract nobody is specified to accept. Decision 11 asks who calls a thing; it does not ask the acceptor to exist first, and it cannot — an acceptor in another repository cannot depend on an unpublished contract. The criterion is §4.4’s: a contract may be written once a concrete accepting change has been specified and checked against the acceptor’s actual API, and it is published before that change adopts it.
- Any consumer's implementation: cloud-llm-hub's per-session graph and XSUAA-backed check, and `llm-agent-server`'s configuration, are theirs.
- **Anything that judges an incoming caller.** No admission step, no access-check contract, no per-request authorization, and nothing that wraps a server (§1.4). A consumer that needs those builds them where the request actually arrives, and §5 says what we hand it to decide with.
- llm-agent issue #304 (network-mode isolation), which this design is the prerequisite for.
