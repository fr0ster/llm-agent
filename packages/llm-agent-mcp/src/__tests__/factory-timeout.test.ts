import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toMcpClientWrapperConfig } from '../factory.js';

describe('toMcpClientWrapperConfig — timeout + toolTimeouts propagation', () => {
  it('carries timeout and toolTimeouts for http type', () => {
    const cfg = toMcpClientWrapperConfig({
      type: 'http',
      url: 'http://u',
      timeout: 300000,
      toolTimeouts: { X: 900000 },
    });
    assert.equal(cfg.timeout, 300000);
    assert.deepEqual(cfg.toolTimeouts, { X: 900000 });
  });

  it('does not set timeout or toolTimeouts when absent', () => {
    const cfg = toMcpClientWrapperConfig({ type: 'http', url: 'http://u' });
    assert.equal(cfg.timeout, undefined);
    assert.equal(cfg.toolTimeouts, undefined);
  });

  it('carries timeout/toolTimeouts for stdio type', () => {
    const cfg = toMcpClientWrapperConfig({
      type: 'stdio',
      command: 'npx',
      args: ['server'],
      timeout: 60000,
      toolTimeouts: { slow: 180000 },
    });
    // stdio branch must propagate timeout/toolTimeouts — callTool uses them for
    // every transport, so stdio users must be able to tune slow tools too.
    assert.equal(cfg.timeout, 60000);
    assert.deepEqual(cfg.toolTimeouts, { slow: 180000 });
  });
});
