# @mcp-abap-adt/llm-agent

## Unreleased

`IDecisionModel` and its request/answer/error types (`DecisionError`, `DecisionErrorCode`); `LlmComponent` gains `'decision'` and `'rerank'` — an exhaustive `switch` over it, or a `Record<LlmComponent, …>`, must add both. `IRetrievalStrategy` (how one store turns a query into its top-k) and the optional `IRagDecorator { inner }` capability with `isRagDecorator`; `FallbackRag` implements `IRagDecorator`.

**Added:** `isCallerCancellation(signal)`; `CircuitBreakerLlm.inner` (read-only, the wrapped LLM — lets a composer put retry under the breaker on the same breaker). **Fixed:** `CircuitBreakerLlm` and `CircuitBreakerEmbedder` record neither failure nor success for a call whose signal the caller aborted with a non-`TimeoutError` reason (a timeout still counts); `FallbackRag.breaker` exposes its breaker read-only.

## 30.0.0

**BREAKING — see docs/MIGRATION-v30.md.** Embedders have two roles told apart by method name: `IDocumentEmbedder.embedDocument` (text written into a store) and `IQueryEmbedder.embedQuery` (text a store is searched with), `IRetrievalEmbedder` for both. Stores, collection providers and `makeRag` take an `IRetrievalEmbedder`; search paths (`QueryEmbedding`, `withEmbedder`, `SmartAgentDeps.embedder`) an `IQueryEmbedder` — give a provider's `IEmbedder` its roles with `symmetricEmbedder(e)` or `asymmetricEmbedder({ document, query })`. Asymmetric SAP AI Core models (`nvidia--llama-3.2-nv-embedqa-1b`) via `SapAiCoreEmbedder.inputType` and `rag.embedder.asymmetric` / `skillPlugins.embedder.asymmetric`. `llm.resourceGroup` now reaches SAP AI Core (refused on other providers). Examples move from the retired `anthropic--claude-3-haiku` to `anthropic--claude-4.5-haiku`.

## 29.0.0

**BREAKING.** Sampling knobs a config does not set are no longer sent: `SmartServer` no longer defaults `temperature` to 0.7 (main) / 0.1 (classifier, helper), and the SAP AI Core, OpenAI, DeepSeek, Ollama and Anthropic providers no longer invent `temperature` (or, except Anthropic, whose API requires it, `max_tokens`) — the model applies its own default, so `gpt-5*`, `o1`/`o3`/`o4-mini` and `claude-opus-4-7`/`4-8`, which accept only temperature 1, now work. `@mcp-abap-adt/llm-agent-server` ships only the `llm-agent` command; `llm-agent-check` and `claude-via-agent` are repository tools (`npm run models:check`, `npm run claude:via-agent`). `@mcp-abap-adt/sap-aicore-llm`: the model catalog is queried with the configured credential, `getEmbeddingModels()` matches the catalog's `embedding` capability, and errors carry AI Core's reason. See docs/MIGRATION-v29.md.

## 28.0.0

**BREAKING (install contract only — no API change).** Every `@mcp-abap-adt/*` package this library uses — ours (`llm-agent`, `llm-agent-mcp`, …) and the shared `interfaces-auth` (`^2.1.0`) / `interfaces-utils` (`^1.1.0`) — is now a **peer dependency**, with the same range in every package, so a consumer's install holds exactly one copy of each. A version outside the range fails the install with `ERESOLVE` instead of nesting a second copy. `@mcp-abap-adt/llm-agent-server` (the binary) keeps them as regular dependencies. Also includes the minor/patch dependency updates of #311 (`@sap/hana-client` 2.30, `zod` 4.6, `@sap-ai-sdk/*` 2.16, `yaml` 2.9.1, `@modelcontextprotocol/sdk` 1.30.1; published ranges raised accordingly) and the dev tooling of #309. 27.0.2 was tagged but never published; its change is part of this release. See docs/MIGRATION-v28.md.

## 27.0.1

