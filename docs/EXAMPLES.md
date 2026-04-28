# Examples

This document contains usage examples aligned with the current Smart Agent implementation.
YAML config examples are in [`docs/examples/`](examples/) as standalone files you can use directly.

## How the Agent Works

Understanding the data flow helps choose the right config.

```
STARTUP
  MCP server(s) connected
  → each tool's name + description + schema vectorized into tools RAG store
  → metadata: { id: "tool:TOOL_NAME" }
  Skills discovered (if ISkillManager configured)
  → each skill's name + description vectorized into tools RAG store
  → metadata: { id: "skill:SKILL_NAME" }

PER REQUEST (DefaultPipeline)
  User message
    ↓
  Classify → split into typed subprompts:
    action:   "read table T100"             → drives the tool loop
    chat:     "thanks!"                      → just reply
    ↓
  Summarize → condense conversation history if too long
    ↓
  RAG Retrieval (parallel, if stores configured):
    ├─ query tools   → MCP tool descriptions + skill descriptions
    └─ query history → semantic conversation history (if historyRag set)
    ↓
  Rerank → re-score RAG results by relevance
    ↓
  Tool Select  → extract tool:XXX IDs from tools results → select matching MCP tools
  Skill Select → extract skill:XXX IDs from tools results → load matching skill content
    ↓
  Assemble → build LLM context: actions + tool/history RAG results + selected tools + history
           → append skill content as "## Active Skills" section in system message
    ↓
  Tool Loop → streaming LLM call → execute MCP tools → loop until done
    ↓
  History Upsert → summarize turn, upsert to history RAG store (if historyRag set)
```

> **Consumer-defined RAG**: the DefaultPipeline uses `tools` and `history` stores by default.
> You can attach additional RAG stores at runtime without a custom `IPipeline` by calling
> `agent.addRagStore(name, store)` and `agent.removeRagStore(name)` between requests.
> For full control over pipeline orchestration, implement a custom `IPipeline`.

## YAML Config Examples

### Simple (flat) configs — hardcoded orchestration flow

| File | Description |
|---|---|
| [`01-minimal-inmemory.yaml`](examples/01-minimal-inmemory.yaml) | Minimal start — DeepSeek + in-memory RAG, no MCP |
| [`02-ollama-mcp.yaml`](examples/02-ollama-mcp.yaml) | Ollama embeddings + MCP tools |
| [`03-multi-model.yaml`](examples/03-multi-model.yaml) | Separate classifier/helper models + Qdrant RAG |
| [`12-deepseek-mcp.yaml`](examples/12-deepseek-mcp.yaml) | **Full options reference** — DeepSeek + Ollama RAG + MCP with all agent knobs and commented advanced sections (multi-model pipeline, structured stages, custom prompts) |

### Structured pipeline configs — YAML-defined stage tree

| File | Description |
|---|---|
| [`04-structured-default.yaml`](examples/04-structured-default.yaml) | DefaultPipeline flow as explicit YAML (tools + history stores) |
| [`05-structured-minimal.yaml`](examples/05-structured-minimal.yaml) | Minimal pipeline — no RAG, just classify + assemble + tool-loop |
| [`06-structured-multi-model.yaml`](examples/06-structured-multi-model.yaml) | Multi-model + Qdrant tools store + higher tool limits |
| [`07-structured-sap-ai-core.yaml`](examples/07-structured-sap-ai-core.yaml) | SAP AI Core provider with structured pipeline |
| [`08-real-world-scenario.yaml`](examples/08-real-world-scenario.yaml) | **Full real-world scenario** with detailed comments explaining tool vectorization, classification, and tool selection |
| [`09-parallel-optimized.yaml`](examples/09-parallel-optimized.yaml) | **Parallel-optimized** — summarize ‖ RAG queries run in parallel |
| [`10-plugins.yaml`](examples/10-plugins.yaml) | **Plugin-extended** — loads custom stage handlers from a plugin directory |
| [`11-skills.yaml`](examples/11-skills.yaml) | **Agent Skills** — discovers SKILL.md files and injects skill context into LLM prompt via RAG selection |

### Running a YAML config

```bash
# Set required env variables, then:
npm run dev -- --config docs/examples/04-structured-default.yaml
```

OpenAI-compatible endpoint: `http://localhost:4004/v1/chat/completions`

## Simple vs structured pipeline — comparison

