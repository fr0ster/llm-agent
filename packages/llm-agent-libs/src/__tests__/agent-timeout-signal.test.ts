import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { type ILlm, LlmError } from '@mcp-abap-adt/llm-agent';
import { SmartAgentBuilder } from '../builder.js';

/** An LLM whose streamChat records the signal it receives (and optionally waits for it). */
function recordingLlm(waitForAbort: boolean): {
  llm: ILlm;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  const llm: ILlm = {
    async chat() {
      return { ok: true, value: { content: 'ok', finishReason: 'stop' } };
    },
    async *streamChat(_m, _t, o) {
      const signal = o?.signal;
      if (signal) signals.push(signal);
      if (waitForAbort && signal) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        yield { ok: false, error: new LlmError('aborted', 'ABORTED') };
        return;
      }
      yield {
        ok: true,
        value: { content: 'ok', finishReason: 'stop' },
      };
    },
  };
  return { llm, signals };
}

test('timeoutMs aborts with a TimeoutError reason', async () => {
  const { llm, signals } = recordingLlm(true);
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(llm)
    .withTimeout(20)
    .build();
  await handle.agent.process('hi');
  const seen = signals[0];
  assert.ok(seen?.aborted, 'signal fired');
  assert.equal(
    (seen.reason as { name?: string } | undefined)?.name,
    'TimeoutError',
  );
  await handle.close();
});

test('a long-lived caller signal keeps no listeners across requests', async () => {
  const { llm, signals } = recordingLlm(false);
  const handle = await new SmartAgentBuilder({})
    .withMainLlm(llm)
    .withTimeout(60_000)
    .build();
  const caller = new AbortController();
  for (let i = 0; i < 5; i++) {
    await handle.agent.process('hi', { signal: caller.signal });
  }
  assert.equal(signals.length, 5);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  await handle.close();
});
