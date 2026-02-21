# Smart Orchestrated Agent Architecture

## Purpose
The agent accepts requests through an OpenAI-compatible protocol and orchestrates decomposition, memory enrichment, MCP tool execution, and final response generation while keeping the active context window minimal and controlled.

## Core Principles
- Interface-first design: the orchestrator depends only on contracts.
- Memory by intent type: facts, feedback, state, and tool knowledge are retrieved selectively.
- Priority-based processing: `fact > feedback > state > action`.
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
- one or many `IRag` implementations.

The project provides reference implementations for these interfaces. Consumers can inject custom implementations when needed, as long as they follow the same contracts.

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
