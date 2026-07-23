/**
 * Gap tests for vectorizeMcpTools — RED until mcp/vectorize-mcp-tools.ts exists.
 *
 * These tests import directly from the new module path. They FAIL on the
 * missing module until step 2b creates it, confirming the surface is new.
 * After step 2b they turn GREEN, proving behavior preservation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  IEmbedResult,
  ILogger,
  IMcpClient,
  IRag,
  IRagBackendWriter,
  IRequestLogger,
  LlmTool,
  LogEvent,
} from '@mcp-abap-adt/llm-agent';
import {
  CircuitBreaker,
  CircuitBreakerEmbedder,
  McpError,
} from '@mcp-abap-adt/llm-agent';

// Import from the new module path (RED until 2b)
import { vectorizeMcpTools } from '../mcp/vectorize-mcp-tools.js';

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

interface LlmCallEntry {
  component: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  estimated: boolean;
  scope?: string;
  detail?: string;
}

class CapturingRequestLogger implements IRequestLogger {
  calls: LlmCallEntry[] = [];
  logLlmCall(entry: LlmCallEntry): void {
    this.calls.push(entry);
  }
}

class CapturingLogger implements ILogger {
  events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

function makeTool(name: string): LlmTool {
  return { name, description: `desc of ${name}`, parameters: {} };
}

function makeClient(tools: LlmTool[]): IMcpClient {
  return {
    listTools: async () => ({ ok: true as const, value: tools }),
    callTool: async () => ({ ok: true as const, value: { content: [] } }),
  } as unknown as IMcpClient;
}

function makeWriter(opts?: {
  failUpsert?: boolean;
  hasBatchRaw?: boolean;
}): IRagBackendWriter & { upsertCalls: string[]; precomputedCalls: string[] } {
  const upsertCalls: string[] = [];
  const precomputedCalls: string[] = [];
  return {
    upsertCalls,
    precomputedCalls,
    async upsertRaw(id: string, _text: string, _meta: object) {
      upsertCalls.push(id);
      if (opts?.failUpsert)
        return { ok: false as const, error: new Error('write error') };
      return { ok: true as const, value: undefined };
    },
    ...(opts?.hasBatchRaw
      ? {
          async upsertPrecomputedRaw(
            id: string,
            _text: string,
            _vec: number[],
            _meta: object,
          ) {
            precomputedCalls.push(id);
            if (opts?.failUpsert)
              return { ok: false as const, error: new Error('write error') };
            return { ok: true as const, value: undefined };
          },
        }
      : {}),
  } as unknown as IRagBackendWriter & {
    upsertCalls: string[];
    precomputedCalls: string[];
  };
}

function makeBatchEmbedder(opts?: { throwOnBatch?: boolean }): {
  embed: (text: string) => Promise<IEmbedResult>;
  embedBatch: (texts: string[]) => Promise<IEmbedResult[]>;
} {
  return {
    async embed(_text: string): Promise<IEmbedResult> {
      return { vector: [0.1] };
    },
    async embedBatch(texts: string[]): Promise<IEmbedResult[]> {
      if (opts?.throwOnBatch) throw new Error('batch embed error');
      return texts.map((_, i) => ({ vector: [i * 0.1] }));
    },
  };
}

function makeRagWithEmbedder(
  embedder: object | undefined,
  writer: IRagBackendWriter,
): IRag {
  const rag: IRag = {
    query: async () => [],
    lookup: async () => undefined,
    writer: () => writer,
  } as unknown as IRag;
  if (embedder !== undefined) {
    (rag as unknown as Record<string, unknown>).embedder = embedder;
  }
  return rag;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vectorizeMcpTools', () => {
  it('Batch path: uses embedBatch once for all tools, upsertPrecomputedRaw per tool, single logLlmCall', async () => {
    const tools = [makeTool('tool-a'), makeTool('tool-b')];
    const writer = makeWriter({ hasBatchRaw: true });
    const batchEmbedder = makeBatchEmbedder();
    const rag = makeRagWithEmbedder(batchEmbedder, writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeMcpTools([makeClient(tools)], rag, reqLogger, logger);

    // upsertPrecomputedRaw called per tool
    assert.equal(writer.precomputedCalls.length, 2);
    assert.ok(writer.precomputedCalls.includes('tool:tool-a'));
    assert.ok(writer.precomputedCalls.includes('tool:tool-b'));
    // upsertRaw NOT called
    assert.equal(writer.upsertCalls.length, 0);
    // single logLlmCall with correct shape
    assert.equal(reqLogger.calls.length, 1);
    const call = reqLogger.calls[0];
    assert.equal(call.component, 'embedding');
    assert.equal(call.detail, 'tools');
    assert.equal(call.scope, 'initialization');
    // exactly one summary line, and it reports a complete catalog
    const warnings = logger.events.filter((e) => e.type === 'warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /^vectorized \d+\/\d+ MCP tools$/);
  });

  it('Sequential fallback: batch throws → per-tool upsertRaw, per-tool logLlmCall', async () => {
    const tools = [makeTool('tool-a'), makeTool('tool-b')];
    const writer = makeWriter({ hasBatchRaw: true });
    const batchEmbedder = makeBatchEmbedder({ throwOnBatch: true });
    const rag = makeRagWithEmbedder(batchEmbedder, writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeMcpTools([makeClient(tools)], rag, reqLogger, logger);

    // Still ONE warning, but it must carry the provider's reason: swallowing it
    // would hide exactly the message that made #236 diagnosable.
    const warnings = logger.events.filter((e) => e.type === 'warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /^vectorized /);
    assert.match(warnings[0].message, /sequential fallback: batch embed error/);
    // per-tool sequential upsert
    assert.equal(writer.upsertCalls.length, 2);
    assert.ok(writer.upsertCalls.includes('tool:tool-a'));
    assert.ok(writer.upsertCalls.includes('tool:tool-b'));
    // per-tool logLlmCall
    assert.equal(reqLogger.calls.length, 2);
    assert.ok(reqLogger.calls.every((c) => c.estimated === true));
  });

  it('Sequential-only: no batch embedder → per-tool upsertRaw + per-tool estimated logLlmCall, no embedBatch', async () => {
    const tools = [makeTool('tool-x')];
    const writer = makeWriter();
    const rag = makeRagWithEmbedder(undefined, writer); // no embedder
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeMcpTools([makeClient(tools)], rag, reqLogger, logger);

    assert.equal(writer.upsertCalls.length, 1);
    assert.equal(writer.upsertCalls[0], 'tool:tool-x');
    assert.equal(reqLogger.calls.length, 1);
    assert.equal(reqLogger.calls[0].estimated, true);
    assert.equal(reqLogger.calls[0].detail, 'tools');
  });

  it('Failure summary: upsertRaw returning {ok:false} lands in the summary', async () => {
    const tools = [makeTool('bad-tool')];
    const writer = makeWriter({ failUpsert: true });
    const rag = makeRagWithEmbedder(undefined, writer);
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    const summary = await vectorizeMcpTools(
      [makeClient(tools)],
      rag,
      reqLogger,
      logger,
    );

    // One aggregated line replaces the per-tool warning.
    const warnings = logger.events.filter((e) => e.type === 'warning');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /1 failed: bad-tool/);
    assert.deepEqual(summary?.failed, ['bad-tool']);
    assert.equal(summary?.complete, false);
  });

  it('Guard: toolsRag undefined → no-op, no throw, no logging', async () => {
    const tools = [makeTool('tool-z')];
    const reqLogger = new CapturingRequestLogger();
    const logger = new CapturingLogger();

    await vectorizeMcpTools([makeClient(tools)], undefined, reqLogger, logger);

    assert.equal(reqLogger.calls.length, 0);
    assert.equal(logger.events.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Summary contract (#236)
// ---------------------------------------------------------------------------

function makeFailingListClient(): IMcpClient {
  return {
    listTools: async () => ({
      ok: false as const,
      error: new McpError('down', 'MCP_ERROR'),
    }),
  } as unknown as IMcpClient;
}

/** Writer whose upsertRaw resolves to undefined — the optional-chain trap. */
function makeUndefinedWriter(): IRagBackendWriter {
  return { upsertRaw: async () => undefined } as unknown as IRagBackendWriter;
}

