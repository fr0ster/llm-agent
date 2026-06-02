// llm-agent-server is a binary package (CLI + HTTP server).
// The SmartServer composition runtime lives in @mcp-abap-adt/llm-agent-server-libs;
// it is re-exported here for back-compat.
// For SmartAgent composition, depend on @mcp-abap-adt/llm-agent-libs.
// For interfaces and DTOs, depend on @mcp-abap-adt/llm-agent.
// For MCP-only use cases, depend on @mcp-abap-adt/llm-agent-mcp.
// For RAG/embedder-only use cases, depend on @mcp-abap-adt/llm-agent-rag.
export * from '@mcp-abap-adt/llm-agent-server-libs';
