# Integration Guide

This guide explains how to implement custom components for every pluggable interface in `@mcp-abap-adt/llm-agent`. Each interface has a description, method signatures, and a working code example.

## Architecture Overview

The SmartAgent pipeline is fully interface-driven. Every component can be replaced via `SmartAgentBuilder`:

```
User Message
  │
  ▼
ISubpromptClassifier  ──►  Decomposes into typed subprompts
  │
  ▼
IQueryExpander        ──►  Expands query with synonyms (optional)
  │
  ▼
IRag                  ──►  Retrieves relevant facts/tools/feedback/state
  │
  ▼
IReranker             ──►  Re-scores RAG results (optional)
  │
  ▼
IContextAssembler     ──►  Packs context into LLM messages
  │
  ▼
ILlm                  ──►  Generates response / tool calls
  │
  ▼
IOutputValidator      ──►  Validates LLM output (optional)
  │
  ▼
ISkillManager         ──►  Discovers and injects skill context (optional)
  │
  ▼
IMcpClient            ──►  Executes tool calls
```

## ILlm

**File:** `src/smart-agent/interfaces/llm.ts`

The core LLM interface for chat and streaming chat:

```ts
interface ILlm {
  chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>>;

  streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
```

### Example: Wrapping a custom provider (Gemini)

```ts
import type { ILlm } from '@mcp-abap-adt/llm-agent';
import type { Message, Result, LlmResponse, LlmError, LlmTool, CallOptions, LlmStreamChunk }
  from '@mcp-abap-adt/llm-agent';

class GeminiLlm implements ILlm {
  constructor(private readonly apiKey: string, private readonly model: string) {}

  async chat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): Promise<Result<LlmResponse, LlmError>> {
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1/...', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        body: JSON.stringify({ messages, tools }),
        signal: options?.signal,
      });

      const data = await response.json();
      return {
        ok: true,
        value: {
          content: data.content,
          toolCalls: data.toolCalls,
          finishReason: data.finishReason ?? 'stop',
          usage: data.usage,
        },
      };
    } catch (err) {
      return { ok: false, error: new LlmError(String(err)) };
    }
  }

  async *streamChat(
    messages: Message[],
    tools?: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>> {
    // SSE streaming implementation
    const response = await fetch('...', { /* ... */ });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = JSON.parse(decoder.decode(value));
      yield { ok: true, value: { content: chunk.text, finishReason: chunk.done ? 'stop' : undefined } };
    }
  }
}
```

### Result pattern

All interface methods return `Result<T, E>`:

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

Always check `result.ok` before accessing `result.value`. Error types extend `SmartAgentError` with a `code` field for programmatic handling.

## IModelProvider

**File:** `src/smart-agent/interfaces/model-provider.ts`

Model discovery and per-request model selection:

```ts
interface IModelInfo {
  id: string;
  owned_by?: string;
}

interface IModelFilter {
  /** When true, exclude embedding-only models from the result. */
  excludeEmbedding?: boolean;
}

interface IModelProvider {
  /** Currently configured (default) model name. */
  getModel(): string;

  /** Fetch available models from the provider. */
  getModels(filter?: IModelFilter, options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;

  /**
   * Fetch embedding-capable models from the provider (optional).
   * Returns an empty array on providers that do not expose embedding model lists.
   */
  getEmbeddingModels?(options?: CallOptions): Promise<Result<IModelInfo[], LlmError>>;
}
```

`IModelFilter` can be passed to `getModels()` to exclude embedding models from the list. Per-provider behaviour:

| Provider | `excludeEmbedding` | `getEmbeddingModels()` |
|---|---|---|
| SAP AI Core | Uses model capabilities metadata (reliable) | Uses model capabilities metadata (reliable) |
| OpenAI | Filters by `/embed/i` name pattern (best-effort) | Filters by `/embed/i` name pattern (best-effort) |
| Anthropic | N/A — returns `[]` | Returns `[]` |
| DeepSeek | N/A — returns `[]` | Returns `[]` |

### Auto-detection

`SmartAgentBuilder` auto-detects `IModelProvider` on `mainLlm`. If `mainLlm` is an `LlmAdapter`, the builder detects and uses it automatically. No explicit `withModelProvider()` call needed for default setups.

### Example: Custom model provider (filtering models)

```ts
import type { IModelProvider, IModelInfo } from '@mcp-abap-adt/llm-agent';
import type { CallOptions, Result, LlmError } from '@mcp-abap-adt/llm-agent';

class FilteredModelProvider implements IModelProvider {
  constructor(
    private readonly inner: IModelProvider,
    private readonly allowedModels: Set<string>,
  ) {}

  getModel(): string {
    return this.inner.getModel();
  }

  async getModels(filter?: IModelFilter, options?: CallOptions): Promise<Result<IModelInfo[], LlmError>> {
    const result = await this.inner.getModels(filter, options);
    if (!result.ok) return result;
    return {
      ok: true,
      value: result.value.filter((m) => this.allowedModels.has(m.id)),
    };
  }
}

// Usage: restrict which models are visible via /v1/models
const handle = await new SmartAgentBuilder()
  .withMainLlm(myLlm)
  .withModelProvider(new FilteredModelProvider(
    myLlmAdapter,
    new Set(['gpt-4o', 'gpt-4o-mini']),
  ))
  .build();
```

### Per-request model override

Pass `model` in `CallOptions` to select a different model per request:

```ts
const result = await handle.chat(messages, tools, { model: 'gpt-4o-mini' });
```

Via `SmartServer`: the `model` field in `POST /v1/chat/completions` request body is forwarded automatically to the main LLM. Classifier and helper models are unaffected.

## IModelResolver

**File:** `src/smart-agent/interfaces/model-resolver.ts`

Resolves a model name into an `ILlm` instance at runtime. Used by `SmartServer` to handle `PUT /v1/config` model changes:

```ts
interface IModelResolver {
  resolve(modelName: string, role: 'main' | 'classifier' | 'helper'): Promise<ILlm>;
}
```

### DefaultModelResolver

Wraps `makeLlm()` with provider settings. Pass the same provider config used at startup:

```ts
import { DefaultModelResolver, SmartServer } from '@mcp-abap-adt/llm-agent';

const server = new SmartServer({
  llm: { apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-4o' },
  modelResolver: new DefaultModelResolver({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  }),
});
```

### Runtime config endpoints

`GET /v1/config` returns models and whitelisted agent parameters:

```json
{
  "models": { "mainModel": "gpt-4o", "classifierModel": "gpt-4o-mini" },
  "agent": { "maxIterations": 10, "classificationEnabled": true }
}
```

`PUT /v1/config` applies partial updates atomically (all-or-nothing):

```bash
curl -X PUT http://localhost:4004/v1/config \
  -H "Content-Type: application/json" \
  -d '{"models": {"classifierModel": "gpt-4o"}, "agent": {"maxIterations": 20}}'
```

Model fields require `modelResolver` on `SmartServerConfig`. Agent fields are validated against a whitelist — unsupported fields return 400.

## IRag

**File:** `src/smart-agent/interfaces/rag.ts`

RAG store for document upsert, query, and health checks:

