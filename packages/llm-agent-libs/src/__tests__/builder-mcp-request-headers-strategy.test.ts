/**
 * Unit tests for SmartAgentBuilder.withMcpRequestHeadersStrategy().
 *
 * Verifies that the strategy is propagated to every McpConnectionConfig
 * assembled by prepareMcpConfigs(), and that omitting the setter leaves
 * requestHeadersStrategy undefined.
 *
 * Uses prepareMcpConfigs() as the test seam — no full builder.build() needed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IMcpRequestHeadersStrategy } from '@mcp-abap-adt/llm-agent';

// ---------------------------------------------------------------------------
// Stub
// ---------------------------------------------------------------------------

function stubStrategy(
  extra?: Record<string, string>,
): IMcpRequestHeadersStrategy {
  return {
    headers(): Record<string, string> {
      return { 'x-timeout': '120000', ...extra };
    },
  };
}

// ---------------------------------------------------------------------------
// prepareMcpConfigs — the test seam
// ---------------------------------------------------------------------------

describe('prepareMcpConfigs()', () => {
  it('returns an empty array when mcp is undefined', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const result = prepareMcpConfigs(undefined);
    assert.deepEqual(result, []);
  });

  it('wraps a single config in an array', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const result = prepareMcpConfigs({
      type: 'http',
      url: 'http://localhost/mcp',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'http://localhost/mcp');
  });

  it('passes through an array unchanged', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const configs = [
      { type: 'http' as const, url: 'http://a/mcp' },
      { type: 'http' as const, url: 'http://b/mcp' },
    ];
    const result = prepareMcpConfigs(configs);
    assert.equal(result.length, 2);
  });

  it('leaves requestHeadersStrategy undefined when no strategy is supplied', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const result = prepareMcpConfigs({
      type: 'http',
      url: 'http://localhost/mcp',
    });
    assert.equal(result[0].requestHeadersStrategy, undefined);
  });

  it('attaches the strategy to a single-config entry', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const strategy = stubStrategy();
    const result = prepareMcpConfigs(
      { type: 'http', url: 'http://localhost/mcp' },
      strategy,
    );
    assert.equal(result.length, 1);
    assert.strictEqual(result[0].requestHeadersStrategy, strategy);
  });

  it('attaches the strategy to every entry in a multi-config array', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const strategy = stubStrategy({ 'x-custom': 'yes' });
    const configs = [
      { type: 'http' as const, url: 'http://a/mcp' },
      { type: 'http' as const, url: 'http://b/mcp' },
      { type: 'http' as const, url: 'http://c/mcp' },
    ];
    const result = prepareMcpConfigs(configs, strategy);
    assert.equal(result.length, 3);
    for (const cfg of result) {
      assert.strictEqual(cfg.requestHeadersStrategy, strategy);
    }
  });

  it('does not mutate the original config objects', async () => {
    const { prepareMcpConfigs } = await import('../builder.js');
    const strategy = stubStrategy();
    const original = { type: 'http' as const, url: 'http://localhost/mcp' };
    prepareMcpConfigs(original, strategy);
    assert.equal(
      (original as Record<string, unknown>)['requestHeadersStrategy'],
      undefined,
      'prepareMcpConfigs must not mutate the original config object',
    );
  });
});

// ---------------------------------------------------------------------------
// SmartAgentBuilder.withMcpRequestHeadersStrategy() — fluent API contract
// ---------------------------------------------------------------------------

describe('SmartAgentBuilder.withMcpRequestHeadersStrategy()', () => {
  it('is chainable and returns the builder instance', async () => {
    const { SmartAgentBuilder } = await import('../builder.js');
    const builder = new SmartAgentBuilder({});
    const strategy = stubStrategy();
    const result = builder.withMcpRequestHeadersStrategy(strategy);
    assert.strictEqual(
      result,
      builder,
      'withMcpRequestHeadersStrategy must return `this`',
    );
  });
});
