/**
 * Regression test for issue #118 — SmartAgentBuilder must surface MCP setup
 * failures via the logger instead of swallowing them silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import type { ILogger, LogEvent } from '@mcp-abap-adt/llm-agent';

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

class CapturingLogger implements ILogger {
  events: LogEvent[] = [];
  log(event: LogEvent): void {
    this.events.push(event);
  }
}

describe('SmartAgentBuilder — MCP setup failure logging (#118)', () => {
  it('logs a warning when an MCP connection fails instead of swallowing it', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');

    const logger = new CapturingLogger();
    // Port 1 is reserved/unbound on every sane host → connect must fail.
    const unreachableUrl = 'http://127.0.0.1:1/mcp/stream/http';

    const handle = await new SmartAgentBuilder({
      mcp: { type: 'http', url: unreachableUrl },
    })
      .withMainLlm(stubLlm())
      .withLogger(logger)
      .build();

    try {
      const warnings = logger.events.filter(
        (e): e is LogEvent & { type: 'warning' } => e.type === 'warning',
      );
      const mcpWarning = warnings.find((w) =>
        w.message.includes(unreachableUrl),
      );
      assert.ok(
        mcpWarning,
        `expected a 'warning' log entry mentioning ${unreachableUrl}, got: ${JSON.stringify(warnings)}`,
      );
      assert.match(mcpWarning.message, /MCP setup failed/);

      // Agent still builds (graceful degradation contract preserved).
      const health = await handle.agent.healthCheck();
      assert.ok(health.ok);
      assert.equal(health.value.mcp.length, 0);
    } finally {
      await handle.close();
    }
  });
});