Node 26 is supported and now tested in CI alongside 22 and 24 (#312). No code changes.

## 27.0.0

Credentials leave every contract; RAG collections get an identity; every store honours the session, user, namespace and TTL filters (#308). Breaking — see [docs/MIGRATION-v27.md](https://github.com/fr0ster/llm-agent/blob/main/docs/MIGRATION-v27.md).

**Changed:** `WeightedFusionStrategy` (the `VectorRag` default) normalises BM25 per query — divided
by the best BM25 score among the candidates — before weighting, so both parts are in [0, 1] and
`vectorWeight` / `keywordWeight` are the real shares (the best keyword match contributes exactly
`keywordWeight`). It used a fixed `min(bm25 / 5, 1)`, which saturated: strong keyword matches tied.
`RrfStrategy` and `Bm25OnlyStrategy` now rank by the raw BM25 score for the same reason;
`Bm25OnlyStrategy` still reports `min(bm25 / 5, 1)` as the score. No strategy or config field is
removed. Tool-retrieval eval (`scripts/rag-eval`), recall@5 / MRR, before → after:
Ollama `nomic-embed-text` 100% / 0.900 → 100% / 0.983; SAP AI Core `text-embedding-3-small`
100% / 0.950 → 100% / 0.983 (keyword-only unaffected, 0.869). The default stays weighted fusion:
`RrfStrategy` on the same configs scored 90.0% / 0.843 (Ollama) and 100% / 0.958 (AI Core).

**Changed:** `InMemoryRag` and `VectorRag` (its BM25 part) share one keyword tokenizer, for
records and queries alike, that splits identifiers: camelCase / PascalCase (an acronym run ends
before the next word, `GetXMLParser` → get, xml, parser) and snake_case become their parts, and the
whole identifier is kept too. Before, `ReadFunctionInclude` was one token and the query "function
include" did not match it. No suffix normalisation: a plural / `-ing` / `-ed` rule was measured
and lowered MRR on the keyword-only and Ollama configs. Tool-retrieval eval (`scripts/rag-eval`, 63
tools, 30 queries), recall@5 / MRR before → after: keyword-only 93.3% / 0.828 → 93.3% / 0.869;
Ollama `nomic-embed-text` 96.7% / 0.883 → 100% / 0.900; SAP AI Core `text-embedding-3-small`
96.7% / 0.900 → 100% / 0.950.

**Fixed:** `InMemoryRag` and `VectorRag` no longer merge records with different ids. Similarity
dedup (`dedupThreshold`, default 0.92) folded any near-identical record into an existing one
whatever its `metadata.id` — the tool record `ReadFunctionInclude` was overwritten by
`ReadFunctionGroup` and vanished from the catalog. A record with an id is now replaced only by a
write with the same id; similarity dedup applies only between records written without an id.
`ToolCatalogStatus.vectorized` is documented as distinct records, and `failed` as including a tool
whose record a later write to the same id replaced.

**Security:** `InMemoryRag` honours `ragFilter.namespace`. It filtered on its own configured
namespace only and ignored the query's, so a namespace-scoped query returned records of every
namespace; `VectorRag` and `QdrantRag` already honoured it. The conformance kit
(`@mcp-abap-adt/llm-agent/testing/rag-filter-conformance`) gains five cases —
`ragFilter.namespace` (records without a namespace excluded; none set → all namespaces), expiry by
a past `metadata.ttl` (epoch seconds; no `ttl` never expires), both before top-k, and all filters
combined — and every shipped store now runs the whole kit in its unit tests.

**Security:** `VectorRag`'s keyword ranking no longer spans every session. BM25 document
frequency, document count and average length came from one index over the whole store, so a
session's scores changed when another session added records — and so leaked a signal about them.
The built-in strategies (`WeightedFusionStrategy`, `RrfStrategy`, `Bm25OnlyStrategy`,
`CompositeStrategy`) now compute these statistics from the candidates they score, i.e. the
records that passed the namespace / TTL / session / user filters; `ISearchContext.index` is now
documented as, and built by `VectorRag` as, an index over those candidates only (for custom
strategies). `VectorRag` no longer maintains a store-wide index.

**Security (BREAKING):** every `IRag` store honours the identity scope of a query.
`IRag.query` now documents it as a contract: `ragFilter.sessionId` returns only records whose
`metadata.sessionId` equals it, `ragFilter.userId` the same for `metadata.userId`, both set →
both match; a record without the filtered key is excluded; the filter applies before top-k, so a
scoped query still returns up to `k` of its own records. `VectorRag` (and `OllamaRag`, which
extends it) ignored both keys and returned every session's records — the default pipeline queries
the shared `history` store with `scope: 'session'`, so one user's history summaries could reach
another user's context. `InMemoryRag` honoured `sessionId` only and now honours `userId` too.
New: `ragIdentityFilter(options)` / `matchesRagIdentity(metadata, filter)` (the predicate), and
the `@mcp-abap-adt/llm-agent/testing/rag-filter-conformance` subpath — `ragFilterConformanceCases`
plus a deterministic `conformanceEmbedder()` — to check any store, a custom one included.
Migration: a consumer that relied on a scoped query returning records without `sessionId` /
`userId` must tag those records with their owner, or query without the scope.

**BREAKING:** `BaseLLMProvider.validateConfig()` is removed. It refused a config with
no `apiKey`; with no credential field left on the base it had become an empty body,
kept only for the `openai-llm` and `anthropic-llm` constructors that still called it.
A subclass that called `this.validateConfig()` deletes the call — each provider's
required `credential` is now checked by its own type.

**BREAKING:** `LLMProviderConfig.apiKey` and `EmbedderFactoryConfig.apiKey` are removed — a
contract carries no secret. `staticApiKey(secret)` and `staticLogin(principal, secret)` are new and
convert a call site in one line. A 429 gate's quota bucket now keys on the credential object's
identity, so one account is one bucket however many providers share it. Migration: see
docs/MIGRATION-v27.md item 1.

**BREAKING:** `buildRagCollectionToolEntries` requires `identity: RagCallerIdentity`
and resolves every collection inside that caller's address space (its own
collections and the globals); `RagToolContext` no longer declares
`sessionId`/`userId` (call sites passing them still compile, nothing reads
them); the tools that take a collection name take an optional `scope`, and a
name several scopes hold answers `RAG_AMBIGUOUS_COLLECTION`; no framework
tool writes or deletes a global, and `rag_create_collection` accepts
`session | user` only; the attributes of a tool-created collection come from
the optional `attributesFor` callback, never from the model;
`rag_delete_collection` answers `{ ok: false }` for `CatalogRecordDeleteError`, and
`{ ok: false, code: 'RAG_DELETE_UNSUPPORTED' }` for `DeleteUnsupportedError` (its provider is not
registered or cannot delete, so its record was never touched) instead of `ok: true` with a warning.
New exported types `RagCallerIdentity`, `RagCollectionToolOptions`.

`SimpleRagRegistry.replaceRag(name, scope, rag)` swaps an entry's store
handle in place, keeping its editor, provider name, store name and meta —
the operation a decorator (such as the builder's circuit-breaker wrap) needs
to swap the handle without losing what makes a hydrated collection
deletable; `false` when the entry is absent, never re-inserting.

`SimpleRagRegistry.adopt(record, rag, editor?, providerName?)` registers a
store that exists under its logical name and keeps its store name, creating
nothing; with `providerName` a later delete reaches that provider, without it
the entry is a reference; it throws `InvalidOwnerError`,
`ReservedCollectionNameError` or `DuplicateCollectionError`.

**BREAKING:** a collection that exists is no longer reattached by creating it
again — the provider refuses it (`DuplicateCollectionError` / `OrphanStoreError`)
and hydration (`describeCollections` returning each `RagCollectionRecord`,
`openCollection`, `adopt`) is the way back after a restart; a creation during a running deletion of the same
(scope, name) is refused with `DuplicateCollectionError` instead of waiting
for it; on `CatalogRecordDeleteError` the registry re-registers the entry, so
the same delete or `closeSession` can be retried; `createCollection` forwards
`attributes` to the provider only when given, and `adoptExisting` only when
`true`.

**BREAKING:** both `createCollection` inputs take `RagCollectionOwner` — the
scope with the key it selects — instead of `scope` beside optional
`sessionId`/`userId`, so a `user` or `session` owner without its key is a
build error, and at runtime `RAG_INVALID_OWNER`; `attributes?: RagJsonValue`
and `adoptExisting?` are accepted by both and NaN/±Infinity/cycles are
refused with `RAG_INVALID_ATTRIBUTES` before anything is created;
`IRagProvider` gains optional `describeCollections` and `openCollection`,
`IRagRegistry` optional `adopt(record, rag, editor?, providerName?)`; new
exported errors (`InvalidOwnerError`, `InvalidAttributesError`,
`DuplicateCollectionError`, `OrphanStoreError`, `AmbiguousCollectionError`,
`CatalogRecordDeleteError`, `ReservedCollectionNameError`) and the catalog
validators.

**BREAKING:** `SimpleRagRegistry` is keyed by scope and name, so one name may
be held once per scope; `get`, `getEditor`, `unregister` and
`deleteCollection` take an optional `scope`, and a name several scopes hold
without one fails with `AmbiguousCollectionError` (`RAG_AMBIGUOUS_COLLECTION`)
— thrown by the three synchronous ones, returned by `deleteCollection`; an
`IRagRegistry` implementation must accept that `scope`; `register` throws
`DuplicateCollectionError` (a `RagError`) instead of a plain `Error`, and
refuses a global named `user/…` or `session/…` with
`ReservedCollectionNameError` (`RAG_RESERVED_COLLECTION_NAME`), which
`createCollection` returns too; `closeSession` deletes with
`scope: 'session'`; new export `ragStoreKey`.

**BREAKING:** `IPipelinePlugin` is `name` + `build(ctx)`: it loses `parseConfig`
and `build`'s config parameter. A plugin reads no configuration — whoever
assembles the pipeline parses its section and constructs it with typed
settings. A plugin with settings is exported through
`PluginExports.pipelinePluginFactories`, whose factory takes the raw section
and constructs itself.

**BREAKING:** `IPipelineContext` gains the required `resolveNamedLlm(key)` — a
strict lookup that answers only from an `llm:` entry of exactly that name — so
every implementation must add it.

Deprecated: `McpClientFactory` as a consumer-facing seam — pass an `IMcpServer`
(`HttpMcpServer`, `StdioMcpServer`, `mcpServerFromFactory`) to `withMcpServers`. The type
stays as the default implementation's factory.

Added `PipelinePluginFactory` — builds a pipeline plugin from its `pipeline.config`
section, for a plugin with settings. `PluginExports.pipelinePluginFactories` and
`LoadedPlugins.pipelinePluginFactories?` carry it alongside `pipelinePlugins`;
both are additive.

## 26.0.0

A deleted RAG collection is gone, whatever happens to its data (#301).

`SimpleRagRegistry.deleteCollection` unregisters first and deletes the data
after; a failure comes back with the collection already unregistered.
`closeSession` goes through every collection of the session. A provider
receives a store name of the collection's owner — the sanitized collection name
plus `_<12 hex>` over scope, owner and name, at most 63 characters — so another
session or user never opens what a deletion left, and a store name is released
only when its deletion has finished. Breaking: see the root CHANGELOG for
migration.

## 25.0.0

The deadline reaches the transport (#296).

### Changed

- **`BaseAgentLlmBridge` declares `signal`** on both call shapes, so an adapter
  can carry the caller's deadline down to the provider instead of racing the
  promise around it.

## 24.1.0

The deadline 24.0.0 promised (#294).

24.0.0 removed the wait budget because a deadline belongs to whoever knows who
is waiting, and pointed at `AbortSignal` as the replacement — which was not
wired. `LLMCallOptions` now carries `signal`, and every provider honours it on
both the chat and the streaming path: it bounds the wait for a server's
throttling and the request itself, so an abort ends the call rather than only
the part that had not started.

## 24.0.0

The library establishes facts about throttling and decides nothing (#289, #290, #291).

23.0.0 gave the throttle policy a wait budget in milliseconds — a timeout by
another name, set by the one party that cannot see who is waiting at the other
end. It is gone, along with the computed backoff and the attempt cap beside the
strategy. `whenThrottled` is now the strategy itself, and nothing waits unless a
consumer says so.

Also: trace files are no longer world readable, a failed streaming call finally
writes a trace, and `setThrottleObserver` makes throttling visible in every
provider rather than one.

## 23.0.0

Throttle handling, named for what it does and always on (#285, #286).

`rateLimit` is now `whenThrottled`. The old name read as a limit we impose; it
is the opposite — the rules for what we do when a server limits us. The `enabled`
switch is gone, because sending another request into a quota the server has just
closed is never the better answer. A consumer needing different mechanics
supplies an `IThrottleStrategy`.

The policy 22.2.0 announced is also, finally, reachable: `makeLlm` and the
server config forward it, in the named-map form as well.

## 22.2.0

Rate-limit handling for every LLM provider (#282, #283).

HTTP 429 is now answered where the response is still intact — inside the
provider — following what SAP AI Core documents under Rate Limit Management:
no immediate retry, exponential backoff with full jitter, `Retry-After` honoured
when the server sends one, and a cap on both retries and total waiting
(5 attempts or 60 seconds by default).

The pause is held per quota, not per request: one caller's 429 pauses every
other caller on the same account, endpoint and model, so a limit that should
last one window does not last several.

## 22.1.0

Dependency release — minor rather than patch because the declared floors of the
runtime dependencies move up, so consumers resolve new minimums. No API change,
no behaviour change.

See [CHANGELOG](https://github.com/fr0ster/llm-agent/blob/main/CHANGELOG.md) for
the full table.

## 22.0.1

Housekeeping release — **this package is content-identical to 22.0.0**.

Two transitive advisories (`fast-uri` HIGH, `qs` MODERATE, both under
`@modelcontextprotocol/sdk`) were cleared in the monorepo's lockfile, which is
not published, so nothing here changed. A clean install of 22.0.0 from the
registry already resolved to the patched versions and audited clean. Upgrading
is optional.

See [CHANGELOG](https://github.com/fr0ster/llm-agent/blob/main/CHANGELOG.md).

## 22.0.0

The GPL base text that ships with this package is renamed `COPYING` →
`GPL-3.0.txt`. Same text, same requirement — only the filename changed, so that
GitHub stops reporting the repository as GPL-3.0 when it finds two
licensee-scanned files. This package remains **`LGPL-3.0-only`**, and still
ships both texts: `LICENSE` (LGPLv3) and `GPL-3.0.txt` (GPLv3).

No API change. See [docs/LICENSING.md](https://github.com/fr0ster/llm-agent/blob/main/docs/LICENSING.md).

## 21.0.0

**BREAKING (licence): relicensed from MIT to `LGPL-3.0-only`.**

Major for the licence, not for the code — there is no API break in this
release: no removed export, no changed signature, no config migration.
Upgrading from 20.9.5 is a drop-in code change; whether you *may* upgrade is
a licensing question.

- Both required texts now ship with this package: `LICENSE` (LGPLv3) and
  `COPYING` (GPLv3). Both are needed — the LGPL is a set of additional
  permissions layered on the GPL and cannot be read alone.
- **Not retroactive.** Everything published up to and including v20.9.5 was
  released under MIT and stays MIT under those terms.
- **Consumer impact is limited.** Importing this package, or talking to
  `llm-agent` over HTTP, does not place your program under the LGPL. The
  licence asks that modifications *to these libraries* stay free and that your
  users can substitute their own build.

See the root CHANGELOG for the full release notes, including the README and
documentation rewrite that ships alongside.

## 20.9.5

### Security

- **All Dependabot advisories cleared — `npm audit` reports 0 vulnerabilities (PR #270).**
  The 23 raw GitHub alerts deduped to 8 real advisories against the installed tree
  (4 high / 3 moderate / 1 low), all resolved with no breaking direct-dependency upgrade (one SDK-internal transitive major update, `@hono/node-server` 1.19.14 -> 2.1.0). Transitive advisories
  were resolved in the lockfile (`fast-uri` 3.1.5, `ip-address` 10.4.0,
  `brace-expansion` 5.0.9, `hono` 4.13.1, `@hono/node-server` 2.1.0,
  `body-parser` 2.3.0 — all arriving via the MCP SDK / hono, none imported by our
  source). The two **direct** dependencies also had their manifest floors raised to
  the patched versions so fresh downstream installs are protected, not only this
  repo's lockfile:
  - `axios` `^1.17.0` → `^1.19.0` (`anthropic-llm`, `openai-llm`).
  - `@modelcontextprotocol/sdk` `^1.28.0` → `^1.30.0` (`llm-agent-mcp`, `llm-agent-server`).

  No source changes; full monorepo build clean; lint unchanged.

## 20.9.4

### Fixed

- **MCP text-content envelope is now unwrapped in every bridge (#267, PR #268).**
  All three MCP bridges — `buildMcpBridge`, `buildNamespacedMcpBridge`, and
  `composeAuxiliaryBridge` — built `McpCallResult.text` with
  `typeof content === 'string' ? content : JSON.stringify(content)`. A standard
  MCP `CallToolResult.content` is an array of content blocks
  (`[{ type: 'text', text }, …]`), never a bare string, so the canonical text
  envelope fell through to `JSON.stringify`: the executor (on every text tool
  result) and any surfaced tool error (the #264 control-failure text) received
  raw `[{"type":"text","text":"…"}]` instead of the text. A surfaced error read
  `Error: [{"type":"text","text":"MCP error … Class … not found"}]`.

  A new shared `mcpContentToText()` (`llm-agent-server-libs`, `src/mcp/mcp-content.ts`)
  unwraps a **pure** text-block array (joins the parts with `\n`) and leaves a bare
  string, a structured object, or a mixed array (text + image/resource) stringified,
  unchanged — no information loss for non-text payloads. Wired into all three bridges.

### Changed

- **`McpToolResult.content` now models the canonical MCP shape.** A new public
  `McpContentBlock` type is exported, and `McpToolResult.content` is widened from
  `string | Record<string, unknown>` to
  `string | Record<string, unknown> | McpContentBlock[]`, so the content-block
  array is part of the contract (it previously required an unsafe cast). Additive
  and backward-compatible.

## 20.9.3

### Fixed

- **Controller `(no response)` on an all-failed run with a real LLM finalizer (#264, PR #265).**
  The #243 dead-end guard (`commitTerminalSuccess` → `capturedFailureText`) fired
  only when the finalizer returned an **empty** body — which is what the unit suite
  scripted. A real LLM finalizer handed an **empty approved-set** (every step failed
  → `collectApproved()` returns `[]`) does not return `''`; it composes a confident,
  **non-empty** *"no SAP connection / no error message available"* answer, so the
  guard never fired, the hallucination was written as a success terminal, and the
  captured tool error (`Class … not found`, a `maxToolCalls` / step-timeout note)
  was silently dropped even though the user asked for it. Now, when a finalizer is
  configured but its approved-set is empty **and** a control-failure was captured,
  the run surfaces `capturedFailureText` via the error terminal **before** invoking
  the finalizer, so a non-empty hallucination can no longer slip past the guard.
  Partial progress (a non-empty approved-set) still composes normally. Observed live
  on 20.9.2 against a real SAP AI Core embedder; the in-memory suite never modelled a
  non-empty finalizer answer, so it stayed green.

## 20.9.2

Patch release — knowledge-write resilience follow-up to the v20.9.1 `(no response)` fix (#259). No breaking changes, no new runtime API.

### Fixed

- **A knowledge-write embed failure no longer crashes the controller run (#259).** Follow-up to #243/#260: v20.9.1 stopped handing the embedder *empty* content, but any *other* embed failure on a knowledge write — a rate-limit (429), a transient network error, or a provider rejection on non-empty content — could still propagate an unhandled rejection out of the controller's `execute()`, the same crash / `(no response)` shape via a different trigger. Both knowledge backends are now resilient:
  - `JsonlKnowledgeBackend.build()`'s lazy-rebuild loop wraps each entry's `upsert` in a `try/catch` — one failing embed is skipped + logged and the rebuild continues; the session is marked "built" only on full success, so a failed entry is retried on the next touch.
  - `InMemoryKnowledgeBackend.put()` now tolerates an `upsert` failure the same way — the entry is already retained in the durable store, so it is kept and simply left unindexed (a recall-quality degradation, never a crash).

  This makes the control-failure → terminal path independent of a RAG write succeeding: an embed failure degrades to a logged skip and a surfaced answer, never a silent `(no response)`. (An in-memory-only deployment does not re-index a failed entry for the process lifetime; a persistent `logDir` deployment rebuilds it on the next touch.)

## 20.9.1

Patch release — the reopened controller `(no response)` fix (#243), plus documentation and test hardening. No breaking changes, no new runtime API.

### Fixed

- **Controller `(no response)` on the control-failure path — the real, live-only root cause (#243, reopened; #260).** The v20.9.0 empty-success terminal guard (#245) was correct but was never *reached* on a live deployment: the control-failure step-result was persisted with an empty `content: ''`, which a real embedder (SAP AI Core, and any strict embedder) rejects with HTTP 400 ("The text content is empty"); the write error was swallowed (`[jsonl-index] will rebuild lazily`) and the run dead-ended before reaching any terminal writer, returning `(no response)` with zero tokens. The in-memory RAG in the v20.9.0 tests never embeds, so it passed CI. Fixed at the root: `writeControlFailure` now embeds the failure **reason** (never empty), and the embed chokepoint (`makeKnowledgeSemanticIndex.upsert`) skips empty/whitespace content so no caller can hand a real embedder empty text. Live-verified against a real SAP AI Core embedder + MCP: a genuine not-found tool error now surfaces the captured message with `finish_reason: stop` and non-zero usage — never `(no response)`.

### Documentation & tests

- User-facing docs for the `(no response)` control-failure path refreshed to describe both the empty-finalizer guard and the empty-content-embed root cause (TROUBLESHOOTING).
- Why a bare custom `connectMcp` gets slot-index prefixes instead of `mcp[].name` labels — rationale added (#253).
- `/health` sample version refreshed to the current release (#257); ARCHITECTURE "Current Technical Debt" updated for the completed smart-server decomposition, and the implemented monolith-audit design docs removed (#258).
- Dedicated collision-throws tests for both `mergeOfferedTools` call sites (#252); a live-mirroring empty-rejecting-embedder regression test for the #243 control-failure write.

### Known follow-up

- #259 — `JsonlKnowledgeBackend.build()`'s per-entry re-embed has no per-entry `try/catch`, so any *other* embed failure (rate-limit / transient) on non-empty content can still crash the run; and the failed-step path should reach the terminal guard even when a RAG write fails. Moot for the empty-content trigger fixed here; tracked for a follow-up.

## 20.9.0

Bundles every change merged since v20.8.0: the controller no-response safety-net
(#243), a retry-classification fix (#239), and the v20.8.0 embedder follow-ups
(#238 bulk upsert, #240 tool-record-key namespacing storage-level, #241
`withCircuitBreaker` factory). No breaking changes — the new surfaces
(`IRagBackendWriter.upsertManyPrecomputedRaw`, `withCircuitBreaker`,
`IToolRecordKey` / `SmartAgentBuilder.withToolRecordKey`, `ControlFailure.note`)
are all additive.

## 20.8.0

MCP tool vectorization no longer exceeds a provider's batch cap (#236). Chunking
and retry are now properties of the embedder, composed once in `resolveEmbedder`,
so every `embedBatch` caller inherits them. Adds `rag.maxBatchSize`, the
`IBatchSizeLimited` contract, and `/health` `components.toolCatalog` reporting a
partial catalog as `degraded` (HTTP stays 200; readiness untouched).

## 20.7.1

### Fixed

- Controller leaf steps (no `requires`) no longer self-lookup their own evidence,
  which read `MISSING` and drove a spurious reviewer-reject/replan loop (#213, #230).
  A leaf step now gets no dependency evidence and is judged from the executor's
  result alone.

### Documentation

- Planner classification across pipelines added to ARCHITECTURE (#233), and a full
  pre-release documentation accuracy audit corrected stale/inaccurate references
  across the whole doc set (#234, #235): CLI/scripts, routing modes, config keys,
  interface signatures, the six builder-factories, launcher config paths, and
  provider/package listings.

## 20.7.0

### Fixed

- Tool errors on locked/contended objects no longer loop, balloon, or hang
  (#213, #231). A delivered MCP tool-level error (e.g. a locked SAP object
  returning `isError: true`) was lost before it reached the controller, so a
  failed call looked like a delivered result and the executor retried it
  indefinitely (token balloon / `(no response)`, and a failed activation could be
  reported as success). `isError` is now threaded end to end across all transports
  (stdio, streamable-HTTP, embedded) via `McpCallResult { text; isError }`.

### Changed

- The controller acts on a delivered tool error: it cuts the step on the first
  `isError: true` tool round (executor tool-loop stops, reviewer skipped), settles
  it failed with the tool's error text, and the planner then replans (if the
  failure is in something it chose) or emits a terminal `error` decision that
  surfaces the real tool error to the consumer (if the request pinned the failing
  constraint). No error taxonomy hardcoded.

### Added

- `NextStep` gains an `error` variant (`{ kind: 'error'; error: string }`),
  produced by the controller planner (`parsePlan` / `callPlan` / `next()`) and
  terminated by the coordinator handler. Additive; `next` / `done` / `rewind`
  unchanged.

## 20.6.0

### Fixed

- **Per-session MCP client isolation for concurrent tool-use (#213, PR #226).**
  Concurrent MCP-tool-using requests no longer cross responses. Previously every
  session shared one global MCP client by reference, so concurrent `callTool`
  invocations on the single connection interleaved — one response ballooned
  (absorbing both conversations' tool results) while the other returned
  `(no response)` with near-zero tokens. Each session now gets its own MCP client
  for tool *execution* (lazy-connects on first call), while tool *selection*
  still reads the shared, pre-vectorized catalog (no extra embedding work). Same
  failure class as the LLM `keepAlive` fix (#219), now closed for the MCP client.

### Added

- **`agent.mcpSharedClient` opt-out (default `false`).** Set `true` to reuse one
  shared MCP client across all sessions (the pre-isolation behavior) when the
  upstream MCP server permits only a single connection. Isolation applies only to
  the server-owned YAML `mcp:` path; injected clients (`withMcpClients`,
  plugin-provided) and an injected `connectMcp` seam stay shared by design.

### Docs

- Documented per-session MCP isolation and `agent.mcpSharedClient` in
  EXAMPLES.md, a new TROUBLESHOOTING.md entry (concurrent responses crossing),
  and DEPLOYMENT.md session-affinity. Corrected earlier v20.5.0 doc fabrications
  (no `mcp.strategy` YAML key; accurate interface signatures in INTEGRATION.md).

## 20.5.0

### Features

- **Per-round tool-loop context strategy — `IToolLoopContextStrategy` (#224).** A consumer-swappable seam for how each tool-loop round forms the executor's context, with four strategies: `LegacyAccumulate` (byte-identical default), `Window` (RAG-less bounded window), `RagRecall` (generic RAG-managed, fail-loud `runId`+counter), and `LegacyTranscript` (one-release resume migration). Threaded via a DI factory (builder + `ctx` + deps); the controller injects `RagRecall`, the server default and the direct `SmartAgent` inject `Window`, a bare agent keeps `LegacyAccumulate`. Both the shared tool-loop and the direct loop now form per-round context via the strategy (+ a `controlTail` for validation reprompts), dropping raw transcript accumulation. Effect on a heavy live run: the outlier prompt dropped from ~1.1M to ~134k tokens and per-round executor context from ~30.7k to ~7.8k.
- **Controller per-step / per-run execution control — `IStepExecutionControl` + `IRunExecutionControl` (#224).** Two focused ISP seams that give the controller a *time* budget (it previously had only count budgets, so a non-converging plan step could run to the outer HTTP timeout — an executor livelock). `DefaultStepExecutionControl` adds a wall-clock `budgets.perStepTimeoutMs` (explicit `AbortController`+`setTimeout`) plus a prospective `maxToolCalls` gate; the per-step `AbortSignal` is merged (`AbortSignal.any`) into **both** the executor LLM call and MCP `callTool`/`listTools`, so the step is bounded regardless of what consumed the time. A cut is a typed `control-failure` (`'maxToolCalls' | 'step-timeout' | 'control-failure'`) that the planner replans on; the #223 MCP-unavailable fail-loud order is preserved. `IRunExecutionControl` ships as a no-op default (run-level budget deferred). Wired via `BuildAgentDeps` / `IPipelineContext` (no builder change); no injection + no `perStepTimeoutMs` ⇒ byte-identical.
- **`IAuxiliaryMcpTools` — pipeline-level auxiliary/service MCP tools, first tool `wait` (#225).** A narrow, consumer-swappable seam (`listTools`/`callTool`, **not** `extends IMcpClient`, no `healthCheck`, outside the MCP fail-loud classifier) through which a pipeline contributes stateless service tools into the tool-selection catalog and the `callMcp` bridge — always present, even MCP-less. The default `wait` tool pauses N seconds (clamped to a max, and bounded above by `perStepTimeoutMs` — a wait beyond the step budget is cut → `step-timeout`→replan; an abort propagates and is never mapped to a string). `DefaultAuxiliaryMcpTools`/`makeWaitTool`/`cancelableDelay` live in `@mcp-abap-adt/llm-agent-mcp`; the composition (`resolveAuxDefs`/`assertNoAuxCollision`/`composeAuxiliaryBridge`/`composeAuxiliarySelect`) in `@mcp-abap-adt/llm-agent-server-libs`. Wired via `BuildAgentDeps.auxiliaryMcpTools` / `IPipelineContext.auxiliaryMcpTools`; the controller contributes the default `wait` at `build()`, consumer overrides the whole provider. RAG is deliberately **not** exposed through this seam.

### Config

- **`pipeline.config.budgets.perStepTimeoutMs`** (controller) — optional per-step wall-clock budget in ms. Absent ⇒ time never fires (count-only bound, as before).

### Behavior notes

- The controller default now adds `wait` to its offered tools (the livelock-mitigation point). Restore the prior tool surface by injecting an empty provider: `ctx.auxiliaryMcpTools = new DefaultAuxiliaryMcpTools([])`.
- **Fail-loud collision:** a controller + MCP deployment whose domain catalog already exposes a tool named `wait` now **throws at build** (`assertNoAuxCollision`) — intentional (better than silently shadowing); remedy: rename the auxiliary tool or inject an empty provider.
- The guidance for using `wait` (decompose an async `activate` into `activate → wait → verify` as separate plan steps) is a **consumer skill** (skills-RAG, runtime) reaching the controller planner via its existing skills-recall hook — it is NOT shipped in these packages.

## 20.4.0

### Fixes

- **The controller pipeline no longer returns a silent `(no response)` when the MCP *server* is unavailable (transport drop / `fetch failed` / 404 / 502) mid-run (#223).** An unrecoverable MCP availability error during the executor's tool step is now escalated and surfaced as a LOUD error instead of degrading to empty content. This closes the residual gap in the #201–205 fail-loud lineage — both on the shared tool-loop core (`ok:false` `OrchestratorError('MCP_UNAVAILABLE')`) and on the controller bridge (a loud `abortTerminal` "MCP server unavailable: …" chunk).
- **`toMcpError` now classifies streamable-HTTP transport errors — including a 404 route-gone (`MCP_HTTP_404`) — as MCP-unavailable (#223).** A genuine tool-level "not found" still maps to `MCP_ERROR`: the 404/"not found" match is gated inside the streamable-HTTP wrapper signature, preserving the anti-false-positive guard.
- **The controller trusts the bridge throw-contract (#223).** `buildMcpBridge` throws only when the classifier deems a failure `'unavailable'` (tool-level errors are returned as text, never thrown), so the controller catch now surfaces any thrown `McpError` loudly instead of re-checking the code with a hardcoded `isMcpUnavailable` — which previously dropped a *custom* classifier's verdict for otherwise-tool-level codes. The `pipeline: controller` path forwards `ctx.mcpFailureClassifier` into its bridge.

### Features

- **`IMcpFailureClassifier` — a consumer-swappable strategy that decides `'unavailable'` (fail loud) vs `'tool-error'` (feed back to the LLM) for a failed MCP tool call (#223).** Wired via dependency injection at both MCP-failure decision points (`buildMcpBridge` and the shared `classifyToolResult`), threaded to both tool-loop callers (the direct `SmartAgent` and the pipeline `ToolLoopHandler`), the controller bridge, and a builder seam — `builder.withMcpFailureClassifier(...)` / `BuildAgentDeps.mcpFailureClassifier`. The default `DefaultMcpFailureClassifier` (in `@mcp-abap-adt/llm-agent-mcp`) is error-based (built on the existing `isMcpUnavailable`) and adds **no** per-call round-trip. An optional `probeHealth` seam (MCP `ping` via `IMcpClient.healthCheck`) lets a consumer implement a health-confirming classifier; the default never probes. **DI/programmatic only — no YAML / `SmartServerConfig` change.**

### Notes

- With no classifier injected, runtime behavior is byte-identical to before this release (the default classifier is `isMcpUnavailable`-based and ignores the probe). New public surface: `IMcpFailureClassifier` / `McpFailureKind` (`@mcp-abap-adt/llm-agent`), `DefaultMcpFailureClassifier` (`@mcp-abap-adt/llm-agent-mcp`), `MCP_HTTP_404` in `MCP_UNAVAILABLE_CODES`, `builder.withMcpFailureClassifier(...)`, and the optional `mcpFailureClassifier` field on `IPipelineContext` / `IExecuteToolBatchArgs` / `SmartAgentDeps` / `PipelineDeps` / `BuildAgentDeps`.
- Does **not** touch the #222 request-timeout work (folded in via 20.3.0). This release supersedes the tagged-but-unpublished 20.3.0 (and the earlier held 20.1.0 / 20.2.0) — see their CHANGELOG sections.

## 20.3.0

### Fixes

- **MCP tool calls no longer hit the SDK's implicit ~60s timeout (or hang) on heavy runs (#222).** `MCPClientWrapper.callTool` now passes an explicit, consumer-owned request timeout to the MCP SDK instead of falling through to its built-in ~60s `DEFAULT_REQUEST_TIMEOUT_MSEC` (which produced `-32001: Request timed out` → a silent `(no response)` on long multi-tool controller reviews). The timeout is a **generous per-call safety net**: `resolveToolTimeout(name) = toolTimeouts[name] ?? timeout ?? 120000` (2 min default), with `resetTimeoutOnProgress` so a tool that reports progress is not cut off. A stuck/orphaned call now dies at the resolved limit — no indefinite server hang.
- Removed the redundant MCP "timeout stack": the transport `requestInit` per-request `AbortSignal.timeout` cutoff and the connect-bound are gone — there is exactly one MCP timeout (the `callTool` one). Connection availability stays governed by the connection-strategy layer; the adapter's `withAbort(signal)` cancellation is unchanged. HTTP session-resume is preserved (the live server-assigned session id survives reconnect).

### Features

- **Configurable MCP request timeouts, per client and per tool (#222).** New `mcp.timeout` (default 120000 ms) sets the per-call default; `mcp.toolTimeouts: { <toolName>: <ms> }` sets per-tool overrides (some tools legitimately take 5–15 min). Settable in YAML and programmatically; threaded through both the builder→factory and the YAML/server construction paths, for HTTP and stdio transports.
- **`IMcpRequestHeadersStrategy` (#222)** — an optional, consumer-owned strategy (default `NoopMcpRequestHeadersStrategy`, contributes nothing) to inject MCP request headers (e.g. a server-side "willing to wait longer" hint), wired via `builder.withMcpRequestHeadersStrategy(...)`. YAML users use the existing static `mcp.headers`.
- **MCP tool-call timing observability (#222).** Each MCP tool call emits a `tool_call` structured `LogEvent` (`toolName`, `isError`, `durationMs`) plus an `mcp_tool_call` session-debug step — through the existing structured logging (verbosity follows the run mode), including on timeout/unavailable failures. A `durationMs` near a tool's resolved timeout tells you which tool to raise via `toolTimeouts`.

### Notes

- This release also folds in the previously-tagged-but-unpublished 20.1.0 and 20.2.0 work (see their CHANGELOG sections): controller recalled-skill → finalizer delivery directives (#212), `/health` model-alias false-negative (#220), SAP AI Core concurrency hardening (#213/#219), `skillPlugins` docs (#211), and the monolith-decomposition campaign (#206–#218).

## 20.2.0

### Features

- **Controller: recalled skills now shape the finalizer's delivered answer (#212).** A `controllerSkillGroup` skill's output/delivery/formatting directives are honored in the delivered text, not just the plan. The engine stays agnostic — a generic honor-clause; the consumer's skill supplies the directive. With no skill configured the finalizer prompt is byte-unchanged; the "do not invent facts" guard is retained (skills govern delivery only).

### Fixes

- **`/health` no longer returns 503 for a working LLM (#220).** `LlmAdapter.healthCheck` reported a reachable LLM unhealthy when the configured model name was a valid alias absent from the provider's `/models` list (e.g. deepseek `deepseek-chat`). Now a reachable provider is healthy; LLM/RAG/MCP soft failures map to `degraded` (not `unhealthy`); `/health` returns 503 only when NOT ready (MCP-readiness gate unchanged, still fails loud); the LLM probe logs its failure cause instead of swallowing it. The `/health` JSON shape is unchanged.
- **SAP AI Core concurrency hardening (#213/#219).** `chat()` now uses a per-call non-keepAlive HTTPS agent (mirroring `streamChat`), avoiding a shared keepAlive connection that could let SAP AI Core route a response to the wrong in-flight request when concurrent requests share one XSUAA user.

### Docs

- **`skillPlugins` inline-record example uses the required `id` (not `name`) (#211).** The documented example crashed the server at startup (`id` is required; `name` is optional and defaults to `id`); corrected in `docs/EXAMPLES.md`.
- Documented that controller skills shape BOTH the planner and the finalizer (`EXAMPLES.md`, `ARCHITECTURE.md`, `PIPELINES.md`).

## 20.1.0

### Added

- **MCP readiness & fail-loud** (#201–#205): a first-class readiness surface for
  MCP-backed servers. `/health` now returns **503** while MCP is not ready; a
  pre-dispatch request gate rejects work that needs an unavailable MCP; and every
  execution surface **fails loud** instead of returning a silent `(no response)`.
  Built ON the MCP connection strategies (+ a small `IReadinessReporter`), with
  error classification and session-preserving reconnect; the builder now defaults
  MCP to a connection strategy with agent readiness.

### Changed

- **Behavior:** requests and health checks now surface MCP-unavailability errors
  loudly (503 / typed error) where prior versions could return an empty/degraded
  response. No published config key or API was removed — a config that loaded
  before still loads and runs; only genuine MCP-down conditions now error clearly.
- **Internal decomposition (monolith audit, #206; PRs #208–#218) — public API
  byte-stable, behavior-preserving.** The largest runtime files were decomposed
  into focused, individually-testable modules (all moves byte-for-byte, verified
  against characterization tests + whole-branch review):
  - `smart-server.ts` 3926 → 2559 (7 components + full HTTP handler extraction +
    `makeToolsRagHandle` factory).
  - `agent.ts` 2160 → 1302 and the shared tool-execution core deduped into
    `pipeline/handlers/tool-loop-core.ts`.
  - `config.ts` 1648 → 269 (5 modules + a thin `resolveSmartServerConfig`
    delegating per-section builders).
  - `controller-coordinator-handler.ts` 2026 → 1682 (parser/recall/usage-logging
    siblings) and an inverted dependency fixed (`planner`/`reviewer` no longer
    import from the handler).
  - `builder.ts` 1437 → 1182, extracting MCP **tool vectorization** into
    `mcp/vectorize-mcp-tools.ts` — closing the `docs/ARCHITECTURE.md` tech-debt.
  These changes are internal only; every public export path is unchanged.

## 20.0.0

### Added
- Controller planner capability-tuned planners (§C): smart-executor (default `controller`) and weak-executor (new `controller-weak` preset); preset-encoded selection; `ControllerFactory.build(config, deps, kind)` + `deps.controllerPlanner` DI seam.
### Changed
- `controller` defaults to the live digest board (smart-executor; was incremental).
### Removed
- `planner:` controller config key + `IncrementalPlanner` (clean break, fail-loud — no alias).
### Fixed / Docs
- v19 documentation-accuracy pass: migrated ~25 example configs + docs off removed shapes (`coordinator:`, structured `pipeline:{version,stages}`, `withStageHandler`) to the current `pipeline:{name,config}` model; all shipped examples config-validate.

## 19.2.0

### Added
- Controller planner — step identity & live digest board (Phase 1+2): stable per-step
  `stepId`, `plan-decision` artifacts, reviewer planning `digest` (`ReviewOutcome`),
  `stepId`+`digest` on every step-result (incl. control failures), bounded
  `renderBoard` with a guaranteed cap (fail-loud), additive board+plannerPrivate
  prompt, canonical writeOrdinal replay (no phantom planned orphans).
- Skill plugin-host & runtime gnostification (`skillPlugins:`): domain-agnostic host
  materialising consumer skills into a grouped skills-RAG; marketplace + inline
  sources; controller + assembler recall.
- Controller execution-result control & data backbone: reviewer/finalizer split,
  durable run-scope + crash recovery, run-scoped embedding recall.

### Fixed
- Results-RAG: bound embed input (`maxEmbedChars`, default 16000) for large tool/step
  results so an over-limit document no longer 400s the embedder and stalls the run;
  stored content stays full.

## 19.1.2

Release 19.1.2.

## 19.1.1

Release 19.1.1.

## 19.1.0

Release 19.1.0.

## 19.0.0

### ⚠ BREAKING CHANGES

- **Pipeline selection is now plugin-based.** The old top-level `coordinator:` YAML block and the legacy `pipeline: { mcp | rag | stages | llm }` overrides are **removed**. Select a pipeline with `pipeline: { name, config }` where `name` is `flat` | `linear` | `dag` | `stepper` | a custom plugin name. A config still using the old form **fails loud** at startup with a migration message. Top-level `llm:`, `mcp:`, `rag:`, `subagents:` are unchanged.
  - **Migration:** `coordinator: { mode: planned-react, knowledgeSeed: [...] }` → `pipeline: { name: stepper, config: { mode: planned-react, knowledgeSeed: [...] } }`; DAG (`planner`/`reviewer`/`finalizer`) → `pipeline: { name: dag, config: {...} }`; linear (`planning`/`dispatch`/`activation`) → `pipeline: { name: linear, config: {...} }`. `knowledgeSeed` now lives under `pipeline.config`. Pin a version `<= 18` for the old behavior.

### Added

- **Pipeline plugins.** A pipeline is an `IPipelinePlugin` (core `@mcp-abap-adt/llm-agent`) that builds an `IPipelineInstance` (`{ agent, close }`). Built-in `flat`/`linear`/`dag`/`stepper` wrap the existing coordinator components. Custom pipelines load dynamically via `plugins: [<module-specifier>]` (resolved against the user's cwd; a module's full `PluginExports` — incl. `embedderFactories`/`mcpClients` — is merged before RAG). Duplicate pipeline names across sources fail fast.
- **Subpath exports** from `@mcp-abap-adt/llm-agent-server-libs`: `./flat` `./linear` `./dag` `./stepper` (built-in plugins) and `./legacy/<flow>` (the pre-v19 coordinator components, for code-level composition without YAML). `IServerPipelineContext` + `createServerPipelineContext` are exported for plugin authors.

### Changed

- The per-session request-serving agent is built by the resolved pipeline plugin; the startup global agent remains the infra/passthrough handle. The plugin contract (`IPipelineInstance = { agent, close }`) stays core-clean — server concerns live in `IServerPipelineContext`.

### Fixed

- **MCP wiring.** A YAML `mcp:` block now connects **exactly once** (the prior path double-connected). `toolsRag.lookup()` resolves **synchronously before any query** (catalog eager-loaded at startup). MCP **tool-vectorization is preserved** for the YAML path (so `smart`/`flat` pipelines still surface MCP tools to the model). An explicit `mcpClients: []` **disables MCP** and overrides a YAML `mcp:` block (DI precedence).

## 18.2.0

Client-provided external tools under the DAG coordinator (#171). External (client) tools are now mode-independent (always offered; `hard` governs only internal MCP execution), consumer-executed (the worker surfaces a standard tool_call via the normal OpenAI/Anthropic round-trip — no custom transport), and carry deterministic content-addressed `ext:` ids for stateless re-run correlation. Parallel DAG workers' external calls are collected into one terminal assistant turn; incoming external results are adjacency-validated and the consumed turns stripped from internal LLM message lists.

## 18.1.2

### Patch Changes

- Fix: `usage.models` now keys by the LIVE (hot-swapped) model, not the stale initial one (#164).

  `SmartAgent.reconfigure()` swapped its own `_mainLlm` but the `DefaultPipeline` held a separate `deps.mainLlm` snapshot, so a hot-swapped request kept logging — and aggregating `usage.models` under — the initial model name. `reconfigure()` now propagates the swap into the pipeline. Also lands an env-gated `node:test` integration check that the DAG coordinator dispatches real MCP-tool work to its worker (regression gate for the toolless/hallucination path, #159), and the reviewed design spec + implementation plan for client-provided external tools under the DAG coordinator (#171).

## 18.1.1

### Patch Changes

- Version alignment — unify ALL workspace packages to a single version.

  18.1.0 bumped only the six core packages (the changeset `fixed` group at the time), leaving the eleven provider / embedder / RAG-backend packages at 18.0.2. The `fixed` group now contains all 17 packages so every release moves them together. This release carries no functional change — it only realigns the provider/embedder/backend packages (18.0.2 → 18.1.1) and the core packages (18.1.0 → 18.1.1) to one version.

## 18.1.0

### Minor Changes

- 18.1 — Evaluator spine, hallucination guards, and the SmartServer composition library.

  - **Evaluator (per-level input judge):** the Stepper coordinator now runs an LLM Evaluator before planning that routes a step `executable | needs-work | needs-consumer` with a `missing[]` list, on by default at all depths; recursion requires it as a terminator. The `missing` gaps drive an additive, single-intent tool search (prompt-search ∪ needs-search) so a "review the program" prompt surfaces `GetProgram` while the needs surface `GetInclude`/`GetIncludesList`.
  - **Hallucination guards (Stepper executor):** an explicit no-capability error — when the Evaluator established a need but the toolset is empty after all seeding, the executor throws a clarify signal instead of fabricating an answer (`allowToolless` to opt out); and a token-grounding detector — a final answer produced with no tool calls, no grounding facts, and tools on offer is flagged (`hallucination_suspected`) with token evidence.
  - **New package `@mcp-abap-adt/llm-agent-server-libs`:** the SmartServer composition runtime is now an importable library (between the binary and core `llm-agent-libs`). It carries `SmartServer`, `buildFromComposition`/`buildStepperRoot`, `StepperCoordinatorHandler`, coordinator config parsing, session stores, and the **pipeline builder-factories** `LinearFactory`, `DagFactory`, `CyclicFactory`, `PlannedFactory`, `DeepStepperFactory` (each builds one pipeline's `coordinator` stage handler from a typed config + role-resolving deps). `buildFromComposition` accepts a `makeRoleLlm` callback so factories work without the server's config types. `@mcp-abap-adt/llm-agent-server` is now a thin binary that depends on it (behaviour unchanged).
  - **Clean plain-mode content:** an `ephemeral` flag on `LlmStreamChunk`/`StreamChunk` marks tool-loop liveness markers (`[SmartAgent: Executing X]`) so they are excluded from non-streaming content accumulation — `stream:false` responses no longer leak execution traces; streaming clients still receive them.

## 12.0.3

### Patch Changes

- 108cd1d: Complete the v12 package split: introduce `@mcp-abap-adt/llm-agent-mcp`, `@mcp-abap-adt/llm-agent-rag`, and `@mcp-abap-adt/llm-agent-libs`. `@mcp-abap-adt/llm-agent-server` becomes binary-only — composition surface lives in `llm-agent-libs`, MCP in `llm-agent-mcp`, RAG/embedder in `llm-agent-rag`, interfaces and DTOs in `llm-agent`. Top-level `makeLlm` / `makeDefaultLlm` / `makeRag` are now async (`Promise<...>`); `resolveEmbedder` remains synchronous and uses the existing prefetch contract. `SmartAgentBuilder.build()` was already async — consumers using only the builder are unaffected. Closes #125.

## 12.0.0

### Major Changes

- Move library helpers from `@mcp-abap-adt/llm-agent-server` into `@mcp-abap-adt/llm-agent` (#123).

  **BREAKING CHANGE.** Embedded consumers that ship their own HTTP server can now depend on `@mcp-abap-adt/llm-agent` only and skip the server package entirely. The following symbols are no longer exported from `@mcp-abap-adt/llm-agent-server` — import them from `@mcp-abap-adt/llm-agent` instead:

  - **Resilience:** `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState`, `CircuitBreakerLlm`, `CircuitBreakerEmbedder`, `FallbackRag`
  - **LLM call policies:** `NonStreamingLlmCallStrategy`, `StreamingLlmCallStrategy`, `FallbackLlmCallStrategy`
  - **Tool cache:** `ToolCache`, `NoopToolCache`, `IToolCache`
  - **API adapters:** `AnthropicApiAdapter`, `OpenAiApiAdapter`, `AdapterValidationError`, `ApiRequestContext`, `ApiSseEvent`, `ILlmApiAdapter`, `NormalizedRequest`
  - **Client adapters:** `ClineClientAdapter`, `IClientAdapter`
  - **Tool utilities:** `normalizeAndValidateExternalTools`, `normalizeExternalTools`, `ExternalToolValidationCode`, `ExternalToolValidationError`, `CLIENT_PROVIDED_PREFIX`, `getStreamToolCallName`, `toToolCallDelta`
  - **Logger:** `ILogger`, `LogEvent`

  `@mcp-abap-adt/llm-agent` runtime dependencies remain unchanged (`zod` only). The runnable distribution (`SmartAgentBuilder`, `SmartServer`, providers/factories composition root, plugins, skills, sessions, metrics, tracer, validator, reranker, history, structured pipeline, health, config watcher, MCP client wrapper, CLI, bin entries) stays in `@mcp-abap-adt/llm-agent-server`.

## 11.1.2

### Patch Changes

- Bump dependencies: biome 2.4.13, typescript 6.0.3, @types/node 25, rimraf 6, zod 4.3. MCP SDK 1.29 supports zod 3 || 4; smoke-tested via `npm run dev` against real MCP server.

## 11.1.1

### Patch Changes

- Fix streaming `tool_calls` regression introduced in the 10.x provider split (#119) and surface MCP setup failures that were previously swallowed (#118).

  - **Streaming providers now emit normalized `toolCalls` deltas.** `sap-aicore-llm` reads `chunk.getDeltaToolCalls()`, `openai-llm` (and `deepseek-llm` by inheritance) reads `choice.delta.tool_calls`, and `anthropic-llm` tracks `tool_use` content blocks plus `input_json_delta` — populating the new optional `LLMResponse.toolCalls` field. `LlmProviderBridge` accumulates from this normalized field instead of digging into provider-specific `raw` payloads (it previously handled only the OpenAI shape, so SAP and Anthropic streaming tool calls were dropped). Anthropic also normalizes `stop_reason: 'tool_use'` → `finishReason: 'tool_calls'`.
  - **`SmartAgentBuilder.build()` no longer swallows MCP setup errors.** Connect failures (unreachable host, bad auth, container-network mismatch) and post-connect failures (tool vectorization throwing) now produce a `warning` log entry — `MCP setup failed for <url-or-command>: <error message>` — instead of disappearing into a bare `catch {}`. Graceful-degradation contract preserved.

## 11.1.0

### Patch Changes

- Released alongside the @mcp-abap-adt/sap-aicore-embedder + @mcp-abap-adt/llm-agent-server foundation-models scenario fix (#116, #117) and the @mcp-abap-adt/qdrant-rag dimension mismatch guard. No source changes in this package — version sync per the changesets fixed group.

## 11.0.0

### Major Changes

- Complete provider and backend extraction. Eight new packages shipped:
  @mcp-abap-adt/openai-llm, anthropic-llm, deepseek-llm, sap-aicore-llm,
  openai-embedder, ollama-embedder, sap-aicore-embedder, qdrant-rag.

  Breaking changes:

  - Back-compat re-exports from v10.0 removed. Each symbol lives in exactly
    one package. See docs/MIGRATION-v11.md for the symbol-by-symbol table.
  - Non-Smart Agent hierarchy removed. Use SmartAgent + a provider class
    directly.
  - Core runtime dep shrinks to zod only; axios and @sap-ai-sdk/\* move to
    their respective extracted packages.
  - Server provider dependencies are optional peer deps. Install only the
    peers your smart-server.yaml names. Missing peer throws
    MissingProviderError at startup.

## 10.0.0

### Major Changes

- Split single package into a monorepo with two initial packages:

  - `@mcp-abap-adt/llm-agent` — interfaces, types, and lightweight RAG default implementations.
  - `@mcp-abap-adt/llm-agent-server` — default SmartAgent, pipeline, LLM providers, MCP client, HTTP server, and CLIs.

  Consumers of the v9 single package must switch their imports to one or both v10 packages. See `docs/MIGRATION-v10.md` for the symbol-by-symbol mapping and install-command changes.

  CLI bins (`llm-agent`, `llm-agent-check`, `claude-via-agent`) remain available and are now shipped by `@mcp-abap-adt/llm-agent-server`.