```ts
interface IRag {
  /**
   * If metadata.id is provided, implementations MUST treat it as an
   * idempotent key — repeated upserts with the same id replace the
   * previous record instead of creating duplicates.
   */
  upsert(text: string, metadata: RagMetadata, options?: CallOptions): Promise<Result<void, RagError>>;
  query(text: string, k: number, options?: CallOptions): Promise<Result<RagResult[], RagError>>;
  healthCheck(options?: CallOptions): Promise<Result<void, RagError>>;
}
```

### Example: Wrapping Pinecone

```ts
import type { IRag } from '@mcp-abap-adt/llm-agent';
import type { RagMetadata, RagResult, RagError, Result, CallOptions }
  from '@mcp-abap-adt/llm-agent';

class PineconeRag implements IRag {
  constructor(
    private readonly index: any,  // Pinecone index client
    private readonly embedder: IEmbedder,
  ) {}

  async upsert(
    text: string,
    metadata: RagMetadata,
    options?: CallOptions,
  ): Promise<Result<void, RagError>> {
    try {
      const { vector } = await this.embedder.embed(text, options);
      await this.index.upsert([{
        id: metadata.id ?? crypto.randomUUID(),
        values: vector,
        metadata: { text, ...metadata },
      }]);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err)) };
    }
  }

  async query(
    text: string,
    k: number,
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    try {
      const { vector } = await this.embedder.embed(text, options);
      const results = await this.index.query({ vector, topK: k, includeMetadata: true });
      return {
        ok: true,
        value: results.matches.map((m: any) => ({
          text: m.metadata.text,
          metadata: m.metadata,
          score: m.score,
        })),
      };
    } catch (err) {
      return { ok: false, error: new RagError(String(err)) };
    }
  }

  async healthCheck(): Promise<Result<void, RagError>> {
    try {
      await this.index.describeIndexStats();
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: new RagError(String(err)) };
    }
  }
}
```

### IEmbedder

Custom embedding providers implement `IEmbedder`:

```ts
interface IEmbedResult {
  vector: number[];
  usage?: { promptTokens: number; totalTokens: number };
}

interface IEmbedder {
  embed(text: string, options?: CallOptions): Promise<IEmbedResult>;
}
```

`embed()` returns `IEmbedResult` rather than a raw `number[]`. Access the embedding via the `.vector` property. The optional `usage` field reports token consumption for providers that expose it (e.g. OpenAI, SAP AI Core).

### Runtime RAG store management

`SmartAgent` exposes two methods for adding and removing custom RAG stores at runtime, without rebuilding the agent:

```ts
agent.addRagStore(name: string, store: IRag): void
agent.removeRagStore(name: string): void
```

Custom stores are queried in parallel with the built-in `tools` and `history` RAG stores on every request. Changes take effect on the next request — in-flight requests see the previous store set.

**Constraints:**

- The names `'tools'` and `'history'` are reserved for built-in stores and cannot be overwritten. Attempting to call `addRagStore('tools', ...)` throws an error.
- Passing a `name` that does not exist to `removeRagStore()` is a no-op.

**Example:**

```ts
import { SmartAgentBuilder, QdrantRag } from '@mcp-abap-adt/llm-agent';

const { agent } = await new SmartAgentBuilder({ mcp: { type: 'http', url: '...' } })
  .withMainLlm(myLlm)
  .build();

// Add a per-tenant knowledge base at runtime
const tenantRag = new QdrantRag({
  url: 'http://qdrant:6333',
  collectionName: 'tenant-42-docs',
  embedder,
});
agent.addRagStore('tenant-42', tenantRag);

// Remove it when the tenant disconnects
agent.removeRagStore('tenant-42');
```

## IMcpClient

**File:** `src/smart-agent/interfaces/mcp-client.ts`

Wraps tool discovery and execution:

```ts
interface IMcpClient {
  listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>>;
  callTool(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<Result<McpToolResult, McpError>>;
  healthCheck?(options?: CallOptions): Promise<Result<boolean, McpError>>;
}
```

### Example: Wrapping a non-MCP REST API catalog

```ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent';
import type { McpTool, McpToolResult, McpError, Result, CallOptions }
  from '@mcp-abap-adt/llm-agent';

class RestApiToolClient implements IMcpClient {
  constructor(private readonly baseUrl: string) {}

  async listTools(options?: CallOptions): Promise<Result<McpTool[], McpError>> {
    try {
      const res = await fetch(`${this.baseUrl}/tools`, { signal: options?.signal });
      const tools = await res.json();
      return {
        ok: true,
        value: tools.map((t: any) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.schema,
        })),
      };
    } catch (err) {
      return { ok: false, error: new McpError(String(err)) };
    }
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<Result<McpToolResult, McpError>> {
    try {
      const res = await fetch(`${this.baseUrl}/tools/${name}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: options?.signal,
      });
      const data = await res.json();
      return { ok: true, value: { content: data.result } };
    } catch (err) {
      return { ok: false, error: new McpError(String(err)) };
    }
  }

  async healthCheck(options?: CallOptions): Promise<Result<boolean, McpError>> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: options?.signal });
      return { ok: true, value: res.ok };
    } catch (err) {
      return { ok: false, error: new McpError(String(err)) };
    }
  }
}
```

## IReranker

**File:** `src/smart-agent/reranker/types.ts`

Re-scores RAG results after initial retrieval:

```ts
interface IReranker {
  rerank(query: string, results: RagResult[], options?: CallOptions): Promise<Result<RagResult[], RagError>>;
}
```

### Example: Cross-encoder reranker via external API

```ts
import type { IReranker } from '@mcp-abap-adt/llm-agent';
import type { RagResult, RagError, Result, CallOptions } from '@mcp-abap-adt/llm-agent';

class CrossEncoderReranker implements IReranker {
  constructor(private readonly endpoint: string) {}

  async rerank(
    query: string,
    results: RagResult[],
    options?: CallOptions,
  ): Promise<Result<RagResult[], RagError>> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          documents: results.map(r => r.text),
        }),
        signal: options?.signal,
      });
      const scores: number[] = await res.json();

      const reranked = results
        .map((r, i) => ({ ...r, score: scores[i] }))
        .sort((a, b) => b.score - a.score);

      return { ok: true, value: reranked };
    } catch (err) {
      return { ok: false, error: new RagError(String(err)) };
    }
  }
}
```

The library ships `LlmReranker` (uses the helper LLM for relevance scoring) and `NoopReranker` (pass-through).

## IOutputValidator

**File:** `src/smart-agent/validator/types.ts`

Validates LLM output after generation:

```ts
interface IOutputValidator {
  validate(
    content: string,
    context: { messages: Message[]; tools: LlmTool[] },
    options?: CallOptions,
  ): Promise<Result<ValidationResult, ValidatorError>>;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
  correctedContent?: string;
}
```

### Example: JSON schema validator

```ts
import type { IOutputValidator, ValidationResult } from '@mcp-abap-adt/llm-agent';
import type { Message, Result, CallOptions, LlmTool } from '@mcp-abap-adt/llm-agent';
import { ValidatorError } from '@mcp-abap-adt/llm-agent';

class JsonSchemaValidator implements IOutputValidator {
  constructor(private readonly schema: object) {}

