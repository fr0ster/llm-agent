/**
 * Regression test for the SmartAgentBuilder auto-toolsRag → subagent
 * context-builder wiring bug (fixed in a274ca6).
 *
 * The bug: when MCP is configured + an embedder is available, `build()`
 * auto-creates a local `InMemoryRag` as the tools RAG. The coordinator's
 * `toolSource` used to be derived from `this._toolsRag` (which is `undefined`
 * unless the caller explicitly invoked `withToolsRag()`/`setToolsRag()`),
 * NOT from the local `toolsRag`. As a result, constrained subagents
 * (`contextPolicy: 'required'`) had no `toolSource` wired into their
 * context builder.
 *
 * The fix: pass the local `toolsRag` into `buildRetrievalSource(...)`.
 *
 * This test asserts the wiring is present after `build()`: the
 * `SubAgentDispatch`'s `contextBuilder` exists and its `toolSource`
 * callback is a defined function, even though `setToolsRag()` was
 * never called.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  ILlm,
  ISubAgent,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { DefaultSubAgentContextBuilderConfig } from '../subagent/default-context-builder.js';

function stubLlm(): ILlm {
  return {
    async chat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ) {
      return {
        ok: true as const,
        value: {
          content: 'ok',
          toolCalls: [],
          finishReason: 'stop' as const,
        },
      };
    },
    async *streamChat(
      _messages: unknown[],
      _tools?: LlmTool[],
      _options?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

function stubEmbedder(): IEmbedder {
  return {
    async embed(_text: string, _options?: CallOptions): Promise<IEmbedResult> {
      return { vector: [0.1, 0.2, 0.3] };
    },
  };
}

function makeConstrainedSubAgent(name: string): ISubAgent {
  return {
    name,
    capabilities: {
      kind: 'constrained',
      canDispatchChildren: false,
      contextPolicy: 'required',
    },
    async run() {
      return { output: 'ok' };
    },
  };
}

describe('SmartAgentBuilder — auto-toolsRag → subagent context-builder wiring', () => {
  it('wires auto-created toolsRag into SubAgentDispatch.contextBuilder.toolSource even when setToolsRag() was NOT called', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    // MCP configured (triggers auto-toolsRag path) + embedder present.
    // Port 1 is unbound on every sane host — MCP setup will fail gracefully
    // but the builder still completes and the toolsRag/dispatch wiring runs.
    const handle = await new SmartAgentBuilder({
      mcp: { type: 'http', url: 'http://127.0.0.1:1/mcp/stream/http' },
      skipModelValidation: true,
    })
      .withMainLlm(stubLlm())
      .withEmbedder(stubEmbedder())
      .withSubAgents(new Map([['leaf', makeConstrainedSubAgent('leaf')]]))
      .withCoordinator({})
      // Intentionally NOT calling setToolsRag()/withToolsRag() — this is
      // the exact scenario the bug failed: caller relies on the
      // auto-created InMemoryRag.
      .build();

    try {
      // Walk handle → agent → pipeline → coordinator config → dispatch.
      // The coordinator field on DefaultPipeline is private; cast through
      // unknown for read-only inspection (this is a regression test).
      const pipeline = (
        handle.agent as unknown as {
          deps: { pipeline: unknown };
        }
      ).deps.pipeline;
      const coordinator = (
        pipeline as unknown as {
          coordinator?: { dispatch?: unknown };
        }
      ).coordinator;
      assert.ok(coordinator, 'expected pipeline.coordinator to be set');

      // The default coordinator dispatch is now a HybridDispatch; the
      // SubAgentDispatch (which carries the context builder) is its `primary` leg.
      const hybrid = coordinator.dispatch as unknown as { primary?: unknown };
      assert.ok(
        hybrid?.primary,
        'expected HybridDispatch.primary (SubAgentDispatch) to be set',
      );

      // Cast to expose the private contextBuilder for inspection — test-only.
      const dispatchInternals = hybrid.primary as unknown as {
        contextBuilder?: {
          config: DefaultSubAgentContextBuilderConfig;
        };
      };
      const contextBuilder = dispatchInternals.contextBuilder;
      assert.ok(
        contextBuilder,
        'expected SubAgentDispatch.contextBuilder to be wired',
      );

      // Inspect the builder's `config.toolSource` — must be defined as a
      // result of the bugfix (auto-toolsRag flowing into buildRetrievalSource).
      assert.equal(
        typeof contextBuilder.config.toolSource,
        'function',
        'expected context builder toolSource to be wired from auto-created toolsRag (bug fixed in a274ca6)',
      );
    } finally {
      await handle.close();
    }
  });
});
