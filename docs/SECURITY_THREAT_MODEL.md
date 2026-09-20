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

**Threat:** A caller's model names another caller's collection in a RAG collection tool and reads
or writes it. Distinct from AS-4, which is about records returned by `query`: this is about the
collection-management tools themselves.

**State: latent, not live.** `buildRagCollectionToolEntries` has no consumer — it is exported
from the barrel (`packages/llm-agent/src/rag/mcp-tools/index.ts`) and mounted by nothing in this
monorepo, and cloud-llm-hub does not use it either (it has its own `dispatchRagTool`). Nothing
exposes these handlers to a model today, so there is no exploitable path in any shipped assembly.
It is recorded because mounting them as they stand would create one.

**What is wrong as written** (`packages/llm-agent/src/rag/mcp-tools/rag-collection-tools.ts`):
five of seven handlers take the `RagToolContext` they are given and ignore it — `rag_add`
(`:61`), `rag_correct` (`:87`), `rag_deprecate` (`:128`), `rag_list_collections` (`:155`) and
`rag_describe_collection` (`:171`). They resolve any name against the registry they were built
with, so against a shared registry they reach every registered collection. `rag_create_collection`
(`:266`) and `rag_delete_collection` (`:200`, `:208`) do use the owner keys, and the latter also
refuses global deletes outright — that pair is the intended shape.

**Planned mitigation — construction, not a check.** Per architecture principle 8, the tool
entries are built with the caller's identity bound in, so the only collections they can address
are that caller's own and the globals; another caller's collection is absent rather than refused.
No access check enters the framework. Where addressing cannot answer — a `role`-authorized
global — the tools refuse, and a consumer that wants that case mounts its own.
Design: `docs/superpowers/specs/2026-09-16-auth-contracts-design.md` §5.1; workstream 3 (§10).

---

### AS-5: Denial-of-service via runaway tool loops

**Threat:** A malicious or buggy LLM repeatedly calls tools in an infinite loop, exhausting
server resources.

**Mitigation:** `SmartAgentConfig.maxIterations` and `maxToolCalls` hard-cap the tool loop.
`timeoutMs` aborts the entire pipeline via a merged `AbortSignal` after a wall-clock deadline.

---

## Known Limitations

| Limitation | Severity | Owner |
|------------|----------|-------|
| Injection detector uses fixed heuristics — novel patterns bypass detection | Medium | Consumer: complement with LLM-based moderation at the API gateway |
| Tool argument content is not inspected | Medium | MCP server / consumer |
| Namespace is consumer-supplied and not authenticated | Low–Medium | Consumer: enforce namespace derivation from authenticated session |
| `smartAgentEnabled=false` is not cryptographically enforced — a second instance can be created with `enabled=true` | Low | Consumer: do not instantiate SmartAgent when disabled |
| No rate limiting or request authentication at the library level | Medium | Consumer / API gateway |
| RAG collection tools ignore their `RagToolContext` (AS-6) — latent: nothing mounts them | Medium if mounted | Library: workstream 3 binds identity at construction |

---

## Out of Scope

- Multi-tenant storage isolation beyond namespace tagging
- LLM output moderation (hallucination, bias, harmful content)
- Network-level security (TLS, firewall rules, VPC isolation)
- Operational concerns (audit logging to SIEM, alert thresholds, incident response)

These are the responsibility of the consumer. See deployment documentation for guidance.
