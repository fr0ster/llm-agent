# @mcp-abap-adt/llm-agent

Core interfaces, types, and lightweight default implementations for LLM agent orchestration.

This package is the abstraction layer consumed by `@mcp-abap-adt/llm-agent-server` and by downstream applications that want to build their own agent on our interfaces. It ships:

- All `I*` interfaces (IRag, IRagEditor, IRagProvider, IRagRegistry, ILlm, IMcpClient, IPipeline, etc.)
- Shared types (Message, ToolCall, RagMetadata, CallOptions, Result, errors)
- Lightweight RAG implementations (InMemoryRag, VectorRag, QdrantRag, InMemoryRagProvider, VectorRagProvider, QdrantRagProvider, SimpleRagRegistry, SimpleRagProviderRegistry, edit strategies, id strategies, corrections module, overlay rags, MCP tool factory)

For the full default agent (SmartAgent, pipeline, LLM providers, MCP client, HTTP server, CLI), install `@mcp-abap-adt/llm-agent-server`.

See the repo root for design specs, migration notes, and architectural docs.
