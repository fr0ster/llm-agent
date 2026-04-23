# @mcp-abap-adt/sap-aicore-llm

SAP AI Core LLM provider for @mcp-abap-adt/llm-agent / @mcp-abap-adt/llm-agent-server.

Exports:
- `SapCoreAIProvider` — implements ILlm, calls SAP AI Core orchestration API.
- `SapCoreAIConfig` — configuration type.

Optional peer dependency. Install when smart-server.yaml names `sap-ai-sdk` or `sap-core-ai` as LLM provider, or when constructing SapCoreAIProvider programmatically.
