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
1. Classify the query as `action / sap-abap` (per the classifier prompt).
2. Translate it for RAG retrieval.
3. Retrieve the relevant MCP tool (e.g. `GetTable`/`GetTableContents`).
4. Call the tool with `x-sap-destination: S4HANA_E19` header.
5. Return T100 column metadata in the response.

## Why the classifier prompt matters

Without the explicit "knowledge → action" reclassification in
`prompts.classifier`, the agent treats SAP queries as plain chat, skips the
RAG retrieval stage, never sees the MCP tools, and falls back to generic
SQL-style answers (`DESCRIBE T100`, etc.).

Without an `embedder` block under `pipeline.rag.tools`, the in-memory
toolsRag stays empty — same outcome.

Both are required for tool-calling to actually fire.
