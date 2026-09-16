# Authentication and authorization contracts

**Status:** design, for review · **Date:** 2026-09-16 · **Base:** `main` at `8ef2c270` (v26.0.0)

## TL;DR

- **Two jobs, never one.** Proving who *we* are to an outside service (a credential) and deciding what *the caller* may do (admission) are different contracts in different places.
- **MCP splits in two:** `IMcpClient` (use — unchanged) and a new `IMcpServer` (`start`/`stop`). Starting is a job; using is another.
- **Admission lives in the per-consumer MCP server instance**, built with the caller's identity. llm-agent gains no word for "role" or "permission".
- **A RAG provider's credential is for reaching the store**, not for judging the caller. Whether the store sees *us* or *the caller* becomes a typed choice: `service` or `delegated`.
- **One contract per job.** `ILogger` is the counter-example we already pay for: two contracts for one job, and the hub writes adapters.
- Nothing here is written until a package accepts it (decision 11 of `@mcp-abap-adt/interfaces`).

---

## 1. Why this exists

`@mcp-abap-adt/llm-agent` imports nothing from the `@mcp-abap-adt/interfaces*` packages today and declares its own `ILogger` and `IMcpRequestHeadersStrategy`. That was defensible while those contracts lived in one package that took 41 majors, almost all of them ADT. Since the split (`interfaces-utils`/`-network`/`-auth`/`-adt` 1.0.0, `interfaces` 45.0.0 a deprecated facade) a contract can be shared without inheriting anyone's release cadence.

What this spec does **not** do: put authorization policy into llm-agent. Auth remains the consumer's job. This adds the seams through which a consumer supplies it, and removes the places where the library quietly decides on the consumer's behalf.

---

## 2. The two jobs

| job | question it answers | contract | where it lives |
|---|---|---|---|
| **A — prove who we are** | how do we authenticate to OpenAI / AI Core / Qdrant / PostgreSQL / HANA / a foreign MCP server? | `IApiKeyCredential`, `IBearerCredential`, `ISecretLoginCredential` | the constructor of the concrete provider or server implementation |
| **B — decide what the caller may do** | may *this* consumer call that tool, read that collection, delete it? | an authorization object held by the instance | the per-consumer MCP server instance, built with the caller's identity |

**Data isolation is not a third job.** "The caller must not see a foreign collection" is job B's decision, enforced a second time further down (§6). A second decision-maker means two places with rules.

---

## 3. MCP: starting and using are two contracts

### 3.1 The contracts

```ts
// use — unchanged, already in @mcp-abap-adt/llm-agent
interface IMcpClient { /* listTools, callTool, … */ }

// start and own — new
interface IMcpServer {
  start(): Promise<IMcpClient>;
  stop(): Promise<void>;
}
```

