import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveMcpSection } from '../resolve-config-sections.js';

describe('resolveMcpSection — timeout + toolTimeouts from YAML', () => {
  it('carries timeout and toolTimeouts from a scalar mcp: block', () => {
    const yaml = {
      mcp: {
        type: 'http',
        url: 'http://localhost/mcp',
        timeout: 300000,
        toolTimeouts: { SlowTool: 900000 },
      },
    };
    const result = resolveMcpSection(yaml, {});
    assert.ok(result && !Array.isArray(result), 'expected single mcp config');
    const cfg = result as {
      timeout?: number;
      toolTimeouts?: Record<string, number>;
    };
    assert.equal(cfg.timeout, 300000);
    assert.deepEqual(cfg.toolTimeouts, { SlowTool: 900000 });
  });

  it('does not set timeout or toolTimeouts when absent from YAML', () => {
    const yaml = {
      mcp: { type: 'http', url: 'http://localhost/mcp' },
    };
    const result = resolveMcpSection(yaml, {});
    assert.ok(result && !Array.isArray(result), 'expected single mcp config');
    const cfg = result as {
      timeout?: number;
      toolTimeouts?: Record<string, number>;
    };
    assert.equal(cfg.timeout, undefined);
    assert.equal(cfg.toolTimeouts, undefined);
  });

  it('passes array mcp: form through unchanged (array is returned as-is)', () => {
    const yaml = {
      mcp: [
        { type: 'http', url: 'http://a/mcp', timeout: 60000 },
        { type: 'http', url: 'http://b/mcp' },
      ],
    };
    const result = resolveMcpSection(yaml, {});
    assert.ok(Array.isArray(result), 'expected array mcp config');
    assert.equal((result as unknown[])[0] as unknown, yaml.mcp[0]);
  });
});
