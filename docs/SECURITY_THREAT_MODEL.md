# Security Threat Model — SmartAgent Tool Execution

## Scope

Tool execution surface in `SmartAgent._runToolLoop()` when processing LLM-generated tool calls,
and the user-input processing surface in `SmartAgent._runPipeline()` before classification.

---

## Attack Surfaces

### AS-1: LLM-generated tool calls invoking restricted tools

**Threat:** The LLM (compromised, hallucinating, or influenced via prompt injection) generates
tool calls for destructive or unauthorized tools (e.g. file deletion, network exfiltration,
privilege escalation via shell execution).

**Mitigation:** `ToolPolicyGuard` with an explicit `allowlist` blocks any tool not on the
approved list before the MCP client is contacted. An `isError: true` result is injected into the
tool result stream so the LLM can observe the block without aborting the pipeline.

**Limitation:** The guard cannot prevent the LLM from calling an *allowed* tool with malicious
arguments. Tool argument sanitization is the responsibility of the MCP server / consumer.

---

### AS-2: Prompt injection via user input

**Threat:** Malicious user input contains phrases that confuse the classifier LLM ("role
confusion": "ignore previous instructions", "you are now", etc.) or embed fake tool invocations
("tool-call forgery": `{"tool": ...}`, `<tool_call>`, etc.) that bypass the LLM turn.

**Mitigation:** `HeuristicInjectionDetector` runs on the raw input text *before* classification.
When an injection pattern is detected the pipeline aborts immediately with `PROMPT_INJECTION`,
and the classifier LLM is never contacted.

**Limitation:** The heuristic pattern set is fixed at compile time. Novel or obfuscated injection
patterns (Unicode homoglyphs, base64-encoded payloads, multi-turn context poisoning) can bypass
detection. The detector is a defense-in-depth layer, not a guarantee.

---

### AS-3: Tool argument injection

**Threat:** Tool arguments crafted by the LLM contain SQL injection, shell injection, path
traversal, SSRF payloads, etc., targeting the downstream MCP server or the resources it accesses.

**Mitigation:** Out of scope for this library. Tool argument sanitization and validation are the
responsibility of the MCP server implementation and the consumer's security policy.

---

### AS-4: Session data leakage via shared RAG namespace

**Threat:** RAG records from one tenant/user/session are returned in query results for a different
tenant/user/session, causing cross-tenant data leakage.

**Mitigation:** `SessionPolicy.namespace` ensures all upserted records are tagged with a
caller-provided namespace string. `InMemoryRag.query()` filters results by namespace when one is
present on the stored record.

**Limitation:** The namespace value is provided by the consumer at construction time. The library
does not authenticate or validate namespace values — a buggy or malicious consumer can supply an
incorrect namespace. The library does not enforce cross-tenant isolation at the storage level;
that is the responsibility of the RAG store implementation used in production.

---

### AS-6: Cross-caller access through the RAG collection tools

**Collection-isolation rollout, Task 7 / Qdrant:** the backend now persists session,
user, role and global catalog owners, library-managed roles/assignments and immutable
session bindings. Collection access requires both ownership and the server's
decision; global creation/writes additionally require the trusted caller's admin
flag. These checks belong to the core access layer, not the backend factory.
The older v27 description below is historical; it does not describe the new role
or global access contract.

All backends apply a positive record `ownerScope` equality and the required identity
before top-k; missing or mismatched tags fail closed. Migration backfills valid legacy
records and reports conflicting keys without exposing them. Global filtering has no
Qdrant exact-version restriction. Full-owner validation rejects extra identity keys
at write time and on scoped reads, including a global tag carrying a private id.
Migration quarantines conflicting stored owners with the non-queryable `invalid`
tag and reports them. Backend predicates retain positive equality filters.

Qdrant persists a collection's catalog intent before verifying an active role.
Roles use immutable revision points: insert-only next revisions and unique fences
serialize state transitions through active, deleting(token), and deleted. Deleters
check their revision after every side effect and stop if fenced. Reverting a deletion
or taking over a crashed deleter requires a transition from the current deleting
revision. A stale in-flight assignment deletion may reduce permissions after
reversion; its failed fence prevents subsequent role removal, preserving the role
of every surviving collection. Revision history is retained, without leases or timers.
Strong ordered writes, all-replica reads and full replica acknowledgements are
required. Missing-role catalog intents are refused on reopen/hydration and reported
by migration. Bindings retain deterministic insert-only points and compare-after-write
(Qdrant >= 1.17.0). See
[Qdrant access persistence](../packages/qdrant-rag/README.md#collection-access-persistence).
This backend work does not complete the later server-wiring tasks.

**Threat:** A caller's model names another caller's collection in a RAG collection tool and reads
or writes it. Distinct from AS-4, which is about records returned by `query`: this is about the
collection-management tools themselves.

**State: mitigated** (`f0be5135`, "the collection tools are built for one caller").

**What was wrong (before v27)** (`packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`,
v26 line numbers): five of seven handlers took the `RagToolContext` they were given and ignored
it — `rag_add` (`:61`), `rag_correct` (`:87`), `rag_deprecate` (`:128`), `rag_list_collections`
(`:155`) and `rag_describe_collection` (`:171`). They resolved any name against the registry they
were built with, so against a shared registry they reached every registered collection.
`rag_create_collection` (`:266`) and `rag_delete_collection` (`:200`, `:208`) did use the owner
keys, and the latter also refused global deletes outright — that pair was the intended shape.

**Mitigation — construction, not a check — for `session`/`user` collections; addressing, not access
control, for `global`.** Per architecture principle 8, the tool entries are built with the caller's
identity bound in — **required, not optional**, so that an unnarrowed address space cannot be
reached by omitting a field. For `session`/`user` scope this settles the whole question: the only
collections a caller's tools can address are its own; another caller's collection is absent rather
than refused. For `global` scope it settles only who may **write**: every global a caller's registry
holds is readable through the tools — there is no per-collection authorization field, so a
role-restricted read is not something the framework can check, and it does not claim to. Role-based
read access to a shared global is the assembly's responsibility, built by choosing which globals go
into a given caller's registry, not a check inside the framework. Three rules make the write/delete
side of this complete, and all are part of it:

- **No framework tool mutates or deletes a `global` collection, ever.** Deciding who may change
  shared data is policy for every consumer to set, not a rule this framework invents once.
- **One source of caller identity.** `RagToolContext`'s declared `sessionId?`/`userId?` are removed, so a per-call value cannot disagree with the identity bound at construction — `rag_create_collection` no longer reads owner keys from that context, which would create a collection owned by an identity the address space was never narrowed to. Its `[key: string]: unknown` index signature keeps existing call sites compiling.
- **Each session owns its collection registry** (`SmartServer` supplies `ragRegistryFactory`), so two callers' same-named collections never meet in one registry.

Design and migration: [MIGRATION-v27.md](MIGRATION-v27.md) items 6, 7, 10, 11; `docs/ARCHITECTURE.md` principle 8.

---

### AS-5: Denial-of-service via runaway tool loops

**Threat:** A malicious or buggy LLM repeatedly calls tools in an infinite loop, exhausting
server resources.

**Mitigation:** `SmartAgentConfig.maxIterations` and `maxToolCalls` hard-cap the tool loop.
`timeoutMs` aborts the entire pipeline via a merged `AbortSignal` (`AbortSignal.any`) after a wall-clock deadline, with a `TimeoutError` reason. The HTTP routes also abort a request whose client disconnected before the response finished, so an abandoned request stops spending LLM, reranker and MCP calls; a caller's cancellation does not count against a circuit breaker (`isCallerCancellation`), so disconnecting clients cannot open it for every session.

---

### AS-7: Data sent to a third-party reranker

**Threat:** A reranker that calls an external model (the `decision` reranker, i.e. TypeSafe AI's API, or an
`llm` reranker over a hosted LLM) receives the user query and the candidate RAG passages. Sensitive text in
either leaves the deployment's trust boundary, and a leaked or misused key exposes the account. Two
independent mechanisms decide which stores' text is sent; they are stated separately.

1. **Per store (`rag.retrieval`).** A store sends its query and candidates out only when **its own entry** is
   `strategy: rerank` or `rerank-all` with an external reranker. A store listed with `strategy: embedding`,
   or not listed, is never sent by this mechanism. The candidates are that store's records: for `tools` the
   MCP tool-catalogue text (`Tool: <name> — <description>`, no input schema), for `history` session history
   entries (which can contain earlier assistant answers built from back-end tool output), for a collection
   its passages. Strategy applies on every path that reads the store, including the controller's per-step
   tool selection, so a reranked `tools` store sends the step instruction once per step.
2. **Legacy global reranker (a plugin's `reranker` export, or `withReranker`).** It reranks every store that
   has **no** `rag.retrieval` entry, `history` and custom `ragStores` collections included, in the `rerank`
   stage of the flat pipeline — and, if it calls an external model, sends those stores' records out. The
   stores are those queried before the `rerank` stage; with `enrichedToolSearch: true` the `tools` store is
   queried after it and is not sent. Any explicit entry — including `history: { strategy: embedding }` —
   takes the store out of the global reranker, so `history` is then sent by neither mechanism.

**Mitigation:** Both are opt-in: nothing is sent unless a `rag.retrieval` entry selects an external reranker
(for `decision` that also needs the `decision:` section), or a plugin / `withReranker` reranker is loaded.
To keep a store local, give it an explicit `strategy: embedding` entry. `TypeSafeDecisionModel` forces the
SDK's logging off and passes every client option explicitly, so `TYPESAFE_*` environment variables on the host
never redirect the key or URL or turn on body logging. Keys come from the environment by `credentialRef`
(`decision.apiKey` in YAML is refused at startup). Error messages carry the error class, HTTP status and
request id only — never the key or a request/response body.

**Limitation:** Whatever the provider retains is governed by the provider's terms, not by this library.
Do not enable it for data that may not leave the deployment. `rag.retrieval.history` applies to
per-session requests, so an explicit `history: { strategy: embedding }` entry keeps session history out of a global
(plugin / `withReranker`) reranker; without an entry the global reranker still sees it.

**Session isolation of history.** All sessions share one history store; isolation rests on the `sessionId` filter
of `IRag` (the `rag-history` stage queries with `scope: 'session'`). A custom `IRag` used as the history store
**must** honour that filter, otherwise one session reads another's history. Every built-in store does.

---

## Known Limitations

| Limitation | Severity | Owner |
|------------|----------|-------|
| Injection detector uses fixed heuristics — novel patterns bypass detection | Medium | Consumer: complement with LLM-based moderation at the API gateway |
| Tool argument content is not inspected | Medium | MCP server / consumer |
| Namespace is consumer-supplied and not authenticated | Low–Medium | Consumer: enforce namespace derivation from authenticated session |
| `smartAgentEnabled=false` is not cryptographically enforced — a second instance can be created with `enabled=true` | Low | Consumer: do not instantiate SmartAgent when disabled |
| No rate limiting or request authentication at the library level | Medium | Consumer / API gateway |

---

## Out of Scope

- Multi-tenant storage isolation beyond namespace tagging
- LLM output moderation (hallucination, bias, harmful content)
- Network-level security (TLS, firewall rules, VPC isolation)
- Operational concerns (audit logging to SIEM, alert thresholds, incident response)

These are the responsibility of the consumer. See deployment documentation for guidance.


### SmartServer caller identity and hydration (#304, Task 8)

SmartServer requires a trusted caller resolver and RAG access stores/decision
interface before startup. It mints or resolves the cookie session, resolves the
real user/admin identity, binds the session to that user in the configured
persistence, and only then acquires its session graph. Resolver, binding and
acquisition failures return HTTP 403. Graph reuse also refuses a changed user,
including concurrent builds. There is no header-selected or shared fallback user.

Catalog hydration admits only collections that pass ownership and the server's
read decision. Each request refreshes visibility using library-owned role
assignments; revocation hides a role collection in an already open session.
Retrieval still rechecks access at execution, so retaining a store reference
does not preserve revoked permissions. Missing-role catalog entries are skipped
and reported once per server. Session metadata stores the authenticated user ID.
The host must supply access stores from its catalog persistence to preserve
bindings across restarts and instances. In-memory stores provide process-local
persistence only. The CLI's explicit single-user local flag uses test access
helpers and is not for production.
