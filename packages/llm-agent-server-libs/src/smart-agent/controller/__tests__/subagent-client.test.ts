import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type ILlm,
  LlmError,
  type LlmResponse,
  MODEL_CONTEXT_EXCEEDED,
  type Result,
} from '@mcp-abap-adt/llm-agent';
import { LlmReviewer } from '../reviewer.js';
import { makeSubagentClient } from '../subagent-client.js';
import { establishTargetState } from '../target-state.js';

const llm = (resp: Result<LlmResponse, LlmError>): ILlm => ({
  model: 's',
  chat: async () => resp,
  streamChat: async function* () {},
});

describe('makeSubagentClient', () => {
  it('content response → kind:content', async () => {
    const c = makeSubagentClient(
      llm({
        ok: true,
        value: { content: 'hello', toolCalls: [], finishReason: 'stop' },
      }),
    );
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), {
      kind: 'content',
      content: 'hello',
    });
  });

  it('tool_calls response → kind:tool_call', async () => {
    const tc = [{ id: 'x', name: 'f', arguments: {} }];
    const c = makeSubagentClient(
      llm({
        ok: true,
        value: { content: '', toolCalls: tc, finishReason: 'tool_calls' },
      }),
    );
    const r = await c.send([{ role: 'user', content: 'hi' }]);
    assert.equal(r.kind, 'tool_call');
  });

  it('keeps an ordinary error as a message', async () => {
    const error = new LlmError('boom');
    const c = makeSubagentClient(llm({ ok: false, error }));
    assert.deepEqual(await c.send([{ role: 'user', content: 'hi' }]), {
      kind: 'error',
      error: 'boom',
    });
  });

  it('returns a typed overflow in the error result', async () => {
    const error = new LlmError('Context is full', MODEL_CONTEXT_EXCEEDED);
    const c = makeSubagentClient(llm({ ok: false, error }));
    const res = await c.send([{ role: 'user', content: 'hi' }]);
    assert.equal(res.kind, 'error');
    if (res.kind === 'error') assert.equal(res.contextOverflow, error);
  });
});

for (const code of ['ABORTED', MODEL_CONTEXT_EXCEEDED]) {
  for (const thrown of [false, true]) {
    it(
      'preserves ' +
        code +
        ' and usage through controller subagent roles (' +
        (thrown ? 'thrown' : 'returned') +
        ')',
      async () => {
        const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
        const overflow = Object.assign(
          new LlmError('Context is full', MODEL_CONTEXT_EXCEEDED),
          { usage },
        );
        const error =
          code === 'ABORTED'
            ? Object.assign(new LlmError('Cancelled'), {
                name: 'AbortError',
                cause: overflow,
              })
            : overflow;
        const provider: ILlm = {
          async chat() {
            if (thrown) throw error;
            return { ok: false, error };
          },
          async *streamChat() {},
        };
        const client = makeSubagentClient(provider);
        const result = await client.send([]);
        assert.equal(result.kind, 'error');
        const failure = result.abort ?? result.contextOverflow;
        assert.equal(failure?.code, code);
        assert.deepEqual(result.usage, usage);
        const reviewer = new LlmReviewer(client);
        await assert.rejects(
          reviewer.review(
            { name: 'review', instructions: 'Check output' },
            [],
            'answer',
            {},
          ),
          { code, usage },
        );
        await assert.rejects(
          establishTargetState({ evaluator: client }, 'prompt', {
            strategy: 'consumer-confirm',
            distanceThreshold: 0.25,
          }),
          { code, usage },
        );
      },
    );
  }
}

it('keeps the existing reviewer and evaluator outcomes for an ordinary error', async () => {
  const client = makeSubagentClient(
    llm({ ok: false, error: new LlmError('Unavailable') }),
  );
  const reviewer = new LlmReviewer(client);
  assert.deepEqual(
    await reviewer.review(
      { name: 'review', instructions: 'Check output' },
      [],
      'answer',
      {},
    ),
    { kind: 'judge-failure', reason: 'reviewer error: Unavailable' },
  );
  const result = await establishTargetState({ evaluator: client }, 'prompt', {
    strategy: 'consumer-confirm',
    distanceThreshold: 0.25,
  });
  assert.equal(result.kind, 'needs-confirmation');
});