| Feature | Simple (flat YAML) | Structured pipeline |
|---|---|---|
| Config location | `llm:`, `rag:`, `mcp:`, `agent:` top-level keys | `pipeline:` section with `version` + `stages` |
| Orchestration flow | DefaultPipeline (tools + history stores) | YAML-defined stage tree |
| Stage ordering | Fixed | Fully customizable |
| Parallel stages | Fixed internal parallelism | Explicit `parallel` type with `after` |
| Custom stages | Not possible | `withStageHandler()` + YAML reference |
| Conditional stages | `agent.classificationEnabled` | `when` expressions on any stage |
| Loops | Fixed tool loop | `repeat` type with `until` + `maxIterations` |
| Custom RAG stores | Not possible | Implement custom `IPipeline` |
| Best for | Simple setups, quick start | Complex orchestration, consumer-defined pipelines |

**Without `pipeline.stages`** — `DefaultPipeline` runs (tools + history stores only).

**With `pipeline.stages`** — the executor replaces DefaultPipeline entirely.

**With custom `IPipeline`** — inject via `.setPipeline(myPipeline)` for full control.

## Programmatic Examples

### Dynamic RAG stores

`DefaultPipeline` supports adding and removing custom RAG stores between requests without replacing
the pipeline. Use this to attach domain knowledge bases, user-specific indexes, or session-scoped
stores on demand:

```typescript
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-server';

const agent = await new SmartAgentBuilder()
  .withMainLlm(myLlm)
  .setMcpClients([mcp])
  .setToolsRag(myToolsRag)
  .build();

// Add a custom knowledge base between requests
agent.addRagStore('product-kb', myQdrantRag);

// Remove when no longer needed
agent.removeRagStore('product-kb');
```

The added store is queried in parallel with `tools` and `history` stores during the RAG retrieval
stage. Removing it stops it from being queried on subsequent requests.

### Dynamic RAG collections with a provider (v9.1+)

Use `QdrantRagProvider` so the LLM can create session-scoped collections on demand, store phase
results, correct errors, and let the consumer clean up on disconnect:

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-server';
import { QdrantRagProvider, buildRagCollectionToolEntries } from '@mcp-abap-adt/llm-agent';

// 1. Build agent with a Qdrant provider
const { agent } = await new SmartAgentBuilder({ /* ... */ })
  .withMainLlm(myLlm)
  .addRagProvider(new QdrantRagProvider({
    name: 'qdrant-rw',
    url: 'http://qdrant:6333',
    apiKey: process.env.QDRANT_API_KEY,
    embedder: myEmbedder,
  }))
  .build();

// 2. Register MCP tool handlers on your own MCP server
//    (llm-agent does not host an embedded MCP server for RAG editing)
const entries = buildRagCollectionToolEntries({ registry, providerRegistry });
myMcpServer.registerTools(entries);

// 3. LLM creates a session-scoped collection via MCP:
//      rag_create_collection({ provider: 'qdrant-rw', name: 'phase-results', scope: 'session' })
//    Adds facts during the session:
//      rag_add({ collection: 'phase-results', text: 'Phase 1 complete: 3 items processed' })
//    Corrects errors:
//      rag_correct({ collection: 'phase-results', id: '...', text: 'Corrected: 2 items processed' })

// 4. Consumer closes the session on disconnect — flushes session-scoped collections + history
await agent.closeSession(sessionId);
```

### Programmatic embedding (`SmartAgentBuilder`)

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

const handle = await new SmartAgentBuilder()
  .withMainLlm({
    provider: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    model: 'deepseek-chat',
    temperature: 0.7,
  })
  .withRag({ type: 'in-memory' })
  .build();

process.on('SIGTERM', async () => {
  await handle.close();
});
```

### Custom embedder injection

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';

const handle = await new SmartAgentBuilder()
  .withMainLlm({ provider: 'deepseek', apiKey: process.env.DEEPSEEK_API_KEY! })
  .withRag({ type: 'qdrant', url: 'http://qdrant:6333', embedder: 'sap-ai-sdk' })
  .withEmbedderFactories({
    'sap-ai-sdk': (cfg) => new SapAiCoreEmbedder({ model: cfg.model }),
  })
  .build();
```

### Structured pipeline with custom stage handler

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent-libs';
import type { IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent-libs';
import type { ISpan } from '@mcp-abap-adt/llm-agent';

class AuditLogHandler implements IStageHandler {
  async execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan): Promise<boolean> {
    const level = (config.level as string) ?? 'info';
    console.log(`[${level}] Processing: ${ctx.inputText.slice(0, 100)}`);
    return true;
  }
}

const handle = await new SmartAgentBuilder()
  .withConfigPath('smart-server.yaml')
  .withStageHandlers({ 'audit-log': new AuditLogHandler() })
  .build();
```