/** Writer that throws on the first call and succeeds afterwards. */
function makeThrowOnceWriter(): IRagBackendWriter {
  let n = 0;
  return {
    upsertRaw: async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return { ok: true as const, value: undefined };
    },
  } as unknown as IRagBackendWriter;
}

describe('vectorizeMcpTools summary', () => {
  it('aggregates across clients and flags a listTools failure', async () => {
    const rag = makeRagWithEmbedder(undefined, makeWriter());
    const summary = await vectorizeMcpTools(
      [makeClient([makeTool('A')]), makeFailingListClient()],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary?.total, 1);
    assert.equal(summary?.vectorized, 1);
    assert.equal(summary?.clientFailures, 1);
    assert.equal(summary?.complete, false);
  });

  it('counts a write that resolves to undefined as failed', async () => {
    const rag = makeRagWithEmbedder(undefined, makeUndefinedWriter());
    const summary = await vectorizeMcpTools(
      [makeClient([makeTool('A')])],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary?.vectorized, 0);
    assert.deepEqual(summary?.failed, ['A']);
    assert.equal(summary?.complete, false);
  });

  it('charges a throwing write to the tool, not the client, and keeps going', async () => {
    const rag = makeRagWithEmbedder(undefined, makeThrowOnceWriter());
    const summary = await vectorizeMcpTools(
      [makeClient([makeTool('A'), makeTool('B')])],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.deepEqual(summary?.failed, ['A']);
    assert.equal(summary?.vectorized, 1);
    assert.equal(summary?.clientFailures, 0);
    assert.equal(summary?.total, 2);
  });

  it('logs exactly one usage record on the batch path', async () => {
    const reqLogger = new CapturingRequestLogger();
    const rag = makeRagWithEmbedder(
      makeBatchEmbedder(),
      makeWriter({ hasBatchRaw: true }),
    );
    await vectorizeMcpTools(
      [makeClient(['T0', 'T1', 'T2', 'T3', 'T4'].map(makeTool))],
      rag,
      reqLogger,
      undefined,
    );
    // One aggregated record for the embedBatch call — not one per tool.
    assert.equal(reqLogger.calls.length, 1);
  });

  it('returns undefined for a read-only store', async () => {
    const readOnly = { writer: () => undefined } as unknown as IRag;
    const summary = await vectorizeMcpTools(
      [makeClient([makeTool('A')])],
      readOnly,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary, undefined);
  });

  it('emits one warning, not one per tool', async () => {
    const logger = new CapturingLogger();
    const rag = makeRagWithEmbedder(
      undefined,
      makeWriter({ failUpsert: true }),
    );
    const tools = Array.from({ length: 20 }, (_, i) => makeTool(`T${i}`));
    await vectorizeMcpTools(
      [makeClient(tools)],
      rag,
      new CapturingRequestLogger(),
      logger,
    );
    assert.equal(logger.events.filter((e) => e.type === 'warning').length, 1);
  });

  it('completes the catalog when a pre-decorated embedder fakes batch support', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const liar = new CircuitBreakerEmbedder(
      { embed: async () => ({ vector: [0] }) },
      breaker,
    );
    const rag = makeRagWithEmbedder(liar, makeWriter({ hasBatchRaw: true }));
    const summary = await vectorizeMcpTools(
      [makeClient([makeTool('A')])],
      rag,
      new CapturingRequestLogger(),
      undefined,
    );
    assert.equal(summary?.complete, true);
    // The capability check throws BEFORE CircuitBreakerEmbedder's try block, so
    // recordFailure() is never reached and the breaker stays closed.
    assert.equal(breaker.state, 'closed');
  });
});