  async validate(
    content: string,
    _context: { messages: Message[]; tools: LlmTool[] },
    _options?: CallOptions,
  ): Promise<Result<ValidationResult, ValidatorError>> {
    try {
      const parsed = JSON.parse(content);
      // Run JSON schema validation against this.schema
      const isValid = validateAgainstSchema(parsed, this.schema);
      return {
        ok: true,
        value: { valid: isValid, reason: isValid ? undefined : 'Schema mismatch' },
      };
    } catch {
      return {
        ok: true,
        value: { valid: false, reason: 'Invalid JSON in LLM response' },
      };
    }
  }
}
```

### Example: Content moderation filter

```ts
class ContentModerationValidator implements IOutputValidator {
  private readonly blocklist: RegExp[];

  constructor(patterns: string[]) {
    this.blocklist = patterns.map(p => new RegExp(p, 'i'));
  }

  async validate(
    content: string,
    _context: { messages: Message[]; tools: LlmTool[] },
  ): Promise<Result<ValidationResult, ValidatorError>> {
    const violation = this.blocklist.find(re => re.test(content));
    return {
      ok: true,
      value: {
        valid: !violation,
        reason: violation ? `Content matched blocked pattern: ${violation.source}` : undefined,
      },
    };
  }
}
```

## IQueryExpander

**File:** `src/smart-agent/rag/query-expander.ts`

Expands user queries with synonyms before RAG retrieval:

```ts
interface IQueryExpander {
  expand(query: string, options?: CallOptions): Promise<Result<string, RagError>>;
}
```

### Example: Domain-specific term expansion

```ts
import type { IQueryExpander } from '@mcp-abap-adt/llm-agent';
import type { RagError, Result, CallOptions } from '@mcp-abap-adt/llm-agent';

class SapTermExpander implements IQueryExpander {
  private readonly synonyms: Record<string, string[]> = {
    'transport': ['TR', 'transport request', 'change request', 'CTS'],
    'badi': ['BAdI', 'business add-in', 'enhancement implementation'],
    'cds': ['CDS view', 'core data services', 'data model'],
    'rfc': ['RFC', 'remote function call', 'function module'],
  };

  async expand(query: string, _options?: CallOptions): Promise<Result<string, RagError>> {
    let expanded = query;
    for (const [term, syns] of Object.entries(this.synonyms)) {
      if (query.toLowerCase().includes(term)) {
        expanded += ` ${syns.join(' ')}`;
      }
    }
    return { ok: true, value: expanded };
  }
}
```

The library ships `LlmQueryExpander` (LLM-generated expansion) and `NoopQueryExpander` (pass-through).

## ISubpromptClassifier

**File:** `src/smart-agent/interfaces/classifier.ts`

Decomposes user messages into typed subprompts:

```ts
interface ISubpromptClassifier {
  classify(text: string, options?: CallOptions): Promise<Result<Subprompt[], ClassifierError>>;
}
```

Subprompt types: `action`, `fact`, `chat`, `state`, `feedback`.

### Example: Rule-based classifier for simple use cases

```ts
import type { ISubpromptClassifier } from '@mcp-abap-adt/llm-agent/smart-server';
import type { Subprompt, ClassifierError, Result, CallOptions }
  from '@mcp-abap-adt/llm-agent';

class RuleBasedClassifier implements ISubpromptClassifier {
  private readonly actionPatterns = [/^(create|delete|update|run|execute|show|read|get)\b/i];
  private readonly chatPatterns = [/^(hello|hi|hey|thanks|bye)\b/i, /\?$/];

  async classify(
    text: string,
    _options?: CallOptions,
  ): Promise<Result<Subprompt[], ClassifierError>> {
    const type = this.actionPatterns.some(p => p.test(text)) ? 'action'
      : this.chatPatterns.some(p => p.test(text)) ? 'chat'
      : 'fact';

    return {
      ok: true,
      value: [{ type, text, context: 'general', dependency: 'independent' }],
    };
  }
}
```

## IContextAssembler

**File:** `src/smart-agent/interfaces/assembler.ts`

Packs retrieved context into LLM-ready messages:

```ts
interface IContextAssembler {
  assemble(
    action: Subprompt,
    retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] },
    history: Message[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;
}
```

### Example: Custom context window packing strategy

```ts
import type { IContextAssembler } from '@mcp-abap-adt/llm-agent/smart-server';
import type { Message, Subprompt, RagResult, McpTool, AssemblerError, Result, CallOptions }
  from '@mcp-abap-adt/llm-agent';

class CompactAssembler implements IContextAssembler {
  async assemble(
    action: Subprompt,
    retrieved: { facts: RagResult[]; feedback: RagResult[]; state: RagResult[]; tools: McpTool[] },
    history: Message[],
    _options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>> {
    const systemParts: string[] = ['You are a helpful assistant.'];

    // Add top-3 facts only
    if (retrieved.facts.length > 0) {
      systemParts.push('Relevant facts:');
      for (const f of retrieved.facts.slice(0, 3)) {
        systemParts.push(`- ${f.text}`);
      }
    }

    // Add available tools summary
    if (retrieved.tools.length > 0) {
      systemParts.push(`Available tools: ${retrieved.tools.map(t => t.name).join(', ')}`);
    }

    const messages: Message[] = [
      { role: 'system', content: systemParts.join('\n') },
      ...history.slice(-5),  // Keep only last 5 messages
      { role: 'user', content: action.text },
    ];

    return { ok: true, value: messages };
  }
}
```

## ISkillManager

**File:** `src/smart-agent/interfaces/skill.ts`

Discovers and provides access to agent skills (SKILL.md files):

```ts
interface ISkillManager {
  listSkills(options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
  getSkill(name: string, options?: CallOptions): Promise<Result<ISkill | undefined, SkillError>>;
  matchSkills(text: string, options?: CallOptions): Promise<Result<ISkill[], SkillError>>;
}

interface ISkill {
  readonly name: string;
  readonly description: string;
  readonly meta: ISkillMeta;
  getContent(args?: string, options?: CallOptions): Promise<Result<string, SkillError>>;
  listResources(options?: CallOptions): Promise<Result<ISkillResource[], SkillError>>;
  readResource(path: string, options?: CallOptions): Promise<Result<string, SkillError>>;
}
```

### Built-in managers

| Manager | Discovery | Notes |
|---------|-----------|-------|
| `ClaudeSkillManager` | `~/.claude/skills/` + `<project>/.claude/skills/` | Maps kebab-case frontmatter to camelCase |
| `CodexSkillManager` | `~/.agents/skills/` + `<project>/.agents/skills/` | Parses optional `agents/openai.yaml` |
| `FileSystemSkillManager` | Custom `dirs[]` | No vendor-specific logic |

### Example: Custom skill manager (database-backed)

```ts
import type { ISkillManager, ISkill } from '@mcp-abap-adt/llm-agent';
import type { SkillError, Result, CallOptions } from '@mcp-abap-adt/llm-agent';

class DatabaseSkillManager implements ISkillManager {
  constructor(private readonly db: Database) {}

  async listSkills(options?: CallOptions): Promise<Result<ISkill[], SkillError>> {
    try {
      const rows = await this.db.query('SELECT * FROM skills WHERE active = true');
      const skills: ISkill[] = rows.map((row) => new DatabaseSkill(row, this.db));
      return { ok: true, value: skills };
    } catch (err) {
      return { ok: false, error: new SkillError(String(err)) };
    }
  }

