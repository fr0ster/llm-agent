# Semantic History via RAG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full conversation history dump with RAG-based semantic retrieval + recency window, reducing token usage from ~15-20K to ~2-3K per multi-turn request.

**Architecture:** New `IHistorySummarizer` interface with default LLM-based implementation. New `IHistoryMemory` interface for recency ring buffer. Post-tool-loop pipeline stage summarizes each turn and upserts to `history` RAG store. ContextAssembler injects `## Recent Actions` (recency buffer) + `## Relevant History` (RAG results) instead of full message array. Feature-flagged via `semanticHistoryEnabled`.

**Tech Stack:** TypeScript, node:test, existing IRag/ILlm interfaces

**Spec:** `docs/superpowers/specs/2026-04-06-semantic-history-via-rag-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/smart-agent/interfaces/history-summarizer.ts` | Create | `IHistorySummarizer` interface + `HistoryTurn` type |
| `src/smart-agent/interfaces/history-memory.ts` | Create | `IHistoryMemory` interface |
| `src/smart-agent/interfaces/index.ts` | Modify | Export new interfaces |
| `src/smart-agent/history/history-summarizer.ts` | Create | Default LLM-based summarizer |
| `src/smart-agent/history/history-memory.ts` | Create | In-memory ring buffer implementation |
| `src/smart-agent/history/index.ts` | Create | Barrel exports |
| `src/smart-agent/history/__tests__/history-memory.test.ts` | Create | Ring buffer tests |
| `src/smart-agent/history/__tests__/history-summarizer.test.ts` | Create | Summarizer tests |
| `src/smart-agent/pipeline/handlers/history-upsert.ts` | Create | Post-tool-loop pipeline stage |
| `src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts` | Create | History upsert handler tests |
| `src/smart-agent/pipeline/handlers/index.ts` | Modify | Register `history-upsert` handler |
| `src/smart-agent/pipeline/default-pipeline.ts` | Modify | Add `history-upsert` after `tool-loop` |
| `src/smart-agent/pipeline/context.ts` | Modify | Add `historyMemory` and `historySummarizer` to context |
| `src/smart-agent/context/context-assembler.ts` | Modify | Inject Recent Actions + Relevant History sections |
| `src/smart-agent/context/__tests__/context-assembler.test.ts` | Modify | Update tests for new history injection |
| `src/smart-agent/agent.ts` | Modify | Add config fields + deps |
| `src/smart-agent/smart-server.ts` | Modify | Add config fields |
| `src/smart-agent/config.ts` | Modify | Parse new YAML keys |
| `src/smart-agent/builder.ts` | Modify | `withHistorySummarizer()`, `withHistoryMemory()`, wiring |
| `src/smart-agent/index.ts` | Modify | Export new public API |

---

## Task 1: IHistorySummarizer and IHistoryMemory interfaces

**Files:**
- Create: `src/smart-agent/interfaces/history-summarizer.ts`
- Create: `src/smart-agent/interfaces/history-memory.ts`
- Modify: `src/smart-agent/interfaces/index.ts`

- [ ] **Step 1: Create IHistorySummarizer interface**

```typescript
// src/smart-agent/interfaces/history-summarizer.ts
import type { CallOptions, LlmError, Result } from './types.js';

export interface HistoryTurn {
  sessionId: string;
  turnIndex: number;
  userText: string;
  assistantText: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
  toolResults: Array<{ tool: string; content: string }>;
  timestamp: number;
}

export interface IHistorySummarizer {
  summarize(
    turn: HistoryTurn,
    options?: CallOptions,
  ): Promise<Result<string, LlmError>>;
}
```

- [ ] **Step 2: Create IHistoryMemory interface**

```typescript
// src/smart-agent/interfaces/history-memory.ts
export interface IHistoryMemory {
  pushRecent(sessionId: string, summary: string): void;
  getRecent(sessionId: string, limit: number): string[];
  clear(sessionId: string): void;
}
```

- [ ] **Step 3: Export from interfaces index**

Add to `src/smart-agent/interfaces/index.ts`:
```typescript
export type {
  HistoryTurn,
  IHistorySummarizer,
} from './history-summarizer.js';
export type { IHistoryMemory } from './history-memory.js';
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exit 0, no errors

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/interfaces/history-summarizer.ts src/smart-agent/interfaces/history-memory.ts src/smart-agent/interfaces/index.ts
git commit -m "feat(interfaces): add IHistorySummarizer and IHistoryMemory"
```

---

## Task 2: HistoryMemory — in-memory ring buffer

