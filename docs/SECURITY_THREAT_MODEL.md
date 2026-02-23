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

---

## Out of Scope

- Multi-tenant storage isolation beyond namespace tagging
- LLM output moderation (hallucination, bias, harmful content)
- Network-level security (TLS, firewall rules, VPC isolation)
- Operational concerns (audit logging to SIEM, alert thresholds, incident response)

These are the responsibility of the consumer. See deployment documentation for guidance.