  async getSkill(
    name: string,
    options?: CallOptions,
  ): Promise<Result<ISkill | undefined, SkillError>> {
    try {
      const row = await this.db.query('SELECT * FROM skills WHERE name = ?', [name]);
      return { ok: true, value: row ? new DatabaseSkill(row, this.db) : undefined };
    } catch (err) {
      return { ok: false, error: new SkillError(String(err)) };
    }
  }

  async matchSkills(
    text: string,
    options?: CallOptions,
  ): Promise<Result<ISkill[], SkillError>> {
    try {
      const rows = await this.db.query(
        'SELECT * FROM skills WHERE name ILIKE ? OR description ILIKE ?',
        [`%${text}%`, `%${text}%`],
      );
      return { ok: true, value: rows.map((r) => new DatabaseSkill(r, this.db)) };
    } catch (err) {
      return { ok: false, error: new SkillError(String(err)) };
    }
  }
}
```

### Wiring via builder

```ts
import { SmartAgentBuilder, ClaudeSkillManager } from '@mcp-abap-adt/llm-agent';

const handle = await new SmartAgentBuilder({ mcp: { type: 'http', url: '...' } })
  .withMainLlm(myLlm)
  .withSkillManager(new ClaudeSkillManager(process.cwd()))
  // or: .withSkillManager(new DatabaseSkillManager(db))
  .build();
```

Skills are vectorized into the facts RAG store at `build()` time as `skill:<name>` entries. The `skill-select` pipeline stage matches them via RAG and injects their content into the system message.

### Wiring via YAML config

```yaml
skills:
  type: claude     # or 'codex' | 'filesystem'
  dirs:            # only for 'filesystem' type
    - ./my-skills
```

### Wiring via plugin

```ts
// In a plugin file:
import { FileSystemSkillManager } from '@mcp-abap-adt/llm-agent';

export const skillManager = new FileSystemSkillManager(['/opt/shared-skills']);
```

## ILlmApiAdapter

**File:** `src/smart-agent/interfaces/api-adapter.ts`

A stateless singleton that translates between an inbound API protocol and the internal SmartAgent format. One adapter instance handles all requests for its protocol.

```ts
interface ILlmApiAdapter {
  /** Unique protocol name, used as the HTTP route discriminator. */
  readonly name: string;

  /**
   * Parse and validate the raw inbound request body.
   * Throw AdapterValidationError on malformed input.
   */
  normalizeRequest(request: unknown): NormalizedRequest;

  /**
   * Transform the agent's internal stream into protocol-specific SSE events.
   * Each ApiSseEvent is written verbatim as `event: <event>\ndata: <data>\n\n`.
   */
  transformStream(
    source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>,
    context: ApiRequestContext,
  ): AsyncIterable<ApiSseEvent>;

  /**
   * Format a completed (non-streaming) agent response for the wire.
   */
  formatResult(response: SmartAgentResponse, context: ApiRequestContext): unknown;

  /**
   * Optional: format an error into the protocol's error shape.
   * Falls back to a generic JSON error when not implemented.
   */
  formatError?(error: OrchestratorError, context: ApiRequestContext): unknown;
}
```

Supporting types:

```ts
interface ApiRequestContext {
  readonly adapterName: string;
  readonly protocol: Record<string, unknown>; // protocol-specific per-request state
}

interface ApiSseEvent {
  event?: string;  // SSE event name; omit for OpenAI (which has no event: field)
  data: string;    // pre-serialized JSON payload written after "data: "
}

/** Thrown from normalizeRequest() to produce a 400 response. */
class AdapterValidationError extends Error {
  constructor(message: string, statusCode?: number) {}
}
```

### Built-in adapters

| Adapter | Name | Route |
|---|---|---|
| `OpenAiApiAdapter` | `openai` | `POST /v1/chat/completions` |
| `AnthropicApiAdapter` | `anthropic` | `POST /v1/messages` |

`AnthropicApiAdapter` implements the full Anthropic SSE event sequence: `message_start` → `content_block_start` → `content_block_delta` (per token) → `content_block_stop` → `message_delta` → `message_stop`.

### Example: custom adapter skeleton

```ts
import type { ILlmApiAdapter, ApiRequestContext, ApiSseEvent, NormalizedRequest } from '@mcp-abap-adt/llm-agent';
import type { SmartAgentResponse, OrchestratorError, LlmStreamChunk, Result } from '@mcp-abap-adt/llm-agent';
import { AdapterValidationError } from '@mcp-abap-adt/llm-agent';

class MyProtocolAdapter implements ILlmApiAdapter {
  readonly name = 'my-protocol';

  normalizeRequest(request: unknown): NormalizedRequest {
    const req = request as Record<string, unknown>;
    if (!req.prompt) throw new AdapterValidationError('Missing prompt field');
    return {
      messages: [{ role: 'user', content: String(req.prompt) }],
      stream: Boolean(req.stream),
      context: { adapterName: this.name, protocol: {} },
    };
  }

  async *transformStream(
    source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>,
    _context: ApiRequestContext,
  ): AsyncIterable<ApiSseEvent> {
    for await (const chunk of source) {
      if (!chunk.ok) continue;
      const text = chunk.value.content ?? '';
      if (text) {
        yield { data: JSON.stringify({ text }) };
      }
    }
    yield { data: '[DONE]' };
  }