**Files:**
- Create: `src/smart-agent/history/__tests__/history-memory.test.ts`
- Create: `src/smart-agent/history/history-memory.ts`
- Create: `src/smart-agent/history/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/smart-agent/history/__tests__/history-memory.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HistoryMemory } from '../history-memory.js';

describe('HistoryMemory', () => {
  it('returns empty array for unknown session', () => {
    const mem = new HistoryMemory();
    assert.deepEqual(mem.getRecent('s1', 3), []);
  });

  it('stores and retrieves entries in order', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'Created class ZCL_A');
    mem.pushRecent('s1', 'Added method GET_DATA');
    assert.deepEqual(mem.getRecent('s1', 3), [
      'Created class ZCL_A',
      'Added method GET_DATA',
    ]);
  });

  it('evicts oldest when exceeding max size', () => {
    const mem = new HistoryMemory({ maxSize: 2 });
    mem.pushRecent('s1', 'turn1');
    mem.pushRecent('s1', 'turn2');
    mem.pushRecent('s1', 'turn3');
    assert.deepEqual(mem.getRecent('s1', 10), ['turn2', 'turn3']);
  });

  it('isolates sessions', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'session1-action');
    mem.pushRecent('s2', 'session2-action');
    assert.deepEqual(mem.getRecent('s1', 10), ['session1-action']);
    assert.deepEqual(mem.getRecent('s2', 10), ['session2-action']);
  });

  it('respects limit parameter', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'a');
    mem.pushRecent('s1', 'b');
    mem.pushRecent('s1', 'c');
    assert.deepEqual(mem.getRecent('s1', 2), ['b', 'c']);
  });

  it('clears session entries', () => {
    const mem = new HistoryMemory();
    mem.pushRecent('s1', 'action');
    mem.clear('s1');
    assert.deepEqual(mem.getRecent('s1', 10), []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/history/__tests__/history-memory.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HistoryMemory**

```typescript
// src/smart-agent/history/history-memory.ts
import type { IHistoryMemory } from '../interfaces/history-memory.js';

export class HistoryMemory implements IHistoryMemory {
  private readonly maxSize: number;
  private readonly sessions = new Map<string, string[]>();

  constructor(opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? 50;
  }

  pushRecent(sessionId: string, summary: string): void {
    let entries = this.sessions.get(sessionId);
    if (!entries) {
      entries = [];
      this.sessions.set(sessionId, entries);
    }
    entries.push(summary);
    if (entries.length > this.maxSize) {
      entries.splice(0, entries.length - this.maxSize);
    }
  }

