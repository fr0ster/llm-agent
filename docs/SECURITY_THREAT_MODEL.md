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

**Mitigation:** The collection isolation contract in AS-6 enforces mandatory owner
filters independently of namespace tagging. `SessionPolicy.namespace` remains an
additional consumer-provided partition, not an authenticated identity.

**Limitation:** The consumer must derive namespace values from trusted state.
Custom stores must implement the mandatory owner-filter contract; direct backend
access and authentication remain the host's responsibility.

---

### AS-6: Cross-caller access through the RAG collection tools

**Threat:** A model or caller names another owner's collection, forges a role or
identity, or reuses a session to read or mutate another caller's data.

**Guarantee:** One discriminated owner model covers session, user, role and global
collections. Access is ownership AND the server's `canRead`/`canWrite` decision,
checked in collection tools, registry hydration and both retrieval paths. Session
owners must match the caller's session; user owners must match its user; role
owners require membership from the library's assignments table only. Global
reads require the decision; global creation and writes additionally require
`caller.isAdmin`. Admin status never bypasses another owner's boundary. A server
decision can narrow access only; allowing cannot widen ownership.

**Fail closed:** Missing caller identity, denied or failing decisions, failed
role lookups and conflicting session bindings refuse access. There is no implicit
fallback to another session, user or shared identity. SmartServer requires a
trusted `callerResolver` and `ragAccess` at startup, resolves the cookie session,
binds its real user before graph acquisition and refreshes role visibility on
requests. Revocation is checked again at retrieval. Builder configuration requires
`withRagAccess`, explicit static collection owners and handling its `build()` Result.

**Record isolation:** Every record carries a positive `ownerScope` tag. Scoped
queries match that tag and the owner identity before top-k; global records carry
no private identity keys. Migration backfills valid legacy records and retags
conflicting owners `invalid`, unmatched by scoped queries, with an administrative
report. Missing-role catalog entries are refused. `history` and `tools` are
reserved in every scope. Built-in history is an implicit per-session store owned
by the request's session, never global, and always session-filtered. History
requires a matching persisted session-to-user binding and the server read
decision. Only the internal tool catalog bypasses that decision; its requests
still require a valid binding. Reads never create session bindings. Copying history to a user
collection is outside this release.

**Server duties and limits:** The host authenticates the user, supplies the trusted
resolver and `isAdmin`, implements the decision, and uses persistent access stores
from its catalog persistence. Request headers, prompts and tool arguments cannot
supply RAG role membership. The host must protect raw backend credentials and
out-of-band writes; direct storage access is outside these enforcement paths.
Custom stores must honor the mandatory owner contract. In-memory bindings and
roles do not survive restart. The CLI's `--local-user-id` test-helper mode is
explicit single-user local use only, not production authentication.

**Role lifecycle and backend limits:** Role deletion is refused while the role
owns collections. PostgreSQL and HANA use row locks; Qdrant uses catalog intent
and an immutable revision-chain CAS, with no persistent lock or timeout-based
recovery. Its revision chain grows without compaction. Qdrant requires strong
ordered writes, all-replica reads and full replica acknowledgements; insert-only
session binding points require Qdrant >= 1.17.0, but positive global filters have
no exact-version restriction. HANA reads all owner candidates before app-side
top-k, with a possible memory/latency cost. PostgreSQL was checked with PGlite;
HANA and Qdrant validation used mocks/fakes, not live services.

See [MIGRATION-v31.md](MIGRATION-v31.md) and
[Qdrant access persistence](../packages/qdrant-rag/README.md#collection-access-persistence).

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

**Session isolation of history.** History is logically an implicit per-session store, even when
physical storage is shared. Ownership comes from the request caller, with a mandatory positive
`ownerScope` tag and `sessionId` filter; history bypasses the server read decision. A custom `IRag` used as the history store
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

- Authentication and protection of direct, out-of-band backend access
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
