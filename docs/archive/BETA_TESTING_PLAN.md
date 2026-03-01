# Beta Testing Plan

Covers manual verification scenarios for the SmartAgent / SmartServer stack before the `main`
branch merge. Each scenario is independent and can be run by a tester with access to the relevant
services.

---

## Prerequisites

- Node.js >= 18 installed
- `npm install -g @mcp-abap-adt/llm-agent` (or built from source: `npm run build`)
- At least one LLM API key (`DEEPSEEK_API_KEY` or `OPENAI_API_KEY`)
- Ollama running locally with `nomic-embed-text` pulled (scenarios marked **[ollama]**)
- An MCP server reachable over HTTP or stdio (scenarios marked **[mcp]**)

---

## T1 — First-Run Config Generation

**Goal:** Verify that `llm-agent` auto-generates `smart-server.yaml` and exits gracefully on first
run in a directory with no config.

Steps:
1. Create an empty directory and `cd` into it.
2. Run `llm-agent`.
3. Confirm the process exits with a message and creates `smart-server.yaml`.
4. Inspect the generated file — it must contain all top-level sections with comments.

Pass criteria:
- `smart-server.yaml` created, non-empty, contains `pipeline:` example (commented)
- Process exited with code 0 and printed a helpful message

---

## T2 — Minimal Startup (in-memory RAG, no MCP)

**Goal:** Server starts and responds with no external dependencies.

Setup `.env`:
```dotenv
DEEPSEEK_API_KEY=sk-xxx
```

Setup `smart-server.yaml`:
```yaml
port: 3001
mode: smart
llm:
  apiKey: ${DEEPSEEK_API_KEY}
  model: deepseek-chat
rag:
  type: in-memory
```

Steps:
1. Run `llm-agent`.
2. Confirm `listening on http://0.0.0.0:3001` in stderr.
3. `curl -s http://localhost:3001/v1/models` — must return `smart-agent`.
4. Send a chat request:
   ```bash
   curl -s http://localhost:3001/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"Hello"}]}'
   ```
5. Confirm a non-empty response with `finish_reason: "stop"`.

Pass criteria: server starts, `/v1/models` and `/v1/chat/completions` respond correctly.

---

## T3 — Hybrid Mode: Cline Passthrough vs. SmartAgent **[ollama]** **[mcp]**

**Goal:** Verify that `hybrid` mode routes Cline requests to passthrough and others to SmartAgent.

Setup `smart-server.yaml`:
```yaml
mode: hybrid
llm:
  apiKey: ${DEEPSEEK_API_KEY}
mcp:
  type: http
  url: http://localhost:3000/mcp/stream/http
```

Steps:
1. Start `llm-agent`.
2. Send a request with a Cline-style system message (`You are Cline...`). Check the log file for
   `"mode":"passthrough"`.
3. Send a plain request without a system message. Check the log for `"mode":"smart"`.

Pass criteria: log shows correct routing for each request type.

---

## T4 — Multi-MCP Array **[mcp]**

**Goal:** Tools from two MCP servers are vectorized and available for RAG-based selection.

Setup `smart-server.yaml`:
```yaml
llm:
  apiKey: ${DEEPSEEK_API_KEY}
rag:
  type: in-memory
pipeline:
  mcp:
    - type: http
      url: http://first-server/mcp/stream/http
    - type: http
      url: http://second-server/mcp/stream/http
```

Steps:
1. Start `llm-agent`.
2. Inspect `smart-server.log` — confirm connection and tool-vectorization log entries for both
   servers.
3. Send a query that requires a tool from the second server.
4. Confirm the tool is selected and executed.

Pass criteria: tools from both servers appear in the log; tool call uses the correct server.

---

## T5 — Pipeline: Different LLM Providers for Main and Classifier

**Goal:** Verify that `pipeline.llm.main` and `pipeline.llm.classifier` use independent providers.