Then reference in YAML (see [`04-structured-default.yaml`](examples/04-structured-default.yaml) and add):

```yaml
pipeline:
  version: "1"
  stages:
    - id: audit
      type: audit-log
      config: { level: info }
    - id: classify
      type: classify
    # ... rest of stages
```

### Skills — programmatic setup

```ts
import {
  SmartAgentBuilder,
  ClaudeSkillManager,
  FileSystemSkillManager,
} from '@mcp-abap-adt/llm-agent-server';

// Option 1: Claude-convention directories (~/.claude/skills/ + <project>/.claude/skills/)
const builder = new SmartAgentBuilder()
  .withMainLlm(myLlm)
  .setMcpClients([mcp])
  .setToolsRag(myRag)   // skills are vectorized into the tools RAG store
  .withSkillManager(new ClaudeSkillManager(process.cwd()));

// Option 2: Custom directories
const builder2 = new SmartAgentBuilder()
  .withMainLlm(myLlm)
  .setToolsRag(myRag)
  .withSkillManager(new FileSystemSkillManager([
    '/opt/shared-skills',
    './my-project-skills',
  ]));

// Skills are automatically vectorized into the tools RAG store at build() time.
// The skill-select pipeline stage handles RAG-based selection and content loading.
const handle = await builder.build();
```

### SKILL.md format

Each skill is a subdirectory containing a `SKILL.md` file with optional YAML frontmatter:

```
.claude/skills/
├── code-review/
│   └── SKILL.md          ← skill content + frontmatter metadata
├── sap-abap/
│   ├── SKILL.md
│   └── examples/         ← supporting resources (available via ISkill.readResource)
│       └── patterns.md
└── commit-style/
    └── SKILL.md
```

**SKILL.md example:**

```markdown
---
name: code-review
description: Guidelines for reviewing pull requests
user-invocable: true
argument-hint: "<PR number or diff>"
allowed-tools:
  - gh_pr_view
  - gh_pr_diff
---

Review the code change with focus on:
1. Security vulnerabilities
2. Performance regressions
3. Test coverage gaps

Use $ARGUMENTS as the target to review.
Reference files are in $CLAUDE_SKILL_DIR/examples/.
```

**Frontmatter fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Skill identifier (defaults to directory name) |
| `description` | `string` | Used for RAG matching — be descriptive |
| `user-invocable` | `boolean` | Whether the user can invoke directly |
| `argument-hint` | `string` | Hint for user invocation arguments |
| `allowed-tools` | `string[]` | MCP tools this skill is allowed to use |
| `disable-model-invocation` | `boolean` | Prevent model from auto-selecting this skill |
| `model` | `string` | Preferred model for this skill |
| `context` | `'inline' \| 'fork'` | How content is injected |

**Placeholders** (substituted at runtime):
- `$ARGUMENTS` — replaced with user-provided arguments
- `$CLAUDE_SKILL_DIR` — replaced with skill directory path

### Skill manager types

| Manager | Discovery directories | Use case |
|---------|----------------------|----------|
| `ClaudeSkillManager` | `~/.claude/skills/` + `<project>/.claude/skills/` | Claude Code convention |
| `CodexSkillManager` | `~/.agents/skills/` + `<project>/.agents/skills/` | Codex/OpenAI convention |
| `FileSystemSkillManager` | Custom `dirs[]` | Any directory layout |

**YAML config:**

```yaml
# Claude convention (default)
skills:
  type: claude

# Codex convention
skills:
  type: codex

# Custom directories
skills:
  type: filesystem
  dirs:
    - /opt/shared-skills
    - ./my-project-skills
```

### Testing skills

**1. Start the server with a skills-enabled config:**

```bash
npm run dev -- --config docs/examples/11-skills.yaml
```

This example uses `FileSystemSkillManager` pointing to `docs/examples/skills/` which contains a bundled test skill (`pirate-greeting`).

**2. Send a request that should match the skill:**

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello, greet me like a pirate!"}]}'
```

**3. Verify skill injection in session logs:**

Look for these log entries:
- `skill_select_rag_fallback` — dedicated RAG query found skill matches
- `skills_selected` — lists selected skills and their names
- The LLM response should reflect the skill's instructions (e.g., pirate-style greeting)

**Note:** Skill discovery requires an embedder (e.g., Ollama) for semantic matching. BM25 keyword matching (in-memory without embedder) may not match skills if the user query doesn't contain the skill's exact keywords.

### Custom pipeline implementation

```ts
import type { IPipeline, PipelineDeps, PipelineResult, CallOptions, LlmStreamChunk } from '@mcp-abap-adt/llm-agent-server';
import { SmartAgentBuilder, DefaultPipeline } from '@mcp-abap-adt/llm-agent-server';