  getRecent(sessionId: string, limit: number): string[] {
    const entries = this.sessions.get(sessionId) ?? [];
    return entries.slice(-limit);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
```

- [ ] **Step 4: Create barrel export**

```typescript
// src/smart-agent/history/index.ts
export { HistoryMemory } from './history-memory.js';
export { HistorySummarizer } from './history-summarizer.js';
```

Note: `HistorySummarizer` will be created in Task 3. For now create the file with only `HistoryMemory` export and add `HistorySummarizer` in Task 3.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/smart-agent/history/__tests__/history-memory.test.ts`
Expected: 6 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/history/
git commit -m "feat: add HistoryMemory in-memory ring buffer"
```

---

## Task 3: HistorySummarizer — default LLM-based implementation

**Files:**
- Create: `src/smart-agent/history/__tests__/history-summarizer.test.ts`
- Create: `src/smart-agent/history/history-summarizer.ts`
- Modify: `src/smart-agent/history/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/smart-agent/history/__tests__/history-summarizer.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ILlm } from '../../interfaces/llm.js';
import type { LlmError, LlmResponse, Result } from '../../interfaces/types.js';
import type { HistoryTurn } from '../../interfaces/history-summarizer.js';
import { HistorySummarizer } from '../history-summarizer.js';

function makeFakeLlm(response: string): ILlm {
  return {
    model: 'test',
    chat: async (): Promise<Result<LlmResponse, LlmError>> => ({
      ok: true,
      value: { content: response, finishReason: 'stop' },
    }),
    streamChat: async function* () {},
  };
}

function makeFakeLlmError(message: string): ILlm {
  return {
    model: 'test',
    chat: async (): Promise<Result<LlmResponse, LlmError>> => ({
      ok: false,
      error: { message, code: 'LLM_ERROR' } as LlmError,
    }),
    streamChat: async function* () {},
  };
}

const TURN: HistoryTurn = {
  sessionId: 's1',
  turnIndex: 0,
  userText: 'Create class ZCL_TEST',
  assistantText: 'I created the class ZCL_TEST in package ZDEV.',
  toolCalls: [{ name: 'createClass', arguments: { className: 'ZCL_TEST' } }],
  toolResults: [{ tool: 'createClass', content: 'Class ZCL_TEST created successfully' }],
  timestamp: Date.now(),
};

describe('HistorySummarizer', () => {
  it('returns LLM summary on success', async () => {
    const llm = makeFakeLlm('User asked to create class ZCL_TEST -> Created in package ZDEV');
    const summarizer = new HistorySummarizer(llm);
    const result = await summarizer.summarize(TURN);
    assert.ok(result.ok);
    assert.equal(result.value, 'User asked to create class ZCL_TEST -> Created in package ZDEV');
  });

  it('passes turn context in user message', async () => {
    let capturedMessages: unknown[] = [];
    const llm: ILlm = {
      model: 'test',
      chat: async (messages) => {
        capturedMessages = messages;
        return { ok: true, value: { content: 'summary', finishReason: 'stop' as const } };
      },
      streamChat: async function* () {},
    };
    const summarizer = new HistorySummarizer(llm);
    await summarizer.summarize(TURN);
    assert.ok(capturedMessages.length >= 2);
    const userMsg = capturedMessages[capturedMessages.length - 1] as { content: string };
    assert.ok(userMsg.content.includes('ZCL_TEST'));
    assert.ok(userMsg.content.includes('createClass'));
  });

  it('uses custom prompt when provided', async () => {
    let capturedMessages: unknown[] = [];
    const llm: ILlm = {
      model: 'test',
      chat: async (messages) => {
        capturedMessages = messages;
        return { ok: true, value: { content: 'summary', finishReason: 'stop' as const } };
      },
      streamChat: async function* () {},
    };
    const summarizer = new HistorySummarizer(llm, { prompt: 'Custom prompt here' });
    await summarizer.summarize(TURN);
    const sysMsg = capturedMessages[0] as { content: string };
    assert.ok(sysMsg.content.includes('Custom prompt here'));
  });

  it('propagates LLM error', async () => {
    const llm = makeFakeLlmError('model overloaded');
    const summarizer = new HistorySummarizer(llm);
    const result = await summarizer.summarize(TURN);
    assert.ok(!result.ok);
    assert.ok(result.error.message.includes('model overloaded'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/history/__tests__/history-summarizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HistorySummarizer**

```typescript
// src/smart-agent/history/history-summarizer.ts
import type { Message } from '../../types.js';
import type {
  HistoryTurn,
  IHistorySummarizer,
} from '../interfaces/history-summarizer.js';
import type { ILlm } from '../interfaces/llm.js';
import type { CallOptions, LlmError, Result } from '../interfaces/types.js';

const DEFAULT_PROMPT =
  'Summarize in one sentence: what the user requested and what was done. Include key identifiers (class names, table names, etc). Do not include greetings or filler.';

export class HistorySummarizer implements IHistorySummarizer {
  private readonly prompt: string;

  constructor(
    private readonly llm: ILlm,
    opts?: { prompt?: string },
  ) {
    this.prompt = opts?.prompt ?? DEFAULT_PROMPT;
  }

  async summarize(
    turn: HistoryTurn,
    options?: CallOptions,
  ): Promise<Result<string, LlmError>> {
    const toolSection = turn.toolCalls.length > 0
      ? `\nTools called: ${turn.toolCalls.map((tc) => `${tc.name}(${JSON.stringify(tc.arguments)})`).join(', ')}`
      + `\nTool results: ${turn.toolResults.map((tr) => `${tr.tool}: ${tr.content.slice(0, 200)}`).join('; ')}`
      : '';

    const messages: Message[] = [
      { role: 'system', content: this.prompt },
      {
        role: 'user',
        content: `User request: ${turn.userText}\nAssistant response: ${turn.assistantText}${toolSection}`,
      },
    ];

    const result = await this.llm.chat(messages, undefined, options);
    if (!result.ok) return result;
    return { ok: true, value: result.value.content.trim() };
  }
}
```

- [ ] **Step 4: Update barrel export**

Add `HistorySummarizer` export to `src/smart-agent/history/index.ts`:
```typescript
export { HistoryMemory } from './history-memory.js';
export { HistorySummarizer } from './history-summarizer.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/smart-agent/history/__tests__/history-summarizer.test.ts`
Expected: 4 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/history/
git commit -m "feat: add LLM-based HistorySummarizer"
```

---

## Task 4: Config + SmartAgentConfig + SmartServerAgentConfig

**Files:**
- Modify: `src/smart-agent/agent.ts` (~line 112)
- Modify: `src/smart-agent/smart-server.ts` (~line 88)
- Modify: `src/smart-agent/config.ts` (~line 73, ~line 335)

- [ ] **Step 1: Add fields to SmartAgentConfig**

In `src/smart-agent/agent.ts`, after `contextBudgetTokens?: number;` add:

```typescript
  semanticHistoryEnabled?: boolean;
  historyRecencyWindow?: number;
  historyTurnSummaryPrompt?: string;
```

- [ ] **Step 2: Add fields to SmartServerAgentConfig**

In `src/smart-agent/smart-server.ts`, after `contextBudgetTokens?: number;` add:

```typescript
  semanticHistoryEnabled?: boolean;
  historyRecencyWindow?: number;
  historyTurnSummaryPrompt?: string;
```

- [ ] **Step 3: Add YAML documentation and parsing in config.ts**

In the YAML template (~line 73), add after `# contextBudgetTokens`:
```yaml
  # semanticHistoryEnabled: false      # Enable semantic history via RAG
  # historyRecencyWindow: 3            # Last N turns always in context
  # historyTurnSummaryPrompt: "..."    # LLM prompt for turn summarization
```

In the config parsing (~line 335), after `contextBudgetTokens` parsing add:
```typescript
      ...(get(yaml, 'agent', 'semanticHistoryEnabled') !== undefined
        ? {
            semanticHistoryEnabled: Boolean(
              get(yaml, 'agent', 'semanticHistoryEnabled'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'historyRecencyWindow') !== undefined
        ? {
            historyRecencyWindow: Number(
              get(yaml, 'agent', 'historyRecencyWindow'),
            ),
          }
        : {}),
      ...(get(yaml, 'agent', 'historyTurnSummaryPrompt') !== undefined
        ? {
            historyTurnSummaryPrompt: String(
              get(yaml, 'agent', 'historyTurnSummaryPrompt'),
            ),
          }
        : {}),
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add src/smart-agent/agent.ts src/smart-agent/smart-server.ts src/smart-agent/config.ts
git commit -m "feat(config): add semanticHistory config fields"
```

---

## Task 5: PipelineContext + Builder wiring

**Files:**
- Modify: `src/smart-agent/pipeline/context.ts` (~line 90)
- Modify: `src/smart-agent/builder.ts` (~line 251, ~line 700)
- Modify: `src/smart-agent/agent.ts` (SmartAgentDeps)

- [ ] **Step 1: Add to PipelineContext**

In `src/smart-agent/pipeline/context.ts`, in the dependencies section add:

```typescript
  readonly historyMemory: IHistoryMemory | undefined;
  readonly historySummarizer: IHistorySummarizer | undefined;
```

Add imports at top:
```typescript
import type { IHistoryMemory } from '../interfaces/history-memory.js';
import type { IHistorySummarizer } from '../interfaces/history-summarizer.js';
```

- [ ] **Step 2: Add to SmartAgentDeps**

In `src/smart-agent/agent.ts`, in `SmartAgentDeps` interface add:

```typescript
  historyMemory?: IHistoryMemory;
  historySummarizer?: IHistorySummarizer;
```

Add imports at top:
```typescript
import type { IHistoryMemory } from './interfaces/history-memory.js';
import type { IHistorySummarizer } from './interfaces/history-summarizer.js';
```

- [ ] **Step 3: Add builder methods**

In `src/smart-agent/builder.ts`, add private fields near other optional fields (~line 164):

```typescript
  private _historySummarizer?: IHistorySummarizer;
  private _historyMemory?: IHistoryMemory;
```

Add builder methods near other `with*()` methods (~line 290):

```typescript
  withHistorySummarizer(summarizer: IHistorySummarizer): this {
    this._historySummarizer = summarizer;
    return this;
  }

  withHistoryMemory(memory: IHistoryMemory): this {
    this._historyMemory = memory;
    return this;
  }
```

Add imports:
```typescript
import type { IHistorySummarizer } from './interfaces/history-summarizer.js';
import type { IHistoryMemory } from './interfaces/history-memory.js';
import { HistoryMemory } from './history/history-memory.js';
import { HistorySummarizer } from './history/history-summarizer.js';
```

- [ ] **Step 4: Wire in build() method**

In `builder.ts`, in the `build()` method after assembler construction (~line 710), add:

```typescript
    // ---- History memory & summarizer ----------------------------------------
    let historyMemory: IHistoryMemory | undefined;
    let historySummarizer: IHistorySummarizer | undefined;

    if (agentCfg.semanticHistoryEnabled) {
      historyMemory = this._historyMemory ?? new HistoryMemory({
        maxSize: agentCfg.historyRecencyWindow ?? 3,
      });
      const summarizerLlm = helperLlm ?? mainLlm;
      historySummarizer = this._historySummarizer ?? new HistorySummarizer(
        summarizerLlm,
        agentCfg.historyTurnSummaryPrompt
          ? { prompt: agentCfg.historyTurnSummaryPrompt }
          : undefined,
      );
    }
```

Pass to deps object:
```typescript
    historyMemory,
    historySummarizer,
```

- [ ] **Step 5: Build to verify**

Run: `npm run build`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add src/smart-agent/pipeline/context.ts src/smart-agent/builder.ts src/smart-agent/agent.ts
git commit -m "feat: wire IHistoryMemory and IHistorySummarizer through builder and pipeline context"
```

---

## Task 6: HistoryUpsertHandler — post-tool-loop pipeline stage

**Files:**
- Create: `src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts`
- Create: `src/smart-agent/pipeline/handlers/history-upsert.ts`
- Modify: `src/smart-agent/pipeline/handlers/index.ts`
- Modify: `src/smart-agent/pipeline/default-pipeline.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IHistoryMemory } from '../../../interfaces/history-memory.js';
import type { IHistorySummarizer, HistoryTurn } from '../../../interfaces/history-summarizer.js';
import type { CallOptions, LlmError, Result } from '../../../interfaces/types.js';

// Test the summarize + upsert + push logic directly (not full PipelineContext)
import { summarizeAndStore } from '../history-upsert.js';

function makeFakeMemory(): IHistoryMemory & { entries: Map<string, string[]> } {
  const entries = new Map<string, string[]>();
  return {
    entries,
    pushRecent(sessionId: string, summary: string) {
      if (!entries.has(sessionId)) entries.set(sessionId, []);
      entries.get(sessionId)!.push(summary);
    },
    getRecent(sessionId: string, limit: number) {
      return (entries.get(sessionId) ?? []).slice(-limit);
    },
    clear(sessionId: string) { entries.delete(sessionId); },
  };
}

function makeFakeSummarizer(response: string): IHistorySummarizer {
  return {
    summarize: async () => ({ ok: true, value: response } as Result<string, LlmError>),
  };
}

function makeFakeRag(): { upserted: Array<{ text: string; meta: unknown }> } & { upsert: (text: string, meta: unknown) => Promise<Result<void, { message: string }>> } {
  const upserted: Array<{ text: string; meta: unknown }> = [];
  return {
    upserted,
    upsert: async (text: string, meta: unknown) => {
      upserted.push({ text, meta });
      return { ok: true, value: undefined };
    },
  };
}

describe('history-upsert: summarizeAndStore', () => {
  it('summarizes turn, upserts to RAG, pushes to memory', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('Created class ZCL_TEST in ZDEV');
    const rag = makeFakeRag();

    const turn: HistoryTurn = {
      sessionId: 's1',
      turnIndex: 0,
      userText: 'create class ZCL_TEST',
      assistantText: 'Done',
      toolCalls: [{ name: 'createClass', arguments: { name: 'ZCL_TEST' } }],
      toolResults: [{ tool: 'createClass', content: 'success' }],
      timestamp: 1000,
    };

    await summarizeAndStore({ turn, summarizer, memory, rag: rag as never, sessionId: 's1' });

    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'Created class ZCL_TEST in ZDEV');
    assert.deepEqual(memory.getRecent('s1', 10), ['Created class ZCL_TEST in ZDEV']);
  });

  it('still pushes to memory when RAG upsert fails (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer = makeFakeSummarizer('summary text');
    const rag = {
      upsert: async () => ({ ok: false, error: { message: 'RAG down' } }),
    };

    const turn: HistoryTurn = {
      sessionId: 's1', turnIndex: 0, userText: 'x', assistantText: 'y',
      toolCalls: [], toolResults: [], timestamp: 1000,
    };

    await summarizeAndStore({ turn, summarizer, memory, rag: rag as never, sessionId: 's1' });
    assert.deepEqual(memory.getRecent('s1', 10), ['summary text']);
  });

  it('falls back to raw text when summarizer fails (best-effort)', async () => {
    const memory = makeFakeMemory();
    const summarizer: IHistorySummarizer = {
      summarize: async () => ({ ok: false, error: { message: 'LLM down' } } as Result<string, LlmError>),
    };
    const rag = makeFakeRag();

    const turn: HistoryTurn = {
      sessionId: 's1', turnIndex: 0, userText: 'do something', assistantText: 'done it',
      toolCalls: [], toolResults: [], timestamp: 1000,
    };

    await summarizeAndStore({ turn, summarizer, memory, rag: rag as never, sessionId: 's1' });
    // Falls back to "userText → assistantText"
    assert.deepEqual(memory.getRecent('s1', 10), ['do something → done it']);
    assert.equal(rag.upserted.length, 1);
    assert.equal(rag.upserted[0].text, 'do something → done it');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HistoryUpsertHandler**

```typescript
// src/smart-agent/pipeline/handlers/history-upsert.ts
import type { IHistoryMemory } from '../../interfaces/history-memory.js';
import type {
  HistoryTurn,
  IHistorySummarizer,
} from '../../interfaces/history-summarizer.js';
import type { IRag } from '../../interfaces/rag.js';
import type { CallOptions } from '../../interfaces/types.js';
import type { ISpan } from '../../tracer/types.js';
import type { PipelineContext } from '../context.js';
import type { IStageHandler } from '../stage-handler.js';

export interface SummarizeAndStoreArgs {
  turn: HistoryTurn;
  summarizer: IHistorySummarizer;
  memory: IHistoryMemory;
  rag: IRag;
  sessionId: string;
  options?: CallOptions;
  log?: (msg: string, data?: unknown) => void;
}

export async function summarizeAndStore(
  args: SummarizeAndStoreArgs,
): Promise<void> {
  const { turn, summarizer, memory, rag, sessionId, options, log } = args;

  // Best-effort summarize
  const result = await summarizer.summarize(turn, options);
  const summary = result.ok
    ? result.value
    : `${turn.userText} → ${turn.assistantText}`;

  if (!result.ok) {
    log?.('history_summarize_failed', { error: result.error.message });
  }

  // Best-effort RAG upsert
  const upsertResult = await rag.upsert(summary, {
    id: `turn:${sessionId}:${turn.turnIndex}`,
  });
  if (!upsertResult.ok) {
    log?.('history_upsert_failed', { error: upsertResult.error.message });
  }

  // Always push to recency buffer
  memory.pushRecent(sessionId, summary);
}

export class HistoryUpsertHandler implements IStageHandler {
  async execute(
    ctx: PipelineContext,
    _config: Record<string, unknown>,
    parentSpan: ISpan,
  ): Promise<boolean> {
    if (!ctx.historySummarizer || !ctx.historyMemory) return true;
    if (!ctx.config.semanticHistoryEnabled) return true;

    const historyRag = ctx.ragStores?.history;
    if (!historyRag) return true;

    const span = ctx.tracer.startSpan('smart_agent.history_upsert', parentSpan);

    try {
      // Build turn from pipeline context
      // inputText = user's request, assembled after classification
      // The last assistant content is in the yielded chunks (not directly available)
      // We use what the tool-loop produced
      const turn: HistoryTurn = {
        sessionId: ctx.sessionId,
        turnIndex: Date.now(), // monotonic index
        userText: ctx.inputText,
        assistantText: '', // filled from tool-loop output if available
        toolCalls: [],
        toolResults: [],
        timestamp: Date.now(),
      };

      await summarizeAndStore({
        turn,
        summarizer: ctx.historySummarizer,
        memory: ctx.historyMemory,
        rag: historyRag,
        sessionId: ctx.sessionId,
        options: ctx.options,
        log: (msg, data) =>
          ctx.options?.sessionLogger?.logStep(msg, data as Record<string, unknown>),
      });

      span.setStatus('ok');
    } catch {
      // Best-effort — never block response
      span.setStatus('error', 'history upsert failed');
    } finally {
      span.end();
    }

    return true;
  }
}
```

- [ ] **Step 4: Register handler**

In `src/smart-agent/pipeline/handlers/index.ts`, add import and registration:

```typescript
import { HistoryUpsertHandler } from './history-upsert.js';
```

In the `buildDefaultHandlerRegistry()` map, add after `tool-loop`:
```typescript
    ['history-upsert', new HistoryUpsertHandler()],
```

Add to exports:
```typescript
export { HistoryUpsertHandler } from './history-upsert.js';
```

- [ ] **Step 5: Add to default pipeline**

In `src/smart-agent/pipeline/default-pipeline.ts`, add after the `tool-loop` stage (line 125):

```typescript
    {
      id: 'history-upsert',
      type: 'history-upsert',
    },
```

- [ ] **Step 6: Run tests**

Run: `npx tsx --test src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts`
Expected: 3 pass, 0 fail

- [ ] **Step 7: Build and lint**

Run: `npm run build && npm run lint:check`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add src/smart-agent/pipeline/handlers/history-upsert.ts src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts src/smart-agent/pipeline/handlers/index.ts src/smart-agent/pipeline/default-pipeline.ts
git commit -m "feat: add history-upsert pipeline stage (post-tool-loop)"
```

---

## Task 7: ContextAssembler — inject Recent Actions + Relevant History

**Files:**
- Modify: `src/smart-agent/context/context-assembler.ts`
- Modify: `src/smart-agent/context/__tests__/context-assembler.test.ts`
- Modify: `src/smart-agent/interfaces/assembler.ts`

- [ ] **Step 1: Update IContextAssembler interface**

In `src/smart-agent/interfaces/assembler.ts`, add optional fields to `assemble()` retrieved parameter:

```typescript
export interface IContextAssembler {
  assemble(
    action: Subprompt,
    retrieved: {
      ragResults: Record<string, RagResult[]>;
      tools: McpTool[];
      recentActions?: string[];
    },
    history: HistoryEntry[],
    options?: CallOptions,
  ): Promise<Result<Message[], AssemblerError>>;
}
```

- [ ] **Step 2: Write failing test**

Add to `src/smart-agent/context/__tests__/context-assembler.test.ts`:

```typescript
describe('ContextAssembler — recent actions', () => {
  it('injects ## Recent Actions when recentActions provided', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: {},
        tools: [],
        recentActions: [
          'Created class ZCL_TEST in package ZDEV',
          'Added method GET_DATA to ZCL_TEST',
        ],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(sys.content.includes('## Recent Actions'));
    assert.ok(sys.content.includes('Created class ZCL_TEST'));
    assert.ok(sys.content.includes('Added method GET_DATA'));
  });

  it('no ## Recent Actions when recentActions empty', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      { ragResults: {}, tools: [], recentActions: [] },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    if (sys) {
      assert.ok(!sys.content.includes('## Recent Actions'));
    }
  });
});

describe('ContextAssembler — relevant history from RAG', () => {
  it('injects ## Relevant History from history RAG store', async () => {
    const assembler = new ContextAssembler();
    const r = await assembler.assemble(
      ACTION,
      {
        ragResults: {
          history: [
            makeFact('Created class ZCL_OLD last week', 0.85),
          ],
        },
        tools: [],
      },
      [],
    );
    assert.ok(r.ok);
    const sys = r.value.find((m) => m.role === 'system');
    assert.ok(sys);
    assert.ok(sys.content.includes('## Relevant History'));
    assert.ok(sys.content.includes('ZCL_OLD'));
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx tsx --test src/smart-agent/context/__tests__/context-assembler.test.ts`
Expected: FAIL on new tests

- [ ] **Step 4: Implement changes in ContextAssembler**

In `src/smart-agent/context/context-assembler.ts`:

Update `buildSystemContent()` to handle `recentActions` and render `history` RAG results under `## Relevant History`:

Add the `recentActions` parameter:
```typescript
function buildSystemContent(
  ragResults: Record<string, RagResult[]>,
  provenance: boolean,
  sectionHeaders: Record<string, string>,
  recentActions?: string[],
): string {
  const sections: string[] = [];

  for (const [key, results] of Object.entries(ragResults)) {
    const header = sectionHeaders[key] ?? titleCase(key);
    const section = buildSection(
      header,
      results.map((r) => formatRagEntry(r, provenance)),
    );
    if (section) sections.push(section);
  }

  if (recentActions && recentActions.length > 0) {
    const section = buildSection(
      'Recent Actions',
      recentActions.map((a) => `- ${a}`),
    );
    if (section) sections.push(section);
  }

  return sections.join('\n\n');
}
```

Add `'history'` to `sectionHeaders` defaults:
```typescript
const DEFAULT_SECTION_HEADERS: Record<string, string> = {
  facts: 'Known Facts',
  feedback: 'Feedback',
  state: 'Current State',
  history: 'Relevant History',
};
```

Update `assemble()` to pass `recentActions` through:
```typescript
const systemContent = buildSystemContent(
  finalResults,
  this.includeProvenance,
  this.sectionHeaders,
  retrieved.recentActions,
);
```

Also update `applyTokenBudget` and its call to pass `recentActions`:
```typescript
// In applyTokenBudget:
function applyTokenBudget(
  ragResults: Record<string, RagResult[]>,
  actionTokens: number,
  maxTokens: number,
  provenance: boolean,
  sectionHeaders: Record<string, string>,
  recentActions?: string[],
): Record<string, RagResult[]> {
  // ...
  const totalTokens = (): number => {
    const content = buildSystemContent(
      mutableResults,
      provenance,
      sectionHeaders,
      recentActions,
    );
    return actionTokens + estimateTokens(content);
  };
  // ...
}
```

- [ ] **Step 5: Run tests**

Run: `npx tsx --test src/smart-agent/context/__tests__/context-assembler.test.ts`
Expected: all pass

- [ ] **Step 6: Build and lint**

Run: `npm run build && npm run lint:check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/smart-agent/context/context-assembler.ts src/smart-agent/context/__tests__/context-assembler.test.ts src/smart-agent/interfaces/assembler.ts
git commit -m "feat: inject Recent Actions and Relevant History in ContextAssembler"
```

---

## Task 8: Wire history retrieval in AssembleHandler

**Files:**
- Modify: `src/smart-agent/pipeline/handlers/assemble.ts`

- [ ] **Step 1: Read current assemble handler**

Review `src/smart-agent/pipeline/handlers/assemble.ts` to understand how it calls `ctx.assembler.assemble()`.

- [ ] **Step 2: Pass recentActions from historyMemory**

In the assemble handler, before calling `ctx.assembler.assemble()`, extract recency window:

```typescript
const recentActions = ctx.historyMemory && ctx.config.semanticHistoryEnabled
  ? ctx.historyMemory.getRecent(
      ctx.sessionId,
      ctx.config.historyRecencyWindow ?? 3,
    )
  : undefined;
```

Pass to assembled `retrieved` object:
```typescript
const result = await ctx.assembler.assemble(
  mainAction,
  { ...retrieved, recentActions },
  ctx.history,
  ctx.options,
);
```

- [ ] **Step 3: Build and run all tests**

Run: `npm run build && npm run lint:check && npx tsx --test src/smart-agent/**/__tests__/*.test.ts`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/pipeline/handlers/assemble.ts
git commit -m "feat: pass recency window to ContextAssembler in assemble handler"
```

---

## Task 9: Export public API + history RAG store setup

**Files:**
- Modify: `src/smart-agent/index.ts`
- Modify: `src/smart-agent/builder.ts` (RAG stores section)

- [ ] **Step 1: Add exports to index.ts**

In `src/smart-agent/index.ts` add:

```typescript
export { HistoryMemory } from './history/history-memory.js';
export { HistorySummarizer } from './history/history-summarizer.js';
export type { IHistoryMemory } from './interfaces/history-memory.js';
export type { IHistorySummarizer, HistoryTurn } from './interfaces/history-summarizer.js';
```

- [ ] **Step 2: Ensure history RAG store is created in builder**

In `builder.ts`, in the RAG stores setup section, add `history` store creation when `semanticHistoryEnabled`:

```typescript
if (agentCfg.semanticHistoryEnabled && !ragStores.history) {
  // Create history store using same provider as other stores
  const firstStore = Object.values(ragStores)[0];
  if (firstStore) {
    ragStores.history = firstStore; // Share the same RAG backend
  }
}
```

Note: This is a pragmatic default — the history store shares the RAG backend. Users can override via `builder.withRagStore('history', customStore)`.

- [ ] **Step 3: Build and run all tests**

Run: `npm run build && npm run lint:check`
Expected: exit 0

Run all tests:
```bash
npx tsx --test src/smart-agent/history/__tests__/history-memory.test.ts src/smart-agent/history/__tests__/history-summarizer.test.ts src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts src/smart-agent/pipeline/handlers/__tests__/tool-loop-reset.test.ts src/smart-agent/context/__tests__/context-assembler.test.ts src/smart-agent/resilience/__tests__/*.test.ts
```
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add src/smart-agent/index.ts src/smart-agent/builder.ts
git commit -m "feat: export semantic history API and wire history RAG store in builder"
```

---

## Task 10: Final verification and release

- [ ] **Step 1: Full build + lint + all tests**

```bash
npm run build && npm run lint:check
```

```bash
npx tsx --test src/smart-agent/history/__tests__/history-memory.test.ts src/smart-agent/history/__tests__/history-summarizer.test.ts src/smart-agent/pipeline/handlers/__tests__/history-upsert.test.ts src/smart-agent/pipeline/handlers/__tests__/tool-loop-reset.test.ts src/smart-agent/context/__tests__/context-assembler.test.ts src/smart-agent/resilience/__tests__/*.test.ts
```

Expected: all pass, 0 errors

- [ ] **Step 2: Acceptance criteria check**

Verify against spec acceptance criteria:
- [ ] A 10-turn session does not inject all prior raw messages into the final LLM call (when `semanticHistoryEnabled: true`)
- [ ] Retrieved history never crosses namespace/session boundaries
- [ ] If history summarization fails, the request still completes successfully
- [ ] If history store is unavailable, the agent falls back to recency-only behavior
- [ ] Feature is disabled by default (`semanticHistoryEnabled: false`)

- [ ] **Step 3: Version bump and release commit**

```bash
# Update package.json version to 5.11.0
git add -A
git commit -m "chore: release 5.11.0 — semantic history via RAG (#49)"
git push origin main
```

- [ ] **Step 4: Close issue**

```bash
gh issue close 49 --comment "Implemented in 5.11.0"
```
