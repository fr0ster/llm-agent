import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolPolicyGuard } from '../tool-policy-guard.js';

// ---------------------------------------------------------------------------
// No config — allow-all
// ---------------------------------------------------------------------------
describe('ToolPolicyGuard — no config (allow-all)', () => {
  it('check any tool name → allowed=true', () => {
    const guard = new ToolPolicyGuard();
    assert.equal(guard.check('anyTool').allowed, true);
  });
  it('check empty string tool name → allowed=true', () => {
    const guard = new ToolPolicyGuard();
    assert.equal(guard.check('').allowed, true);
  });
});
// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------
describe('ToolPolicyGuard — allowlist', () => {
  it('tool in allowlist → allowed=true', () => {
    const guard = new ToolPolicyGuard({ allowlist: ['search', 'calc'] });
    assert.equal(guard.check('search').allowed, true);
  });
  it('tool NOT in allowlist → allowed=false', () => {
    const guard = new ToolPolicyGuard({ allowlist: ['search'] });
    const verdict = guard.check('deleteTool');
    assert.equal(verdict.allowed, false);
  });
  it('reason message contains tool name when blocked', () => {
    const guard = new ToolPolicyGuard({ allowlist: ['search'] });
    const verdict = guard.check('dangerousTool');
    assert.ok(verdict.reason?.includes('dangerousTool'));
  });
  it('empty allowlist array treated same as no config → allow-all', () => {
    const guard = new ToolPolicyGuard({ allowlist: [] });
    assert.equal(guard.check('anyTool').allowed, true);
  });
});
// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------
describe('ToolPolicyGuard — denylist', () => {
  it('tool NOT in denylist → allowed=true', () => {
    const guard = new ToolPolicyGuard({ denylist: ['rm', 'shutdown'] });
    assert.equal(guard.check('search').allowed, true);
  });
  it('tool IN denylist → allowed=false', () => {
    const guard = new ToolPolicyGuard({ denylist: ['rm', 'shutdown'] });
    assert.equal(guard.check('rm').allowed, false);
  });
  it('reason message contains tool name when blocked', () => {
    const guard = new ToolPolicyGuard({ denylist: ['rm'] });
    const verdict = guard.check('rm');
    assert.ok(verdict.reason?.includes('rm'));
  });
  it('empty denylist array treated same as no config → allow-all', () => {
    const guard = new ToolPolicyGuard({ denylist: [] });
    assert.equal(guard.check('anyTool').allowed, true);
  });
});
// ---------------------------------------------------------------------------
// Allowlist takes precedence over denylist
// ---------------------------------------------------------------------------
describe('ToolPolicyGuard — allowlist takes precedence over denylist', () => {
  it('tool in both allowlist and denylist → allowed=true (allowlist wins)', () => {
    const guard = new ToolPolicyGuard({
      allowlist: ['search'],
      denylist: ['search'],
    });
    assert.equal(guard.check('search').allowed, true);
  });
  it('tool in neither when both set → allowed=false (allowlist is authoritative)', () => {
    const guard = new ToolPolicyGuard({
      allowlist: ['search'],
      denylist: ['rm'],
    });
    assert.equal(guard.check('calc').allowed, false);
  });
});
// ---------------------------------------------------------------------------
// Case sensitivity
// ---------------------------------------------------------------------------
describe('ToolPolicyGuard — case sensitivity', () => {
  it('allowlist check is case-sensitive: "Search" ≠ "search"', () => {
    const guard = new ToolPolicyGuard({ allowlist: ['search'] });
    assert.equal(guard.check('Search').allowed, false);
  });
  it('denylist check is case-sensitive: "Rm" ≠ "rm"', () => {
    const guard = new ToolPolicyGuard({ denylist: ['rm'] });
    assert.equal(guard.check('Rm').allowed, true);
  });
});
//# sourceMappingURL=tool-policy-guard.test.js.map
