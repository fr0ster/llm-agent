/**
 * Task 10 (#244) — resolveMcpSection validates `mcp[].name`: charset
 * `^[a-zA-Z0-9_-]+$` and uniqueness among the configured servers. An invalid
 * or duplicate label must be rejected at config-parse time (fail fast),
 * before a colliding tool name ever reaches the connection strategy /
 * IToolNamespace prefix resolution.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveMcpSection } from '../resolve-config-sections.js';

describe('resolveMcpSection — mcp[].name validation', () => {
  it('rejects a name containing invalid characters (space)', () => {
    const yaml = {
      mcp: [{ type: 'http', url: 'http://a/mcp', name: 'a b' }],
    };
    assert.throws(() => resolveMcpSection(yaml, {}), /name/i);
  });

  it('rejects duplicate names among servers', () => {
    const yaml = {
      mcp: [
        { type: 'http', url: 'http://a/mcp', name: 'x' },
        { type: 'http', url: 'http://b/mcp', name: 'x' },
      ],
    };
    assert.throws(() => resolveMcpSection(yaml, {}), /duplicate/i);
  });

  it('threads a valid mcp[].name onto the connection config unchanged', () => {
    const yaml = {
      mcp: [
        { type: 'http', url: 'http://a/mcp', name: 'primary' },
        { type: 'http', url: 'http://b/mcp', name: 'secondary' },
      ],
    };
    const result = resolveMcpSection(yaml, {}) as Array<{ name?: string }>;
    assert.equal(result[0].name, 'primary');
    assert.equal(result[1].name, 'secondary');
  });

  it('allows alphanumerics, underscores, and hyphens', () => {
    const yaml = {
      mcp: [{ type: 'http', url: 'http://a/mcp', name: 'Primary-1_ok' }],
    };
    const result = resolveMcpSection(yaml, {}) as Array<{ name?: string }>;
    assert.equal(result[0].name, 'Primary-1_ok');
  });

  it('leaves servers without a name untouched (namespacing falls back to slot index)', () => {
    const yaml = {
      mcp: [
        { type: 'http', url: 'http://a/mcp' },
        { type: 'http', url: 'http://b/mcp' },
      ],
    };
    const result = resolveMcpSection(yaml, {}) as Array<{ name?: string }>;
    assert.equal(result[0].name, undefined);
    assert.equal(result[1].name, undefined);
  });
});
