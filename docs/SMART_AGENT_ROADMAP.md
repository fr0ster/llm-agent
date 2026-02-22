# Smart Orchestrated Agent - Implementation Roadmap

Draft roadmap based on [`SMART_AGENT_ARCHITECTURE.md`](./SMART_AGENT_ARCHITECTURE.md).

---

## Phase 1 - Contracts (`src/smart-agent/interfaces/`)

- [ ] `ILlm` - chat/completion: `chat(messages, tools?) → LLMResponse`
- [ ] `IMcpClient` - `listTools() → Tool[]`, `callTool(name, args) → ToolResult`
- [ ] `IRag` - `upsert(text, metadata)`, `query(text, k) → RagResult[]`
- [ ] `ISubpromptClassifier` - `classify(text) → Subprompt[]` (types: `fact | feedback | state | action`)
- [ ] `IContextAssembler` - `assemble(action, retrieved, toolResults) → ContextFrame`
- [ ] Shared types: `Subprompt`, `ContextFrame`, `RagResult`, `AgentConfig`

---

## Phase 2 - Existing Code Adapters (`src/smart-agent/adapters/`)

- [ ] `LlmAdapter` - wraps existing `BaseAgent` subclasses into `ILlm`
- [ ] `McpClientAdapter` - wraps `MCPClientWrapper` into `IMcpClient`

Goal: the new architecture should not duplicate provider HTTP logic, but reuse the existing layer.

---

## Phase 3 - Reference `IRag` Implementation (`src/smart-agent/rag/`)

- [ ] In-memory vector store with cosine similarity (separate instances for fact/feedback/state/tools)
- [ ] Semantic deduplication on `upsert`: if a similar record already exists, update it instead of duplicating
- [ ] TTL field in metadata; `query` filters out expired records

---

## Phase 4 - `ISubpromptClassifier` (`src/smart-agent/classifier/`)

- [ ] LLM-based classifier: system prompt with taxonomy, low temperature
- [ ] Input: one user message → array of `Subprompt` with type and text
- [ ] Cache the result for identical text within the request scope

---

## Phase 5 - `IContextAssembler` (`src/smart-agent/context/`)

- [ ] Builds `ContextFrame`: `action` + retrieved `facts` + `feedback` + `state` + `tools` + `toolResults`
- [ ] Produces final `messages[]` array for `mainLlm.chat()`
- [ ] Token limit: drops least-relevant entries if the frame exceeds the limit

---

## Phase 6 - `SmartAgent` Orchestrator (`src/smart-agent/agent.ts`)

- [ ] DI constructor: `mainLlm`, `helperLlm`, `mcpClients[]`, `ragStores`, `classifier`, `assembler`, `config`
- [ ] Single-request pipeline:
  - [ ] Classification → subprompt array
  - [ ] `fact/feedback/state` → `IRag.upsert()` into corresponding stores
  - [ ] `action` → `IRag.query()` for facts/feedback/state/tools → `IContextAssembler.assemble()`
  - [ ] Call `mainLlm.chat()` → tool loop (max `config.maxIterations`)
  - [ ] Return final text response
- [ ] Bounded tool loop: `maxIterations`, timeout - completes the request even if LLM keeps asking for tools

---

## Phase 7 - OpenAI-Compatible HTTP Server (`src/smart-agent/server.ts`)

- [ ] `POST /v1/chat/completions` - accepts standard OpenAI format, returns `SmartAgent.process()`
- [ ] Support `stream: false` (MVP); streaming comes separately after stabilization

---

## Phase 8 - Observability

- [ ] Structured log at each step: classification, RAG hits/misses, tool calls, summary
- [ ] `DEBUG_SMART_AGENT=true` in `.env` enables detailed output
- [ ] Should not block release - minimal implementation is enough for debugging

---

## Phase 9 - Tests

- [ ] Test doubles for each interface (deterministic responses)
- [ ] Component isolation test: replace only one real implementation, keep the rest as test doubles
- [ ] End-to-end pipeline smoke test via embedded MCP + stub LLM