One implementation per way of starting: **stdio** spawns a child process; **http** starts nothing and connects; **embedded** runs in-process (cloud-llm-hub's `EmbeddableMcpServer`). A wrapper for a particular MCP is just an implementation of `IMcpServer` — that is what makes llm-agent able to work with any MCP without naming one.

Each implementation demands in **its own constructor** exactly the credential its target needs: an ABAP MCP over http asks for `ISecretLoginCredential | IBearerCredential`, a Jira MCP asks for `IApiKeyCredential`, a public server asks for nothing. The compiler therefore answers "must I pass something to create this?" without any generic machinery in the shared contract.

### 3.2 Why `stop()` is in the contract

A stdio server is a child process. Today nothing kills it: `SessionGraphFactoryOptions.mcpClientFactory` returns clients and says nothing about lifetime, and the session factory's `onDispose` has no handle on the process. Per-session stdio servers therefore leak processes. `IMcpServer` owns what it started, and the session factory stops each on dispose.

### 3.3 The per-session seam

```ts
// replaces mcpClientFactory
readonly mcpServerFactory: (identity: SessionGraphIdentity) => IMcpServer[];
```

The session factory starts them, hands the clients to the agent (`SessionAgentParts.mcpClients`, unchanged), and stops them on dispose. `PipelineContext.mcpClients` is unchanged: the pipeline uses injected clients and knows nothing about authentication.

`McpClientDescriptor` (`slotIndex`, `label?`) stays positional. Wrappers are adapters for starting, not filters over the client list, so array positions remain the assembler's to keep stable.

### 3.4 stdio credentials: a gap this closes

```ts
// packages/llm-agent-mcp/src/client.ts, today
new StdioClientTransport({ command: this.config.command, args: this.config.args || [] });
```

No `env`, no `cwd`. The MCP SDK then uses `getDefaultEnvironment()` — a sanitized subset of the **host's** environment. So every child of every session sees the same environment, and per-consumer credentials for a stdio MCP are impossible. The stdio implementation of `IMcpServer` passes its own `env` (never `args`, which are visible in `ps`).

### 3.5 What `McpConnectionConfig` becomes

`McpConnectionConfig` (`type`, `url`, `command`, `args`, `headers`, `requestHeadersStrategy`, `timeout`) stops being the contract and becomes the configuration of the *default* implementation. `IMcpRequestHeadersStrategy` survives as what its own docstring already says it is — extra headers, e.g. a "willing to wait longer" hint — not as the authentication seam.

---

## 4. Credentials name the protocol the accepting side speaks

Unchanged from `mcp-abap-adt-interfaces/docs/superpowers/specs/2026-09-16-credential-contracts-design.md`: `IApiKeyCredential { kind: 'api-key'; secret() }`, `IBearerCredential { kind: 'bearer'; token() }`, `ISecretLoginCredential { kind: 'secret-login'; principal; secret() }`. A contract never says whether the secret is a static password, a rotated key or a fresh token; that is the implementation behind it.

Where they land in this monorepo, and what each seam holds today:

| seam | today | contract |
|---|---|---|
| `LLMProviderConfig.apiKey?: string` (openai, anthropic, deepseek, ollama) | a string, with a comment admitting it cannot describe SAP AI Core | `IApiKeyCredential` |
| `sap-aicore-llm` / `sap-aicore-embedder` | `clientId` + `clientSecret`, exchange inside | `IBearerCredential` |
| `qdrant-rag` | `url` + `apiKey?: string` | `IApiKeyCredential` |
| `pg-vector-rag`, `hana-vector-rag` | `host`/`port`/`user`/`password`/`database` | `ISecretLoginCredential` |
| an http MCP server implementation | `headers` | whichever its server speaks |

**The `kind` literal is what makes the check real.** Without it `IApiKeyCredential` and `IBearerCredential` are structurally identical — "something that returns a string" — and TypeScript would substitute one for the other silently.

---

## 5. Admission lives in the per-consumer instance

Every consumer of an MCP server gets its own instance, and the authorization object goes in **at construction**. The instance knows who is asking because it was built for them; it never reads ambient request context.

That last clause is the point. cloud-llm-hub shows both patterns side by side today:

- ABAP tools: `assertToolAllowed(toolName, toolExposition, allowed)` — deny by default, with the caller's roles read from request options *or* from an async-local store, because "the pipeline runs tool selection twice per request and the second pass rebuilds its own options".
- RAG collection tools: a module-level `dispatchRagTool(registry, name, body)` that derives identity per call from `cds.context?.user?.id ?? 'anonymous'`.

An instance built with identity needs neither the async-local fallback nor the `?? 'anonymous'` default: there is no call path that reaches it without a caller.

**Consequence for the hub.** RAG collection tools move off the external `body.tools` channel into a per-session embedded MCP server, wired as a pipeline step the way the ABAP MCP already is. The external channel is reserved for tools the **client** brings. (This supersedes the earlier decision that RAG editing tools belong to the external channel.)

**What llm-agent contributes:** `buildRagCollectionToolEntries({ registry })` already hands back entries whose handler takes a `RagToolContext { sessionId?, userId? }`. It has no consumer today. Either the hub mounts these entries in its per-session server, or llm-agent drops them — shipping tools nobody mounts is how a second policy gets written by accident.

---

## 6. RAG: whom does the store see?

### 6.1 The choice, made explicit

A credential on a RAG provider proves who **we** are to the store. It says nothing about the caller. Whether the store can judge the caller at all depends on a separate decision — and both modes are needed:

```ts
interface ISharedRagProviderSource {
  readonly identityMode: 'service';
  create(): IRagProvider;                                   // one instance for everyone
}
interface IPerIdentityRagProviderSource {
  readonly identityMode: 'delegated';
  createFor(identity: SessionGraphIdentity): IRagProvider;  // one instance per identity
}
type RagProviderSource = ISharedRagProviderSource | IPerIdentityRagProviderSource;
```

The mode decides **who must filter**:

- `service` — the store sees our service account and cannot tell one caller from another. The instance's filter is the **only** line of defence.
- `delegated` — the caller's identity reaches the store, which enforces on its own. Our filter becomes the **second** line, and a bug in our code stops being a leak.

A seam that requires delegation declares `IPerIdentityRagProviderSource` and will not accept a shared source: a compile error rather than a silent downgrade to the service identity. Qdrant may stay `service` while HANA is `delegated`, in the same system.

Today the choice cannot even be expressed: `mcpClientFactory` is per identity, but `SessionGraphFactoryOptions.ragRegistry` is one registry for the whole factory.

### 6.2 What the store sees today

| store | today | to see the caller instead |
|---|---|---|
| PostgreSQL | the service user of a shared `pg.Pool` | a connection per identity, or `SET LOCAL` inside a transaction with RLS policies that read it |
| HANA | the `uid`/`pwd` from configuration | the caller's JWT — HANA supports JWT/SAML/X.509; **which connection properties carry them is unverified** |
| Qdrant | the holder of one `api-key` | a token whose claims restrict what it may read; our client sends only `api-key` today — **unverified** |
| OpenAI, Anthropic, AI Core | the service, always | impossible: our users do not exist there |

### 6.3 Collection attributes stay opaque to the provider

A provider must not depend on whether identity is `scope`/`sessionId`/`userId` or something we have not thought of. So the attributes it stores and hands back are opaque to it:

```ts
interface ICollectionAccess {
  allows(action: 'read' | 'write' | 'create' | 'delete', attributes: unknown): Promise<boolean>;
}
```

The provider persists the blob it was given at creation and passes it back; only the authorization object interprets it. Two things follow:

1. **Attributes must be persisted.** `IRagProvider.createCollection(name, { scope, sessionId?, userId? })` receives them today and stores them nowhere: pg and qdrant use them only for `checkScope` and the id strategy. A provider that keeps nothing cannot decide anything after a restart or in a second instance.
2. **`scope` splits.** It currently carries two unrelated things: lifetime (a provider genuinely cannot make an in-memory collection outlive a session — `supportedScopes` exists for that) and ownership (not the provider's business). Lifetime stays in the provider's vocabulary; ownership moves into the blob.

### 6.4 The fourth scope

`RagCollectionScope` is `'session' | 'user' | 'global'` — there is no `'role'`, and a role cannot be encoded in an owner string. The four-level model the hub needs (session, user, role, global; reads for the pipeline, writes through MCP with ownership and role checks) requires it.

---

## 7. One job, one contract: the logger

`@mcp-abap-adt/llm-agent` declares `ILogger { log(event: LogEvent) }` (a closed union of 10 event kinds); `@mcp-abap-adt/interfaces-utils` declares `ILogger { info/warn/error/debug(message, meta?) }`. Same job — record what happened — two contracts, and cloud-llm-hub pays for it in code that exists today:

```ts
// srv/lib/errorUtils.ts
logger: ILogger | { error: (message: string, meta?: unknown) => void }
// srv/connections/BtpOnPremDestinationConnection.ts
// ILogger doesn't include csrfToken and tlsConfig, so we use loggerAdapter from lib/logger
```

**Direction of convergence:** llm-agent adopts `@mcp-abap-adt/interfaces-utils`'s `ILogger` and keeps `LogEvent` as the payload it passes in `meta`. The text shape is the general one — a structured event fits in `meta`, while a closed union cannot carry arbitrary text. `interfaces-utils` needs no change; the major is llm-agent's, because its ~22 files of implementers and consumers change shape.

---

## 8. What changes, and where

| package | change | breaking |
|---|---|---|
| `@mcp-abap-adt/llm-agent` | `IMcpServer`; `mcpServerFactory` replaces `mcpClientFactory`; `RagProviderSource` union; `'role'` scope; opaque collection attributes; `ILogger` re-exported from `interfaces-utils` | yes — one major |
| `@mcp-abap-adt/llm-agent-mcp` | stdio implementation passes its own `env`; `IMcpServer` implementations for stdio/http | yes |
| `@mcp-abap-adt/llm-agent-rag`, `qdrant-rag`, `pg-vector-rag`, `hana-vector-rag` | credentials in constructors; persist the opaque attribute blob; honour `ICollectionAccess` | yes |
| LLM and embedder providers | credential contracts replace `apiKey?: string` | yes |
| `@mcp-abap-adt/interfaces-auth` | gains the credential contracts and `AccessCheck` **only if** a second family accepts them (§9.1) | minor if so |
| cloud-llm-hub | per-session MCP server for collection tools; supplies `mcpServerFactory`, the authorization object and credentials | its own work |

---

## 9. Open questions

1. **Where the credential contracts live.** Every acceptor today is in this monorepo, which by the placement rule makes `@mcp-abap-adt/llm-agent` their home. They belong in `@mcp-abap-adt/interfaces-auth` only if a second family accepts them — the live candidate is `@mcp-abap-adt/connection` rebuilding `BasicAuthProvider`/`TokenAuthProvider` on them. Decide before writing: moving a contract between packages later is a major for both.
2. **HANA and Qdrant delegation.** Which `@sap/hana-client` connection properties carry a JWT; whether our Qdrant version supports claim-restricted tokens. Both are marked unverified in §6.2.
3. **PostgreSQL identity.** A pool per identity, or one pool with `SET LOCAL` and RLS. The second scales; the first is simpler and honest about who is connected.
4. **A marker on authenticated clients.** Should `mcpServerFactory`'s clients carry a type a hand-built client cannot fake, so a pipeline seam can refuse an unauthenticated one? The cost is that test doubles must state it; the benefit is that "forgot the user's credentials" becomes a compile error. Precedent for the risk: the shared tool-result cache that leaked across callers had the right type and the wrong behaviour.
5. **`buildRagCollectionToolEntries`.** Mounted by the hub's per-session server, or deleted from llm-agent.
6. **The server's YAML `mcp:` block.** Injection already outranks it. Keep it for the standalone CLI, or drop it so nothing in the library builds an MCP client from configuration.
7. **Role-scoped collection naming.** `storeNameFor` derives a store name from scope and owner; a role scope needs a rule that a role rename does not orphan data.

---

## 10. Out of scope

- Writing any of these contracts before a package accepts one (decision 11).
- cloud-llm-hub's implementation: the per-session graph, its XSUAA-backed authorization object, and the four collection levels are its own spec.
- Releasing anything in `@mcp-abap-adt/interfaces*`: nothing there changes until question 1 is answered.
- The llm-agent network-mode isolation issue (#304), which this design is the prerequisite for, not a replacement of.
