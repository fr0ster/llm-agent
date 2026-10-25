import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { McpClientAdapter } from '../adapter.js';
import { MCPClientWrapper } from '../client.js';

function collector() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (r) => {
      records.push(r);
    },
    with: () => usage,
  };
  return { usage, records };
}
const call = {
  id: '1',
  name: 'Read',
  arguments: { text: 'SECRET_ARGUMENT_é' },
};

for (const mode of ['ok', 'isError', 'throw', 'abort'] as const) {
  test(`embedded dispatch: ${mode}`, async () => {
    const { usage, records } = collector();
    const controller = new AbortController();
    const response = {
      content: 'SECRET_RESULT_é',
      isError: mode === 'isError',
    };
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      name: 'local',
      usage,
      callToolHandler: async (_name, _args, signal) => {
        assert.equal(signal, controller.signal);
        if (mode === 'abort') controller.abort();
        if (mode === 'throw' || mode === 'abort') {
          throw Object.assign(new Error('SECRET_ERROR'), { code: 'E_TOOL' });
        }
        return response;
      },
    });
    const result = await wrapper.callTool(call, controller.signal);
    assert.equal(records.length, 1);
    const r = records[0];
    assert.equal(r.kind, 'tool.call');
    if (r.kind !== 'tool.call') return;
    assert.equal(r.embedded, true);
    assert.equal(r.dispatched, true);
    assert.equal(r.server, 'local');
    assert.equal(
      r.transportOutcome,
      mode === 'abort' ? 'aborted' : mode === 'throw' ? 'error' : 'ok',
    );
    assert.equal(
      r.outcome,
      mode === 'abort' ? 'aborted' : mode === 'ok' ? 'ok' : 'error',
    );
    assert.equal(
      r.toolOutcome,
      mode === 'throw' || mode === 'abort'
        ? undefined
        : mode === 'isError'
          ? 'error'
          : 'ok',
    );
    assert.ok(r.durationMs >= 0);
    assert.equal(
      r.requestBytes,
      Buffer.byteLength(
        JSON.stringify({ name: call.name, arguments: call.arguments }),
      ),
    );
    if (mode === 'ok' || mode === 'isError') {
      assert.equal(
        r.responseBytes,
        Buffer.byteLength(JSON.stringify(response)),
      );
      assert.equal(result.result, response.content);
    } else assert.equal(r.errorCode, 'E_TOOL');
    assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  });
}

for (const attempts of [1, 2, 3]) {
  test(`network dispatch records ${attempts} physical attempts`, async () => {
    const { usage, records } = collector();
    const wrapper = new MCPClientWrapper({
      transport: 'stream-http',
      url: 'http://localhost:9',
      usage,
    });
    let count = 0;
    const sdk = {
      callTool: async () => {
        count++;
        if (count < attempts)
          throw Object.assign(new Error('private failure'), { status: 503 });
        return { content: [], isError: true };
      },
    };
    const state = wrapper as unknown as { client: unknown; sessionId: string };
    state.client = sdk;
    state.sessionId = 'existing';
    wrapper.disconnect = async () => {
      state.client = null;
    };
    wrapper.connect = async () => {
      state.client = sdk;
    };
    const result = await wrapper.callTool(call);
    assert.equal(result.isError, true);
    assert.equal(records.length, attempts);
    assert.deepEqual(
      records.map((r) => r.kind === 'tool.call' && r.transportOutcome),
      [...Array(attempts - 1).fill('error'), 'ok'],
    );
    assert.ok(
      records.every(
        (r) => r.kind === 'tool.call' && r.dispatched && !r.embedded,
      ),
    );
    assert.doesNotMatch(JSON.stringify(records), /SECRET|private failure/);
  });
}

test('adapter forwards per-call recorder over construction default; legacy calls work', async () => {
  const bound = collector();
  const perCall = collector();
  const wrapper = new MCPClientWrapper({
    transport: 'embedded',
    usage: bound.usage,
    callToolHandler: async () => ({ content: 'value' }),
  });
  assert.equal((await wrapper.callTool(call, undefined)).result, 'value');
  const result = await new McpClientAdapter(wrapper).callTool(
    call.name,
    call.arguments,
    { usage: perCall.usage },
  );
  assert.equal(result.ok, true);
  assert.equal(bound.records.length, 1);
  assert.equal(perCall.records.length, 1);
  const plain = new MCPClientWrapper({
    transport: 'embedded',
    callToolHandler: async () => 'value',
  });
  assert.equal((await plain.callTool(call, undefined)).result, 'value');
});

test('abort is recorded once without reconnect and preserves the error', async () => {
  const { usage, records } = collector();
  const controller = new AbortController();
  const error = new Error('private abort');
  const wrapper = new MCPClientWrapper({
    transport: 'stream-http',
    url: 'http://localhost:9',
    usage,
  });
  (wrapper as unknown as { client: unknown }).client = {
    callTool: async () => {
      controller.abort();
      throw error;
    },
  };
  wrapper.connect = async () => {
    assert.fail('must not reconnect');
  };
  await assert.rejects(
    wrapper.callTool(call, controller.signal),
    (e) => e === error,
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, 'aborted');
});

test('unsafe error codes and throwing recorder never change execution', async () => {
  const { usage, records } = collector();
  const wrapper = new MCPClientWrapper({
    transport: 'embedded',
    usage,
    toolCallHandler: async () => {
      throw { code: 'SECRET ERROR BODY', status: 400 };
    },
  });
  await wrapper.callTool(call);
  assert.equal(records[0].errorCode, '400');
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  const broken: IUsageRecorder = {
    record() {
      throw new Error('recorder');
    },
    with() {
      return broken;
    },
  };
  const success = new MCPClientWrapper({
    transport: 'embedded',
    usage: broken,
    toolCallHandler: async () => 'value',
  });
  assert.equal((await success.callTool(call)).result, 'value');
});
