import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CallOptions,
  IEmbedder,
  IEmbedResult,
  ILlm,
  LlmStreamChunk,
  LlmTool,
  Result,
} from '@mcp-abap-adt/llm-agent';

// An LLM whose chat() fails the first `failures` times (with a status-code-LESS
// message, like SAP AI Core's deployment-list blip), then succeeds.
function flakyLlm(failures: number): ILlm & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async chat(
      _m: unknown[],
      _t?: LlmTool[],
      _o?: CallOptions,
    ): Promise<Result<{ content: string; finishReason: 'stop' }, Error>> {
      calls++;
      if (calls <= failures)
        return {
          ok: false as const,
          error: Object.assign(
            new Error(
              'SAP AI SDK API error: Failed to fetch the list of deployments.',
            ),
            { code: 'MODEL_LIST_FAILED' },
          ) as never,
        };
      return {
        ok: true as const,
        value: { content: 'OK', finishReason: 'stop' as const },
      };
    },
    async *streamChat(): AsyncGenerator<Result<LlmStreamChunk, Error>> {
      yield {
        ok: true as const,
        value: { content: 'OK', finishReason: 'stop' as const },
      };
    },
  } as ILlm & { calls: number };
}

function stubEmbedder(): IEmbedder {
  return {
    async embed(_text: string, _o?: CallOptions): Promise<IEmbedResult> {
      return { vector: [0.1, 0.2, 0.3] };
    },
  };
}

describe('SmartAgentBuilder startup model validation — lenient retry', () => {
  it('retries a transient validation failure (no status code) and does NOT abort', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const llm = flakyLlm(1); // fails once, then ok
    const handle = await new SmartAgentBuilder({
      modelValidationAttempts: 3,
      modelValidationBackoffMs: 1, // fast test
    })
      .withMainLlm(llm)
      .withEmbedder(stubEmbedder())
      .build();
    assert.ok(
      handle,
      'build must succeed despite one transient validation failure',
    );
    assert.equal(llm.calls, 2, 'one failed attempt + one successful retry');
  });

  it('aborts after exhausting attempts when every attempt fails', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const llm = flakyLlm(99); // always fails
    await assert.rejects(
      () =>
        new SmartAgentBuilder({
          modelValidationAttempts: 2,
          modelValidationBackoffMs: 1,
        })
          .withMainLlm(llm)
          .withEmbedder(stubEmbedder())
          .build(),
      /Startup aborted.*after 2 attempts/s,
    );
    assert.equal(llm.calls, 2, 'tried exactly maxAttempts times');
  });
});
