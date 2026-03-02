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
import type { ILlm } from '@mcp-abap-adt/llm-agent/smart-server';
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
import type { IRag } from '@mcp-abap-adt/llm-agent/smart-server';
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
}
```

### Example: Wrapping a non-MCP REST API catalog

```ts
import type { IMcpClient } from '@mcp-abap-adt/llm-agent/smart-server';
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

Wire all custom components via `SmartAgentBuilder`:

```ts
import { SmartAgentBuilder } from '@mcp-abap-adt/llm-agent/smart-server';
import { ToolCache, SessionManager, InMemoryMetrics } from '@mcp-abap-adt/llm-agent';

const metrics = new InMemoryMetrics();

const handle = await new SmartAgentBuilder({
  llm: { apiKey: process.env.API_KEY! },
  rag: { type: 'qdrant', url: 'http://qdrant:6333' },
  mcp: { type: 'http', url: 'http://localhost:3001/mcp/stream/http' },
})
  .withReranker(new CrossEncoderReranker('http://reranker:8080/rerank'))
  .withOutputValidator(new JsonSchemaValidator(mySchema))
  .withToolCache(new ToolCache({ ttlMs: 60_000 }))
  .withSessionManager(new SessionManager({ tokenBudget: 100_000 }))
  .withMetrics(metrics)
  .withQueryExpander(new SapTermExpander())
  .withCircuitBreaker({ failureThreshold: 5, recoveryWindowMs: 30_000 })
  .build();

// Use the agent
const result = await handle.agent.process('Read the source of class ZCL_MY_CLASS');
console.log(result.content);

// Cleanup
await handle.close();
```

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
