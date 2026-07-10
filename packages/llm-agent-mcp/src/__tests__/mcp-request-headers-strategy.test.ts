import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';
import { buildHttpTransportOptions } from '../client.js';
import { toMcpClientWrapperConfig } from '../factory.js';
import { NoopMcpRequestHeadersStrategy } from '../no-op-request-headers-strategy.js';

describe('NoopMcpRequestHeadersStrategy', () => {
  it('returns empty headers', () => {
    const strategy = new NoopMcpRequestHeadersStrategy();
    assert.deepEqual(strategy.headers(), {});
  });
});

describe('buildHttpTransportOptions — requestHeadersStrategy merge', () => {
  it('merges strategy headers after base headers', () => {
    const strategy: IMcpRequestHeadersStrategy = {
      headers: () => ({ 'X-Wait': '600' }),
    };
    const result = buildHttpTransportOptions({
      headers: { A: '1' },
      requestHeadersStrategy: strategy,
    });
    assert.equal(
      result.requestInit.headers['Accept'],
      'application/json, text/event-stream',
    );
    assert.equal(result.requestInit.headers['A'], '1');
    assert.equal(result.requestInit.headers['X-Wait'], '600');
  });

  it('leaves headers unchanged when no strategy is provided', () => {
    const result = buildHttpTransportOptions({ headers: { A: '1' } });
    assert.deepEqual(result.requestInit.headers, {
      Accept: 'application/json, text/event-stream',
      A: '1',
    });
  });

  it('does not set a signal on requestInit', () => {
    const result = buildHttpTransportOptions({ headers: {} });
    assert.equal(
      (result.requestInit as Record<string, unknown>)['signal'],
      undefined,
    );
  });
});

describe('toMcpClientWrapperConfig — requestHeadersStrategy propagation', () => {
  const strategy: IMcpRequestHeadersStrategy = {
    headers: () => ({ 'X-Custom': 'yes' }),
  };

  it('propagates requestHeadersStrategy for http type', () => {
    const cfg = toMcpClientWrapperConfig({
      type: 'http',
      url: 'http://localhost/mcp',
      requestHeadersStrategy: strategy,
    });
    assert.equal(cfg.requestHeadersStrategy, strategy);
  });

  it('carries url for http type', () => {
    const cfg = toMcpClientWrapperConfig({ type: 'http', url: 'http://u' });
    assert.equal(cfg.url, 'http://u');
    assert.equal(cfg.command, undefined);
  });

  it('carries command and args for stdio type, no url', () => {
    const cfg = toMcpClientWrapperConfig({
      type: 'stdio',
      command: 'npx',
      args: ['server'],
    });
    assert.equal(cfg.command, 'npx');
    assert.deepEqual(cfg.args, ['server']);
    assert.equal(cfg.url, undefined);
  });
});
