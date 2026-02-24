# Smart Orchestrated Agent Architecture

## Purpose
The agent accepts requests through an OpenAI-compatible protocol and orchestrates decomposition, memory enrichment, MCP tool execution, and final response generation while keeping the active context window minimal and controlled.

## Core Principles
- Interface-first design: the orchestrator depends only on contracts.
- Memory by intent type: facts, feedback, state, and tool knowledge are retrieved selectively.
- Priority-based processing: the default pipeline applies `fact > feedback > state > action` priority and makes facts from the current request available to the current action immediately. Custom pipelines may define their own processing order and decide whether facts affect the current action or only future requests.
- Iterative tool loop: execute MCP tools only when requested by the main LLM.
- Last-frame context strategy: only relevant data is assembled for each reasoning step.

## Core Interfaces
- `ILlm`: generic LLM chat/completion contract.
- `IMcpClient`: tool catalog + tool invocation abstraction (all MCP transport details hidden).
- `IRag`: vector storage/retrieval contract for semantic memory.
- `ISubpromptClassifier`: split and tag user input into subprompts.
- `IContextAssembler`: compose final reasoning context from retrieval + runtime artifacts.

## Dependency Injection Model
The agent constructor accepts:
- one `mainLlm` for final reasoning and tool-use decisions,
- multiple helper LLMs for specialized preprocessing,
- one or many `IMcpClient` implementations,
- one or many `IRag` implementations (optional for tool selection — see below).

The project provides reference implementations for these interfaces. Consumers can inject custom implementations when needed, as long as they follow the same contracts.

### Optional tool vectorization via IRag
MCP tool selection is opt-in:
- **Without an `IRag` for tools**: the full tool catalog from all connected `IMcpClient` instances is passed directly into the context frame. Simple and deterministic.
- **With an `IRag` for tools**: the consumer pre-vectorizes tool descriptions and injects the store. Candidate tool selection becomes a semantic search against that store — deterministic from the consumer's perspective because they control what is vectorized and how.

Consumers who inject their own `IRag` for tools take responsibility for the quality and coverage of the vectorized descriptions.

## Subprompt Taxonomy
- `fact`: important knowledge to remember.
- `feedback`: correction about prior agent behavior.
- `state`: contextual preference/constraint (not an immediate task).
- `action`: immediate executable request.

## Request Lifecycle
1. Receive request (OpenAI-compatible API).
2. Split + classify into typed subprompts.
3. Process by priority.
4. Persist `fact` / `feedback` / `state` into corresponding `IRag` stores.
5. For `action`, retrieve relevant tools, facts, feedback, and state.
6. Build a compact context frame.
7. Call `mainLlm`.
8. If response contains a tool call, execute via `IMcpClient`, append tool result to context, and repeat.
9. Return final non-tool response to the consumer.

## Context Frame Contents
- current action intent,
- retrieved facts,
- retrieved feedback,
- retrieved state,
- candidate MCP tools,
- accumulated tool results,
- runtime constraints (`maxIterations`, token/time limits).

## Operational Constraints
- bounded tool loop (`maxIterations`, timeout, max tool calls),
- deduplication and semantic idempotency for memory ingestion,
- tracing and observability for decomposition, retrieval hits, tool calls, and final output.

## Accepted Risks

These risks are inherent to LLM usage and cannot be eliminated architecturally. They are accepted consciously. Mitigation relies on model parameters and helper LLM prompt quality; stronger approaches will be defined as experience accumulates.

### Classifier error
`ISubpromptClassifier` is itself an LLM call and can misclassify subprompts. An `action` stored as a `fact`, or `feedback` routed to the wrong RAG layer, produces silent incorrect behavior. Mitigation: low temperature on the helper LLM, a narrow and unambiguous classifier prompt, a small and well-separated taxonomy.

### Silent RAG miss for fact/feedback/state
A poor embedding match produces no error — the agent simply acts without the relevant knowledge and the LLM fills the gap with parametric memory. For MCP tool selection this risk is eliminated when the consumer pre-vectorizes tool descriptions. For accumulated memory (`fact`, `feedback`, `state`) it is unavoidable. Mitigation: low temperature on `mainLlm`, similarity threshold tuning in `IRag`, prompts that instruct the model to acknowledge missing knowledge rather than invent it.

## Testing Strategy
Because every component is behind an interface, each layer can be tested in isolation:
- Replace any one implementation with a deterministic test double (fixed responses, predictable retrieval results) while keeping the rest as real or other test implementations.
- To validate a specific real implementation (e.g. a concrete `IRag`), inject only that one as real; everything else stays as a test double.
- No full infrastructure stack is required to test any single component.

This means reproducible, deterministic tests are a natural consequence of the DI model — not a special testing effort.

## Reference Implementation Responsibilities
The following concerns are intentionally delegated to concrete implementations. The reference implementations provided with the project address all of them; consumers who supply their own implementations take responsibility for these decisions themselves.

| Concern | Resolved in |
|---------|-------------|
| TTL and eviction of stale facts | `IRag` implementation |
| Conflict resolution when a new fact contradicts an existing one | `IRag` implementation or a strategy such as `IResolveFactConflictStrategy` |
| Subprompt processing order and whether a fact from the current request affects the current action or only future ones | Pipeline implementation (default: `fact > feedback > state > action`; fact available to current action immediately) |
| Semantic tool selection from a large catalog | Optional `IRag` for tools; without it the full catalog is used |
| Convergence criteria for early exit from the tool loop | Orchestrator or `IConvergenceStrategy` |
| Pipeline latency optimization (parallel RAG queries, parallel tool execution, classifier caching) | Default pipeline implementation; custom pipelines decide for themselves |
| Streaming: whether to use it and which kind | Pipeline decision: no streaming (return complete response), streaming (emit chunks as each subprompt and tool result completes), or event-based (typed events per step). SSE is already in the stack via MCP transport. See [`STREAMING_TOOL_LOOP_ANALYSIS.md`](./STREAMING_TOOL_LOOP_ANALYSIS.md). |
| Memory store size limits and eviction policy | `IRag` implementation |
| Cross-session user identity for personalized retrieval | `IRag` implementation + session context |
| Multi-turn conversational coherence | `IContextAssembler` + fact persistence strategy |
