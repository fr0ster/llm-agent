import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MCPClientWrapper } from '../client.js';

/**
 * Two things an abort must not do.
 *
 * It must not look like a lost connection. The wrapper's catch reconnects and
 * calls again, and by then the caller has been answered — so the retry is a
 * request nobody is waiting for, and on a write tool a second attempt at the
 * same change. Where a wrapper is shared, the disconnect also drops calls
 * belonging to other callers.
 *
 * And on the embedded transport it must reach the handler. Embedded is the path
 * where the tool runs in this very process; a signal that stops only the
 * waiting leaves the work running with nothing holding it, which on an ABAP
 * write chain means a lock still held.
 */
describe('MCPClientWrapper.callTool — the caller signal', () => {
  it('hands the signal to an embedded callToolHandler', async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      callToolHandler: async (_name, _args, signal) => {
        seen = signal;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await wrapper.callTool(
      { id: '1', name: 'Search', arguments: {} },
      controller.signal,
    );
    assert.equal(seen, controller.signal);
  });

  it('hands it to a toolCallHandler as well', async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const wrapper = new MCPClientWrapper({
      transport: 'embedded',
      toolCallHandler: async (_name, _args, signal) => {
        seen = signal;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });

    await wrapper.callTool(
      { id: '1', name: 'Search', arguments: {} },
      controller.signal,
    );
    assert.equal(seen, controller.signal);
  });

  it('does not reconnect and call again when the caller aborted', async () => {
    // The embedded branch returns an error result and never reaches the
    // reconnect path, so this exercises the transport branch directly.
    const controller = new AbortController();
    const wrapper = new MCPClientWrapper({
      transport: 'auto',
      url: 'http://x',
    });
    let calls = 0;
    let reconnects = 0;
    // biome-ignore lint/suspicious/noExplicitAny: reaching past private fields is the point
    const w = wrapper as any;
    w.detectedTransport = 'http';
    w.client = {
      callTool: async () => {
        calls++;
        controller.abort();
        throw new Error('This operation was aborted');
      },
    };
    w.disconnect = async () => {
      reconnects++;
    };
    w.connect = async () => {
      reconnects++;
    };

    await assert.rejects(
      wrapper.callTool(
        { id: '1', name: 'Search', arguments: {} },
        controller.signal,
      ),
      /aborted/i,
    );
    assert.equal(calls, 1, 'an aborted call must not be sent again');
    assert.equal(reconnects, 0, 'an abort must not tear the connection down');
  });
});
