import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CallOptions,
  ILlm,
  IUsageRecorder,
} from '@mcp-abap-adt/llm-agent';
import {
  diagnosticCallOptions,
  makeSubagentClient,
} from '../subagent-client.js';

test('makeSubagentClient forwards options (signal) to llm.chat', async () => {
  let seen: CallOptions | undefined;
  const llm = {
    model: 'm',
    chat: async (_m: unknown, _t: unknown, opts?: CallOptions) => {
      seen = opts;
      return { ok: true, value: { content: 'ok', toolCalls: [] } };
    },
    streamChat: async function* () {},
  } as unknown as ILlm;
  const ctrl = new AbortController();
  await makeSubagentClient(llm).send([], [], { signal: ctrl.signal });
  assert.equal(seen?.signal, ctrl.signal);
});

for (const role of ['planner', 'evaluator', 'reviewer', 'finalizer']) {
  test(`controller ${role} preserves usage options and narrows the recorder`, async () => {
    const roles: string[] = [];
    const narrowed: IUsageRecorder = {
      record() {},
      with() {
        return this;
      },
    };
    const usage: IUsageRecorder = {
      record() {},
      with(context) {
        assert.ok(context.role);
        roles.push(context.role);
        return narrowed;
      },
    };
    const usageOp = {
      operationId: 'controller',
      outerAttempt: 0,
      chunkPath: '',
      providerAttempt: 0,
      seq: { next: () => 0 },
    };
    const signal = new AbortController().signal;
    let seen: CallOptions | undefined;
    const llm = {
      async chat(_messages: unknown, _tools: unknown, options?: CallOptions) {
        seen = options;
        return { ok: true, value: { content: 'ok' } };
      },
    } as unknown as ILlm;
    await makeSubagentClient(llm).send(
      [],
      [],
      diagnosticCallOptions(
        {
          usage,
          usageOp,
          signal,
          model: 'user-model',
          temperature: 1,
        },
        role,
      ),
    );
    assert.deepEqual(roles, [role]);
    assert.equal(seen?.usage, narrowed);
    assert.equal(seen?.usageOp, usageOp);
    assert.equal(seen?.signal, signal);
    assert.equal(seen?.model, undefined);
    assert.equal(seen?.temperature, undefined);
  });
}