Setup `.env`:
```dotenv
DEEPSEEK_API_KEY=sk-xxx
OPENAI_API_KEY=sk-yyy
```

Setup `smart-server.yaml`:
```yaml
rag:
  type: in-memory
pipeline:
  llm:
    main:
      provider: deepseek
      apiKey: ${DEEPSEEK_API_KEY}
      model: deepseek-chat
    classifier:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
```

Steps:
1. Start `llm-agent`.
2. Send a request that requires classification (e.g. a mixed fact + action message).
3. Inspect the log — confirm classifier calls are attributed to the OpenAI provider (different
   `model` field in usage) and main LLM calls to DeepSeek.

Pass criteria: two different models visible in logs for the same request lifecycle.

---

## T6 — Pipeline-Only Config (no flat `llm:` block)

**Goal:** Verify that the flat `llm:` block is not required when `pipeline.llm.main` is present.

Setup `smart-server.yaml`:
```yaml
port: 3001
mode: smart
rag:
  type: in-memory
pipeline:
  llm:
    main:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      model: gpt-4o-mini
```

Steps:
1. Ensure `DEEPSEEK_API_KEY` is NOT set in the environment.
2. Run `llm-agent`.
3. Confirm the server starts without an "API key required" error.
4. Send a chat request and confirm a valid response.

Pass criteria: server starts and responds using OpenAI, no error about missing DeepSeek key.

---

## T7 — Per-Store RAG Configuration **[ollama]**

**Goal:** Verify that `facts`, `feedback`, and `state` can use independent RAG backends.

Setup `smart-server.yaml`:
```yaml
llm:
  apiKey: ${DEEPSEEK_API_KEY}
pipeline:
  rag:
    facts:
      type: ollama
      url: http://localhost:11434
      model: nomic-embed-text
    feedback:
      type: in-memory
    state:
      type: in-memory
```

Steps:
1. Start `llm-agent`.
2. Send a message containing a fact (`Remember that X = Y`).
3. Send a follow-up action that would benefit from that fact.
4. Inspect the log for `rag_query` events on the `facts` store — confirm Ollama is used.

Pass criteria: no startup errors; log shows `facts` store queries going to Ollama.

---

## T8 — Token Usage Endpoint

**Goal:** Verify `/v1/usage` returns accumulated token counts after requests.

Steps:
1. Start server with any config.
2. Send 2–3 chat requests.
3. `curl http://localhost:3001/v1/usage`
4. Confirm non-zero `prompt_tokens`, `completion_tokens`, `total_tokens`, `requests`.

Pass criteria: usage endpoint returns incrementing counts after each request.

---

## T9 — CLI Flag Overrides

**Goal:** CLI flags take precedence over YAML values.

Steps:
1. Create `smart-server.yaml` with `port: 3001`.
2. Run `llm-agent --port 3099 --rag-type in-memory`.
3. Confirm server listens on 3099, not 3001.

Pass criteria: `llm-agent listening on http://0.0.0.0:3099`.

---

## T10 — Streaming Response

**Goal:** Verify SSE streaming works for `stream: true` requests.

Steps:
1. Start server.
2. Send a streaming request:
   ```bash
   curl -N http://localhost:3001/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"Count to 5"}],"stream":true}'
   ```
3. Confirm `data: {...}` chunks arrive, ending with `data: [DONE]`.

Pass criteria: streaming chunks received, connection closes cleanly after `[DONE]`.

---

## T11 — IDE Integration (Cline / Cursor / Continue)

**Goal:** End-to-end: IDE client connects, sends a real task, agent responds.

Steps:
1. Configure the IDE with Base URL `http://localhost:3001/v1`, model `smart-agent`.
2. Open a project and ask a question that requires MCP tools.
3. Confirm the agent responds with tool-augmented content.
4. Check `smart-server.log` for the full pipeline trace: classify → rag_query → tool_call →
   pipeline_done.

Pass criteria: coherent response from the IDE; full trace visible in log.
