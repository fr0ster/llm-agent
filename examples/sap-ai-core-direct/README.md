# Direct llm-agent → MCP (with SAP destination header)

Local (non-docker) setup that starts `llm-agent` on port 4040, connects to an
MCP server (default `http://localhost:3001/mcp/stream/http`), and routes
requests with the `x-sap-destination: S4HANA_E19` header for downstream
reverse-proxy routing.

Uses **SAP AI Core** for both the LLM (Claude Sonnet 4.6) and the embedder
that drives tool-selection RAG.

## Prerequisites

- `.env` at repo root with at least:
  ```ini
  LLM_PROVIDER=sap-ai-sdk
  LLM_MODEL=anthropic--claude-4.6-sonnet
  AICORE_SERVICE_KEY={"clientid":"…","clientsecret":"…","url":"…","serviceurls":{"AI_API_URL":"…"}}
  ```
- A running MCP server on the URL referenced by `MCP_SERVER_URL` (default
  `http://localhost:3001/mcp/stream/http`). Typically `mcp-abap-adt`.
- The reverse-proxy / gateway that consumes `x-sap-destination` configured
  to know about the destination value (`S4HANA_E19` by default).

## Run

From repo root:

```bash
node packages/llm-agent-server/dist/smart-agent/cli.js \
  --config examples/sap-ai-core-direct/smart-server.yaml \
  --log-stdout
```

Override defaults via env vars:

```bash
PORT=5001 SAP_DESTINATION=S4HANA_DEV \
MCP_SERVER_URL=http://localhost:3001/mcp/stream/http \
node packages/llm-agent-server/dist/smart-agent/cli.js \
  --config examples/sap-ai-core-direct/smart-server.yaml \
  --log-stdout
```

## Test query

```bash
curl -s -X POST http://localhost:4040/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"anthropic--claude-4.6-sonnet",
    "stream":false,
    "messages":[
      {"role":"user","content":"Прочитай структуру таблиці T100"}
    ]
  }'
```

A correctly working setup should:
1. Translate the query to English for RAG retrieval (`ragTranslateEnabled`, on by default).
2. Retrieve the relevant MCP tool by semantic distance (e.g. `GetTable`/`GetTableContents`).
3. Call the tool with `x-sap-destination: S4HANA_E19` header.
4. Return T100 column metadata in the response.

## Why the embedder matters (and why no SAP classifier rules are needed)

Tool exposure is driven entirely by **RAG semantic distance** over the tools
store plus the configured tool-selection strategy (see `agent.toolSelection`
in `docs/PERFORMANCE.md`) — **not** by domain-specific classifier rules. SAP
queries reach the tools without any `prompts.classifier` override; that is why
this example no longer ships one.

What *does* matter: the `embedder` under `pipeline.rag.tools`. Without it the
in-memory toolsRag stays empty, no tool is within semantic range, and the
agent falls back to generic SQL-style answers (`DESCRIBE T100`, etc.). The
embedder is required for tool-calling to fire.