// Extend the default pipeline by wrapping it
class AuditedPipeline implements IPipeline {
  private inner = new DefaultPipeline();

  initialize(deps: PipelineDeps): void {
    this.inner.initialize(deps);
  }

  async execute(input, history, options, yieldChunk): Promise<PipelineResult> {
    console.log('[audit] request start');
    const result = await this.inner.execute(input, history, options, yieldChunk);
    console.log('[audit] request end');
    return result;
  }
}

const handle = await new SmartAgentBuilder()
  .withMainLlm(llm)
  .setMcpClients([mcp])
  .setToolsRag(myRag)
  .setPipeline(new AuditedPipeline())
  .build();
```

## External tools validation mode

```yaml
agent:
  externalToolsValidationMode: strict
```

`strict`: reject invalid `tools` payload with `400 invalid_request_error`.
`permissive` (default): drop invalid tools and continue.

## Test doubles for consumer integration tests

```ts
import { makeLlm, makeMcpClient, makeRag } from '@mcp-abap-adt/llm-agent-libs/testing';

const llm = makeLlm([{ content: 'ok' }]);
const rag = makeRag();
const mcp = makeMcpClient([{ name: 'Ping', description: 'health', inputSchema: { type: 'object', properties: {} } }]);
```

## Interactive text client

Interactive terminal chat with streaming responses and session persistence.
Maintains conversation history — the agent remembers what you said earlier in the session.

**Start the server** (in a separate terminal):

```bash
npm run dev -- --config docs/examples/09-parallel-optimized.yaml
```

**Run the text client:**

```bash
npm run client:text
```

**Example session:**

```
SmartAgent text client
Server:  http://127.0.0.1:4004
Session: a1b2c3d4-...
Commands: /clear /session /exit

> List available MCP tools
[Agent queries tools RAG → finds matching tool descriptions]
[Agent selects relevant tools → streams result]
Available tools: read_table, se16n_display, ...

> Show content of T100
[Agent queries tools RAG → finds se16n_display, read_table]
[Agent calls MCP → streams result]
Contents of T100: ...

> /clear
History cleared.

> /exit
Bye.
```

Set `PORT` or `SESSION_ID` env variables to override defaults:

```bash
PORT=5000 SESSION_ID=my-session npm run client:text
```

## Stream test client

A lightweight single-shot SSE client for testing streaming. Sends one message and prints the streamed response.

```bash
npm run client:test-stream
npm run client:test-stream -- "Which MCP tools are available?"
PORT=5000 npm run client:test-stream
```

## Connecting OpenAI-compatible clients

SmartServer exposes an OpenAI-compatible API at `http://localhost:4004/v1/chat/completions`, so any client that supports the OpenAI protocol can connect to it as a custom provider.

**Start the server:**

```bash
npm run dev
```

### Goose (Block)

In Goose settings, add a custom provider:

- **Provider**: `OpenAI API Compatible`
- **API Base URL**: `http://localhost:4004/v1`
- **API Key**: any non-empty string (SmartServer has no auth by default)
- **Model**: `smart-agent`

### Continue (VS Code / JetBrains)

In `~/.continue/config.yaml`:

```yaml
models:
  - name: SmartAgent
    provider: openai
    model: smart-agent
    apiBase: http://localhost:4004/v1
    apiKey: dummy
```

### curl

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "smart-agent",
    "stream": true,
    "messages": [{"role": "user", "content": "List available MCP tools"}]
  }'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:4004/v1", api_key="dummy")
response = client.chat.completions.create(
    model="smart-agent",
    messages=[{"role": "user", "content": "List available MCP tools"}],
)
print(response.choices[0].message.content)
```

### Available endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | Chat completion (JSON or SSE streaming) |
| `/v1/models` | GET | List available models; supports `?exclude_embedding=true` |
| `/v1/embedding-models` | GET | List available embedding models (best-effort) |
| `/v1/config` | GET | Active runtime configuration (models + agent params) |
| `/v1/config` | PUT | Partial runtime reconfiguration |
| `/v1/health` | GET | Health check |
| `/v1/usage` | GET | Token usage statistics |

### Session management

Pass `X-Session-Id` header to maintain conversation context across requests:

```bash
curl http://localhost:4004/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: my-session" \
  -d '{"model":"smart-agent","messages":[{"role":"user","content":"Hello"}]}'
```

## Current npm scripts

```bash
npm run build
npm run dev
npm run start
npm run test:server
npm run test:all
npm run release:check
```