  formatResult(response: SmartAgentResponse, _context: ApiRequestContext): unknown {
    return { result: response.content };
  }
}
```

### Registration via builder

```ts
const handle = await new SmartAgentBuilder({})
  .withMainLlm(myLlm)
  .withApiAdapter(new MyProtocolAdapter())
  .build();
```

### Registration via plugin

```ts
// plugins/my-adapter.mjs
import { MyProtocolAdapter } from './my-protocol-adapter.js';

export const apiAdapters = [new MyProtocolAdapter()];
```

### SmartServer config options

```ts
new SmartServer({
  llm: { apiKey: process.env.API_KEY! },
  // Register additional adapters alongside built-ins:
  apiAdapters: [new MyProtocolAdapter()],
  // Disable built-in adapters and supply only your own:
  disableBuiltInAdapters: true,
});
```

## IMcpClient — DI injection

MCP clients can be injected via three paths (precedence: config > plugin > YAML):

### Via SmartServer config

```ts
import { SmartServer, MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent';

const wrapper = new MCPClientWrapper({ transport: 'auto', url: 'http://localhost:3001/mcp' });
await wrapper.connect();
const client = new McpClientAdapter(wrapper);

const server = new SmartServer({
  llm: { apiKey: process.env.API_KEY! },
  mcpClients: [client],  // DI — takes precedence over mcp: YAML config
});
```

### Via plugin (lazy initialization)

```ts
// plugins/lazy-mcp.mjs
import { lazy, MCPClientWrapper, McpClientAdapter } from '@mcp-abap-adt/llm-agent';

const url = process.env.MCP_SERVER_URL;

export const mcpClients = url ? [lazy(() => {
  const w = new MCPClientWrapper({ transport: 'auto', url });
  return w.connect().then(() => new McpClientAdapter(w));
}, {
  retryIntervalMs: 15_000,
  onError: (err) => console.warn('[lazy-mcp] MCP not ready:', err.message),
})] : [];
```

### Via builder

```ts
const handle = await new SmartAgentBuilder({})
  .withMainLlm(myLlm)
  .withMcpClients([clientA, clientB])  // skips auto-connect and tool vectorization
  .build();
```

**Note:** When using `withMcpClients()`, the builder skips auto-connect and tool vectorization — the caller is responsible for providing already-connected clients.

## IMcpConnectionStrategy — MCP reconnection

By default the agent starts with an empty tool catalog if the MCP server is unavailable at startup. `IMcpConnectionStrategy` solves this by letting the agent re-resolve its MCP clients on every request.

**Interface** (`src/smart-agent/interfaces/mcp-connection-strategy.ts`):

```ts
interface IMcpConnectionStrategy {
  resolve(
    currentClients: IMcpClient[],
    options?: CallOptions,
  ): Promise<McpConnectionResult>;   // { clients, toolsChanged }

  dispose?(): Promise<void> | void;
}
```

### Built-in strategies

| Strategy | Behaviour |
|---|---|
| `NoopConnectionStrategy` | Returns `currentClients` unchanged — same as not setting a strategy. |
| `LazyConnectionStrategy` | Checks health of each slot on every `resolve()` call; reconnects unhealthy slots when the per-slot cooldown has expired. |
| `PeriodicConnectionStrategy` | Probes MCP servers on a background timer; `resolve()` returns the last cached result without blocking the request path. |

### Builder usage

```ts
import {
  LazyConnectionStrategy,
  SmartAgentBuilder,
} from '@mcp-abap-adt/llm-agent';

const mcpConfigs = [
  { type: 'http' as const, url: 'http://localhost:3001/mcp/stream/http' },
];

const { agent, close } = await new SmartAgentBuilder({ mcp: mcpConfigs })
  .withMcpConnectionStrategy(
    new LazyConnectionStrategy(mcpConfigs, { cooldownMs: 15_000 }),
  )
  .build();

// Agent will auto-reconnect MCP on each request if needed
// Remember to call close() for cleanup (disposes strategy too)
```

`close()` calls `strategy.dispose()`, which clears timers and closes underlying transport connections.

## ILlmCallStrategy — Tool Loop LLM Call Strategy

Controls how the tool-loop calls the LLM. Three built-in strategies:

**1. `StreamingLlmCallStrategy`** (default) — uses `streamChat()`. Chunks streamed to client in real-time.

```ts
import { StreamingLlmCallStrategy } from '@mcp-abap-adt/llm-agent';
builder.withLlmCallStrategy(new StreamingLlmCallStrategy());
```

**2. `NonStreamingLlmCallStrategy`** — uses `chat()`. Full response yielded as a single chunk. Use when streaming is unreliable.

```ts
import { NonStreamingLlmCallStrategy } from '@mcp-abap-adt/llm-agent';
builder.withLlmCallStrategy(new NonStreamingLlmCallStrategy());
```

For `sap-ai-sdk`, this is the recommended production strategy when SAP AI Core streaming is unstable after successful tool execution.

**3. `FallbackLlmCallStrategy`** — starts with streaming. On error, logs the cause and automatically switches to `chat()` for the remaining iterations in the same request. Never loses the error cause.

```ts
import { FallbackLlmCallStrategy } from '@mcp-abap-adt/llm-agent';
builder.withLlmCallStrategy(new FallbackLlmCallStrategy(logger));
```

`FallbackLlmCallStrategy` is not a safe recovery mechanism when the provider already emitted content chunks to the client. For SAP AI Core, prefer `NonStreamingLlmCallStrategy` in production and treat streaming as a diagnostic path backed by provider logs and session-step context logs.

The interface:

```ts
interface ILlmCallStrategy {
  call(
    llm: ILlm,
    messages: Message[],
    tools: LlmTool[],
    options?: CallOptions,
  ): AsyncIterable<Result<LlmStreamChunk, LlmError>>;
}
```

### YAML configuration

```yaml
agent:
  llmCallStrategy: non-streaming   # streaming | non-streaming | fallback
```

When set in YAML, SmartServer automatically injects the corresponding strategy into the builder. No programmatic setup needed.

### Per-provider streaming control

For multi-model pipelines, control streaming per provider with the `streaming` flag:

```yaml
pipeline:
  llm:
    main:
      provider: sap-ai-sdk
      model: gpt-4o
      streaming: false          # non-streaming for SAP AI Core
    classifier:
      provider: deepseek
      model: deepseek-chat
      streaming: true           # streaming for DeepSeek (default)
```

When `streaming: false`, `makeLlm()` wraps the provider with `NonStreamingLlm` — `streamChat()` is replaced with `chat()` yielding a single chunk. This is independent of `llmCallStrategy` and works per-provider.

### Custom base URL (`baseURL`)

Use `baseURL` to point any OpenAI-compatible provider at a custom endpoint (Azure OpenAI, Ollama, vLLM, etc.):

```yaml
pipeline:
  llm:
    main:
      provider: openai
      apiKey: ${OPENAI_API_KEY}
      baseURL: https://my-azure-openai.openai.azure.com/openai/deployments/gpt-4o
      model: gpt-4o
```

`makeLlm()` forwards `baseURL` to `OpenAIProvider`, `AnthropicProvider`, and `DeepSeekProvider`. When omitted, each provider uses its default API URL.

### Per-request LLM parameters

Standard OpenAI and Anthropic per-request parameters are forwarded through the pipeline to the LLM:

| Parameter | OpenAI (`/v1/chat/completions`) | Anthropic (`/v1/messages`) |
|-----------|--------------------------------|----------------------------|
| `temperature` | ✅ | ✅ |
| `max_tokens` | ✅ | ✅ |
| `top_p` | ✅ | ✅ |
| `stop` | ✅ (string or array) | ✅ (`stop_sequences` array) |

When omitted, the provider's configured defaults (from YAML / env) are used. When specified, they override for that request only.

### Health Check Timeout

The `/v1/health` endpoint runs LLM, RAG, and MCP probes under a shared timeout. The default is 5000 ms. For providers with high latency (e.g., SAP AI Core Orchestration with OAuth), increase the timeout:

**YAML:**

```yaml
agent:
  healthTimeoutMs: 15000
```

**Builder:**

```typescript
new SmartAgentBuilder()
  .withHealthTimeout(15_000)
  .build();
```

All ILlm decorators (`NonStreamingLlm`, `RetryLlm`, `CircuitBreakerLlm`, `RateLimiterLlm`) now proxy `healthCheck()` to the inner LLM, so the lightweight `getModels()` path is used instead of the `chat('ping')` fallback.

> **Note:** When increasing `healthTimeoutMs`, ensure that Kubernetes readiness/liveness probe `timeoutSeconds` and load balancer health check timeouts are also adjusted accordingly. The infrastructure timeout must be greater than `healthTimeoutMs` to avoid false negatives.

> **Verification:** Unit tests cover timeout configuration and signal merging, but they use fast in-memory stubs. After changing `healthTimeoutMs` in production, manually verify `/v1/health` against your actual provider to confirm the timeout is sufficient. For SAP AI Core, a cold-start health check (first call after deploy, when the OAuth token is not yet cached) is the slowest path — test that scenario specifically.

### Runtime Reconfiguration

Swap LLM instances at runtime without restarting the server:

```typescript
import { makeLlm } from '@mcp-abap-adt/llm-agent';

// Create a new classifier LLM
const newClassifier = makeLlm(
  { provider: 'openai', apiKey: key, model: 'gpt-4.1-mini' },
  0.1,
);

// Swap it at runtime
agent.reconfigure({ classifierLlm: newClassifier });

// Inspect active configuration
console.log(agent.getActiveConfig());
// { mainModel: 'deepseek-chat', classifierModel: 'gpt-4.1-mini', helperModel: undefined }
```

**Important:**

- Changes apply only to **new requests** — in-flight requests continue with the previous LLM snapshot.
- Reconfigured LLMs do **not** inherit builder-time wrappers (retry, circuit breaker, rate limiter). Wrap before passing if needed.
- Derived components created during `build()` (e.g., `historySummarizer`, `queryExpander`) are **not** automatically rebuilt.
- `reconfigure()` is synchronous and in-memory only — it does not persist changes to YAML config.

## ILlmRateLimiter — Rate Limiting

Throttle outbound LLM requests to stay within provider rate limits.

```ts
import { TokenBucketRateLimiter } from '@mcp-abap-adt/llm-agent';

builder.withRateLimiter(new TokenBucketRateLimiter({
  maxRequests: 10,     // max requests per window
  windowMs: 60_000,    // window duration (default: 1 minute)
}));
```

The rate limiter wraps outermost in the decorator chain: `RateLimiterLlm → RetryLlm → CircuitBreakerLlm → LlmAdapter`. Retry attempts also respect the rate limit.

`RetryLlm` is now enabled by default (3 attempts, 2s backoff, retry on 429/500/502/503).

## IMetrics / ITracer / ISessionManager / IToolCache

### IMetrics

**File:** `src/smart-agent/metrics/types.ts`

```ts
interface IMetrics {
  requestCount: ICounter;
  requestLatency: IHistogram;
  toolCallCount: ICounter;
  ragQueryCount: ICounter;
  classifierIntentCount: ICounter;
  llmCallCount: ICounter;
  llmCallLatency: IHistogram;
  circuitBreakerTransition: ICounter;
  toolCacheHitCount: ICounter;
}
```

Implementations: `InMemoryMetrics` (for testing/diagnostics), `NoopMetrics` (zero overhead).

### ITracer

**File:** `src/smart-agent/tracer/types.ts`

```ts
interface ITracer {
  startSpan(name: string, options?: SpanOptions): ISpan;
}
```

Implementations: `NoopTracer` (default), `OtelTracerAdapter` (via `@mcp-abap-adt/llm-agent/otel`).

### ISessionManager

**File:** `src/smart-agent/session/types.ts`

```ts
interface ISessionManager {
  addTokens(count: number): void;
  isOverBudget(): boolean;
  reset(): void;
  readonly totalTokens: number;
}
```

Implementations: `SessionManager` (with token budget), `NoopSessionManager` (no tracking).

### IToolCache

**File:** `src/smart-agent/cache/types.ts`

```ts
interface IToolCache {
  get(toolName: string, args: Record<string, unknown>): McpToolResult | undefined;
  set(toolName: string, args: Record<string, unknown>, result: McpToolResult): void;
  clear(): void;
}
```

Implementations: `ToolCache` (with TTL + SHA-256 key hashing), `NoopToolCache` (no caching).

## Builder Wiring

The `SmartAgentBuilder` is interface-only — it has no knowledge of concrete providers. All dependencies must be injected.

### onBeforeStream hook (optional)

Use `withOnBeforeStream()` to post-process the final response before it is streamed to the caller — for example, to reformat it with a faster model:

```ts
const agent = new SmartAgentBuilder()
  .withOnBeforeStream(async function* (content, ctx) {
    const stream = await fastLlm.streamChat([
      { role: 'system', content: 'Reformat concisely.' },
      ...ctx.messages,
      { role: 'assistant', content },
    ]);
    for await (const chunk of stream) {
      yield chunk.content;
    }
  })
  .build();
```

The hook signature is: `onBeforeStream?: (content: string, ctx: StreamHookContext) => AsyncIterable<string>`
`StreamHookContext` provides `{ messages: Message[] }`. The hook is optional — when omitted, the accumulated content is streamed as-is.

### Tool-loop context design

The tool-loop passes **full tool results** between iterations without compaction. This is by design:

- **Assistant messages** (tool calls) — LLM's decisions, must be preserved
- **Tool results** — MCP server responses, must not be modified or truncated. The LLM needs the full result to make the next decision
- **If a tool result is too large** for the provider's payload limit — that's the MCP server's responsibility to fix (e.g. return TSV instead of XML, paginate results)

History between user requests is managed separately via `HistoryMemory` (ring buffer) and RAG stores — not by the tool-loop.

### History recency window

By default, `ContextAssembler` passes the full client message history to the LLM. On multi-turn conversations this causes the LLM to re-process old context (e.g. re-analyzing a dump when the user just asks "show me that program").

Set `historyRecencyWindow` to limit how many recent messages are included:

```yaml
agent:
  historyRecencyWindow: 4    # only last 4 messages in LLM context
```

Or programmatically via `ContextAssemblerConfig`:

```ts
const assembler = new ContextAssembler({
  historyRecencyWindow: 4,
});
builder.withAssembler(assembler);
```

When set, only the last N non-system messages from client history are passed to the LLM. Older messages are excluded — they remain available via RAG stores (`semanticHistoryEnabled`) if the LLM needs them. When not set, all messages are included (backward compatible).

### Full example

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent';
import {
  ToolCache, SessionManager, InMemoryMetrics,
  OllamaEmbedder, QdrantRag,
} from '@mcp-abap-adt/llm-agent';

const metrics = new InMemoryMetrics();

// Create concrete implementations (composition root responsibility)
const myLlm = new GeminiLlm(process.env.GEMINI_KEY!, 'gemini-pro');
const embedder = new OllamaEmbedder({ model: 'nomic-embed-text' });
const factsRag = new QdrantRag({
  url: 'http://qdrant:6333',
  collectionName: 'facts',
  embedder,
});

const handle = await new SmartAgentBuilder({
  mcp: { type: 'http', url: 'http://localhost:3001/mcp/stream/http' },
})
  .withMainLlm(myLlm)                  // required — no default
  .withRag({ facts: factsRag })
  .withReranker(new CrossEncoderReranker('http://reranker:8080/rerank'))
  .withOutputValidator(new JsonSchemaValidator(mySchema))
  .withToolCache(new ToolCache({ ttlMs: 60_000 }))
  .withToolReselection(true)             // re-select tools via RAG per tool-loop iteration
  .withSessionManager(new SessionManager({ tokenBudget: 100_000 }))
  .withMetrics(metrics)
  .withQueryExpander(new SapTermExpander())
  .withSkillManager(new ClaudeSkillManager(process.cwd()))
  .withModelProvider(myModelProvider)     // optional — auto-detected from mainLlm
  .withOnBeforeStream(async function* (content, ctx) { // optional — post-process response before streaming
    const stream = await myFastLlm.streamChat([
      { role: 'system', content: 'Reformat concisely.' },
      ...ctx.messages,
      { role: 'assistant', content },
    ]);
    for await (const chunk of stream) yield chunk.content;
  })
  .withCircuitBreaker({ failureThreshold: 5, recoveryWindowMs: 30_000 })
  // Resilience
  // retry is configured via agentConfig, not builder fluent API:
  //   agentConfig: { retry: { maxAttempts: 3, backoffMs: 2000, retryOn: [429, 500, 502, 503], retryOnMidStream: ['SSE stream'] } }
  // Pipeline stage configuration
  .withMode('smart')
  .withMaxIterations(15)
  .withMaxToolCalls(50)
  .withRagRetrieval('always')        // force RAG even without SAP context
  .withClassification(true)          // enable/disable classification stage
  .withRagTranslation(true)          // translate non-ASCII queries to English
  .withQueryExpansion(true)          // expand queries with synonyms
  .withShowReasoning(false)
  .withHeartbeatInterval(3000)
  .withHealthTimeout(15_000)           // health check probe timeout (default: 5000)
  .build();

// Use the agent
const result = await handle.agent.process('Read the source of class ZCL_MY_CLASS');
console.log(result.content);

// Cleanup
await handle.close();
```

### Custom embedder injection via SmartServer

For YAML-driven configs, inject a custom `IEmbedder` or register embedder factories:

```ts
import { SmartServer } from '@mcp-abap-adt/llm-agent/smart-server';

const server = new SmartServer({
  llm: { apiKey: process.env.API_KEY! },
  rag: { type: 'qdrant', url: 'http://qdrant:6333', embedder: 'sap-ai-sdk' },
  mode: 'smart',
  // Register custom embedder factory — referenced by name in YAML config
  embedderFactories: {
    'sap-ai-sdk': (cfg) => new SapAiCoreEmbedder({ model: cfg.model }),
  },
});
```

## Structured Pipeline (YAML DSL)

The structured pipeline replaces the hardcoded orchestration flow with a YAML-defined stage tree. This enables reordering, skipping, or adding custom stages without modifying agent code.

### Enabling via YAML

Add `pipeline.version` and `pipeline.stages` to your config:

```yaml
llm:
  main:
    provider: openai
    apiKey: ${OPENAI_API_KEY}
    model: gpt-4o

pipeline:
  version: "1"
  stages:
    - id: classify
      type: classify
    - id: summarize
      type: summarize
    - id: rag-retrieval
      type: parallel
      when: "shouldRetrieve"
      stages:
        - { id: translate, type: translate }
        - { id: expand, type: expand }
      after:
        - id: rag-queries
          type: parallel
          stages:
            - { id: facts, type: rag-query, config: { store: facts, k: 10 } }
            - { id: feedback, type: rag-query, config: { store: feedback, k: 5 } }
            - { id: state, type: rag-query, config: { store: state, k: 5 } }
        - { id: rerank, type: rerank }
        - { id: tool-select, type: tool-select }
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
```

### Enabling via Builder (programmatic)

```ts
import {
  SmartAgentBuilder,
  type StructuredPipelineDefinition,
  getDefaultStages,
} from '@mcp-abap-adt/llm-agent';

const pipeline: StructuredPipelineDefinition = {
  version: '1',
  stages: getDefaultStages(), // or your custom stage tree
};

const handle = await new SmartAgentBuilder({ mcp: { type: 'http', url: '...' } })
  .withMainLlm(myLlm)
  .withPipeline(pipeline)
  .build();
```

### Stage Definition Reference

Each stage has the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | yes | Unique identifier for logging/tracing |
| `type` | `string` | yes | Built-in type or custom handler name |
| `config` | `object` | no | Arbitrary config passed to the handler |
| `when` | `string` | no | Condition expression — stage skipped if falsy |
| `stages` | `StageDefinition[]` | no | Child stages (for `parallel`/`repeat`) |
| `after` | `StageDefinition[]` | no | Sequential follow-up stages (for `parallel` only) |
| `maxIterations` | `number` | no | Max loop iterations (for `repeat`, default: 10) |
| `until` | `string` | no | Stop condition (for `repeat`) |

### Condition Expressions

The `when` and `until` fields use a safe expression evaluator (no `eval()`):

```yaml
# Simple property check (truthy)
when: "shouldRetrieve"

# Negation
when: "!isAscii"

# Dot-path access
when: "config.classificationEnabled"

# Boolean operators
when: "shouldRetrieve && !isAscii"

# Comparisons
until: "state.iterationCount >= 5"
```

Supported operators: `!`, `&&`, `||`, `>`, `<`, `>=`, `<=`, `==`, `!=`

### Custom Stage Handlers

Register custom handlers for domain-specific pipeline stages:

```ts
import type { IStageHandler, PipelineContext } from '@mcp-abap-adt/llm-agent';
import type { ISpan } from '@mcp-abap-adt/llm-agent';

class ContentFilterHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    config: Record<string, unknown>,
    span: ISpan,
  ): Promise<boolean> {
    const blockedPatterns = (config.patterns as string[]) ?? [];
    for (const pattern of blockedPatterns) {
      if (new RegExp(pattern, 'i').test(ctx.inputText)) {
        ctx.error = `Input matched blocked pattern: ${pattern}`;
        return false; // abort pipeline
      }
    }
    return true; // continue
  }
}

// Register via builder
builder.withStageHandler('content-filter', new ContentFilterHandler());
```

Then use in YAML:

```yaml
stages:
  - id: filter
    type: content-filter
    config:
      patterns: ["DROP TABLE", "rm -rf"]
  - id: classify
    type: classify
  # ...
```

### Parallel Execution with Sequential Follow-up

The `parallel` type runs `stages` concurrently, then runs `after` stages sequentially:

```yaml
- id: rag-retrieval
  type: parallel
  stages:
    # These run concurrently
    - { id: translate, type: translate }
    - { id: expand, type: expand }
  after:
    # These run sequentially after all parallel stages complete
    - id: queries
      type: parallel
      stages:
        - { id: facts, type: rag-query, config: { store: facts } }
        - { id: state, type: rag-query, config: { store: state } }
    - { id: rerank, type: rerank }
```

### Repeat (Loop) Stages

The `repeat` type loops child stages until a condition or max iterations:

```yaml
- id: retry-loop
  type: repeat
  maxIterations: 3
  until: "state.validationPassed"
  stages:
    - { id: tool-loop, type: tool-loop }
    - { id: validate, type: my-validator }
```

### Minimal Pipeline (Skip RAG)

For simple LLM-only use cases, define a minimal pipeline:

```yaml
pipeline:
  version: "1"
  stages:
    - id: classify
      type: classify
    - id: assemble
      type: assemble
    - id: tool-loop
      type: tool-loop
```

### Using Default Stages as Base

```ts
import { getDefaultStages } from '@mcp-abap-adt/llm-agent';

// Get default stages and insert a custom stage before tool-loop
const stages = getDefaultStages();
const toolLoopIndex = stages.findIndex(s => s.id === 'tool-loop');
stages.splice(toolLoopIndex, 0, {
  id: 'audit',
  type: 'audit-log',
  config: { level: 'info' },
});

builder.withPipeline({ version: '1', stages });
```

### Plugin System

The library provides a plugin system for loading custom implementations from external sources. It uses the same DI pattern as the rest of the library: an interface with a default implementation.

#### IPluginLoader interface

```ts
interface IPluginLoader {
  load(): Promise<LoadedPlugins>;
}
```

The loader discovers plugins and returns merged registrations. The library ships `FileSystemPluginLoader` as the default — consumers can replace it with their own implementation.

#### PluginExports — what a plugin provides

All fields are optional — a plugin can register any subset:

| Export               | Type                              | Effect                          |
|----------------------|-----------------------------------|---------------------------------|
| `stageHandlers`      | `Record<string, IStageHandler>`   | Available in YAML `type:`       |
| `embedderFactories`  | `Record<string, EmbedderFactory>` | Available in YAML `rag.embedder:` |
| `reranker`           | `IReranker`                       | Replaces default reranker       |
| `queryExpander`      | `IQueryExpander`                  | Replaces default query expander |
| `outputValidator`    | `IOutputValidator`                | Replaces default validator      |
| `skillManager`       | `ISkillManager`                   | Replaces default skill manager  |
| `mcpClients`         | `IMcpClient[]`                    | Accumulated MCP clients         |

#### Option 1: FileSystemPluginLoader (default)

Drop plugin files into a directory. SmartServer scans and loads them at startup.

**Plugin directories** (load order, later wins):

1. `~/.config/llm-agent/plugins/` — user-level
2. `./plugins/` — project-level (relative to cwd)
3. `--plugin-dir <path>` CLI flag or `pluginDir` in YAML config

**Example plugin file** (`~/.config/llm-agent/plugins/audit-log.ts`):

```ts
import type { IStageHandler, PipelineContext, ISpan } from '@mcp-abap-adt/llm-agent';

class AuditLogHandler implements IStageHandler {
  async execute(ctx: PipelineContext, config: Record<string, unknown>, span: ISpan) {
    console.log(`[audit] ${ctx.inputText.slice(0, 100)}`);
    return true;
  }
}

export const stageHandlers = {
  'audit-log': new AuditLogHandler(),
};
```

**YAML config** (`smart-server.yaml`):

```yaml
pluginDir: ./my-plugins

pipeline:
  version: "1"
  stages:
    - id: audit
      type: audit-log      # resolved from plugin
    - id: classify
      type: classify
    # ...
```

**Programmatic usage:**

```ts
import { FileSystemPluginLoader, getDefaultPluginDirs } from '@mcp-abap-adt/llm-agent';

const loader = new FileSystemPluginLoader({
  dirs: [...getDefaultPluginDirs(), './my-extra-plugins'],
});
builder.withPluginLoader(loader);
```

Only `.js`, `.mjs`, and `.ts` files are loaded. Subdirectories are ignored.

#### Option 2: Custom plugin loader (npm packages, etc.)

Replace the filesystem scanner with your own discovery mechanism:

```ts
import {
  IPluginLoader,
  LoadedPlugins,
  emptyLoadedPlugins,
  mergePluginExports,
} from '@mcp-abap-adt/llm-agent';

class NpmPluginLoader implements IPluginLoader {
  constructor(private packages: string[]) {}

  async load(): Promise<LoadedPlugins> {
    const result = emptyLoadedPlugins();
    for (const pkg of this.packages) {
      try {
        const mod = await import(pkg);
        mergePluginExports(result, mod, pkg);
      } catch (err) {
        result.errors.push({
          file: pkg,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }
}

// Use via builder
builder.withPluginLoader(new NpmPluginLoader([
  '@my-org/llm-plugin-audit',
  '@my-org/llm-plugin-cohere-embedder',
]));

// Or via SmartServer config
const server = new SmartServer({
  ...config,
  pluginLoader: new NpmPluginLoader(['@my-org/llm-plugin-audit']),
});
```

#### Option 3: Composite loader (multiple sources)

Combine multiple loaders into one:

```ts
class CompositePluginLoader implements IPluginLoader {
  constructor(private loaders: IPluginLoader[]) {}

  async load(): Promise<LoadedPlugins> {
    const result = emptyLoadedPlugins();
    for (const loader of this.loaders) {
      const plugins = await loader.load();
      // Merge each loader's results (later wins)
      for (const [type, handler] of plugins.stageHandlers) {
        result.stageHandlers.set(type, handler);
      }
      Object.assign(result.embedderFactories, plugins.embedderFactories);
      if (plugins.reranker) result.reranker = plugins.reranker;
      if (plugins.queryExpander) result.queryExpander = plugins.queryExpander;
      if (plugins.outputValidator) result.outputValidator = plugins.outputValidator;
      result.mcpClients.push(...plugins.mcpClients);
      result.loadedFiles.push(...plugins.loadedFiles);
      result.errors.push(...plugins.errors);
    }
    return result;
  }
}

builder.withPluginLoader(new CompositePluginLoader([
  new FileSystemPluginLoader({ dirs: getDefaultPluginDirs() }),
  new NpmPluginLoader(['@my-org/llm-plugin-audit']),
]));
```

#### Precedence

```
builder.withXxx()  >  plugin loader  >  built-in defaults
```

Explicit builder calls (`withReranker()`, `withStageHandler()`, etc.) always take precedence over plugin-loaded registrations. This allows consumers to override individual plugin components without replacing the entire loader.

#### Helper utilities for custom loaders

| Function | Purpose |
|----------|---------|
| `emptyLoadedPlugins()` | Creates an empty `LoadedPlugins` — starting point for custom loaders |
| `mergePluginExports(result, mod, source)` | Merges one module's exports into a `LoadedPlugins` result |
| `getDefaultPluginDirs()` | Returns default directories (`~/.config/llm-agent/plugins/`, `./plugins/`) |

#### Performance note

Plugin loading happens **once at startup** (during `builder.build()` or `SmartServer.start()`), not per request. Loaded handlers are plain objects in memory — zero runtime overhead compared to direct builder wiring.

See [`docs/examples/plugins/`](examples/plugins/) for 6 complete plugin examples covering all export types.

## Test Doubles

The library exports comprehensive test double factories via `@mcp-abap-adt/llm-agent/testing`:

```ts
import {
  makeLlm,
  makeRag,
  makeMcpClient,
  makeClassifier,
  makeAssembler,
  makeCapturingLogger,
  makeCapturingTracer,
  makeCapturingMetrics,
  makeReranker,
  makeQueryExpander,
  makeToolCache,
  makeOutputValidator,
  makeSessionManager,
  makeDefaultDeps,
} from '@mcp-abap-adt/llm-agent/testing';
```

### Example: Testing a custom validator

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeLlm, makeDefaultDeps } from '@mcp-abap-adt/llm-agent/testing';

describe('JsonSchemaValidator', () => {
  it('rejects invalid JSON', async () => {
    const validator = new JsonSchemaValidator({ type: 'object' });
    const result = await validator.validate(
      'not json',
      { messages: [], tools: [] },
    );
    assert.ok(result.ok);
    assert.equal(result.value.valid, false);
  });
});
```

### makeDefaultDeps — full pipeline testing

```ts
const { llm, deps } = makeDefaultDeps({
  llmResponses: [
    { content: '{"answer": 42}', finishReason: 'stop' },
  ],
  classifier: makeClassifier([{ type: 'action', text: 'compute answer' }]),
  outputValidator: new JsonSchemaValidator(mySchema),
});

const agent = new SmartAgent(deps, { maxIterations: 5, maxToolCalls: 10, ragQueryK: 5 });
const result = await agent.process('What is the answer?');
assert.equal(llm.callCount, 1);
```
