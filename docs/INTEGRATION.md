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

## IRag

**File:** `src/smart-agent/interfaces/rag.ts`

RAG store for document upsert, query, and health checks:

```ts
interface IRag {
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
      const vector = await this.embedder.embed(text, options);
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
      const vector = await this.embedder.embed(text, options);
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
interface IEmbedder {
  embed(text: string, options?: CallOptions): Promise<number[]>;
}
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

The `SmartAgentBuilder` is interface-only — it has no knowledge of concrete providers. All dependencies must be injected:

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
  .withSessionManager(new SessionManager({ tokenBudget: 100_000 }))
  .withMetrics(metrics)
  .withQueryExpander(new SapTermExpander())
  .withSkillManager(new ClaudeSkillManager(process.cwd()))
  .withCircuitBreaker({ failureThreshold: 5, recoveryWindowMs: 30_000 })
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
