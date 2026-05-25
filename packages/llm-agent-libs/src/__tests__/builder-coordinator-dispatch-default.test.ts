import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  ILlm,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { HybridDispatch } from '../coordinator/dispatch/hybrid.js';

function stubLlm(): ILlm {
  return {
    async chat(_m: unknown[], _t?: LlmTool[], _o?: CallOptions) {
      return {
        ok: true as const,
        value: { content: 'ok', toolCalls: [], finishReason: 'stop' as const },
      };
    },
    async *streamChat(
      _m: unknown[],
      _t?: LlmTool[],
      _o?: CallOptions,
    ): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'ok', finishReason: 'stop' as const },
      };
    },
  };
}

describe('SmartAgentBuilder — default coordinator dispatch', () => {
  it('defaults to HybridDispatch whose self leg uses the resolved plannerLlm', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const mainStub = stubLlm();
    const plannerStub = stubLlm(); // distinct instance from mainStub
    const handle = await new SmartAgentBuilder({ skipModelValidation: true })
      .withMainLlm(mainStub)
      .withCoordinator({ plannerLlm: plannerStub })
      .build();
    try {
      const pipeline = (
        handle.agent as unknown as { deps: { pipeline: unknown } }
      ).deps.pipeline;
      const coordinator = (
        pipeline as unknown as { coordinator?: { dispatch?: unknown } }
      ).coordinator;
      assert.ok(coordinator, 'expected pipeline.coordinator to be set');
      assert.ok(
        coordinator.dispatch instanceof HybridDispatch,
        'expected default coordinator dispatch to be HybridDispatch',
      );
      // The hybrid's self leg (fallback) must use the coordinator's resolved
      // plannerLlm (here the explicit plannerStub), NOT the raw mainLlm. build()
      // always requires a main LLM (so there is no planner-only build to test);
      // the point is that an explicit plannerLlm wins over mainLlm for the self
      // answer. Test-only cast to read the private fields.
      const fallback = (
        coordinator.dispatch as unknown as { fallback?: { llm?: unknown } }
      ).fallback;
      assert.equal(
        fallback?.llm,
        plannerStub,
        'hybrid self leg must use the resolved plannerLlm',
      );
    } finally {
      await handle.close();
    }
  });
});
