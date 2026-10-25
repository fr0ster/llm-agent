import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IUsageRecorder, UsageInput } from '@mcp-abap-adt/llm-agent';
import { McpError } from '@mcp-abap-adt/llm-agent';
import { DefaultAuxiliaryMcpTools } from '../default-auxiliary-mcp-tools.js';
import type { AuxToolEntry } from '../wait-tool.js';
import { makeWaitTool } from '../wait-tool.js';

function collector() {
  const records: UsageInput[] = [];
  const usage: IUsageRecorder = {
    record: (record) => {
      records.push(record);
    },
    with: () => usage,
  };
  return { records, usage };
}

for (const mode of [
  'ok',
  'isError',
  'failure',
  'throw',
  'abort',
  'abortError',
] as const) {
  test(`auxiliary dispatch records ${mode} once and preserves the result`, async () => {
    const { usage, records } = collector();
    const controller = new AbortController();
    const error = Object.assign(new Error('SECRET_ERROR'), {
      code: 'E_TOOL',
      name: mode === 'abortError' ? 'AbortError' : 'Error',
    });
    const response =
      mode === 'failure'
        ? { ok: false as const, error: new McpError('SECRET_FAILURE') }
        : {
            ok: true as const,
            value: { content: 'SECRET_RESULT_é', isError: mode === 'isError' },
          };
    const args = { text: 'SECRET_ARGUMENT_é' };
    let executions = 0;
    const entry: AuxToolEntry = {
      def: makeWaitTool().def,
      handler: async (received, options) => {
        executions++;
        assert.equal(received, args);
        assert.equal(options?.signal, controller.signal);
        if (mode === 'abort') controller.abort();
        if (mode === 'throw' || mode === 'abort' || mode === 'abortError')
          throw error;
        return response;
      },
    };
    const aux = new DefaultAuxiliaryMcpTools([entry]);
    const call = aux.callTool('wait', args, {
      usage,
      signal: controller.signal,
    });
    const thrown =
      mode === 'throw' || mode === 'abort' || mode === 'abortError';
    if (thrown) await assert.rejects(call, (caught) => caught === error);
    else assert.equal(await call, response);
    assert.equal(executions, 1);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.kind, 'tool.call');
    if (record.kind !== 'tool.call') return;
    const transport =
      mode === 'abort' || mode === 'abortError'
        ? 'aborted'
        : mode === 'throw'
          ? 'error'
          : 'ok';
    assert.equal(record.embedded, true);
    assert.equal(record.dispatched, true);
    assert.equal(record.tool, 'wait');
    assert.equal(record.transportOutcome, transport);
    assert.equal(
      record.toolOutcome,
      thrown ? undefined : mode === 'ok' ? 'ok' : 'error',
    );
    assert.equal(
      record.outcome,
      transport === 'ok' ? (mode === 'ok' ? 'ok' : 'error') : transport,
    );
    assert.equal(
      record.requestBytes,
      Buffer.byteLength(JSON.stringify({ name: 'wait', arguments: args })),
    );
    assert.equal(
      record.responseBytes,
      thrown ? undefined : Buffer.byteLength(JSON.stringify(response)),
    );
    assert.equal(record.errorCode, thrown ? 'E_TOOL' : undefined);
    assert.ok(record.durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  });
}

test('construction recorder, per-call override, legacy calls, and unknown names', async () => {
  const bound = collector();
  const perCall = collector();
  const aux = new DefaultAuxiliaryMcpTools([makeWaitTool()], bound.usage);
  assert.equal((await aux.callTool('wait', { seconds: 0 })).ok, true);
  assert.equal(
    (await aux.callTool('wait', { seconds: 0 }, { usage: perCall.usage })).ok,
    true,
  );
  assert.equal((await aux.callTool('unknown', {})).ok, false);
  assert.equal(bound.records.length, 1);
  assert.equal(perCall.records.length, 1);
  assert.equal(
    (
      await new DefaultAuxiliaryMcpTools([makeWaitTool()]).callTool('wait', {
        seconds: 0,
      })
    ).ok,
    true,
  );
});

test('unsafe error codes and recorder failures do not change execution', async () => {
  const { usage, records } = collector();
  const error = { code: 'SECRET ERROR', status: 400 };
  const entry: AuxToolEntry = {
    def: makeWaitTool().def,
    handler: async () => {
      throw error;
    },
  };
  await assert.rejects(
    new DefaultAuxiliaryMcpTools([entry], usage).callTool('wait', {}),
    (caught) => caught === error,
  );
  assert.equal(records[0].errorCode, '400');
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  const broken: IUsageRecorder = {
    record() {
      throw new Error('recorder');
    },
    with: () => broken,
  };
  assert.equal(
    (
      await new DefaultAuxiliaryMcpTools([makeWaitTool()], broken).callTool(
        'wait',
        { seconds: 0 },
      )
    ).ok,
    true,
  );
  await assert.rejects(
    new DefaultAuxiliaryMcpTools([entry], broken).callTool('wait', {}),
    (caught) => caught === error,
  );
});
