import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NoopValidator } from '../noop-validator.js';

describe('NoopValidator', () => {
  it('always returns valid=true', async () => {
    const v = new NoopValidator();
    const result = await v.validate('hello', { messages: [], tools: [] });
    assert.ok(result.ok);
    assert.equal(result.value.valid, true);
    assert.equal(result.value.reason, undefined);
  });
});
describe('Custom IOutputValidator', () => {
  it('rejects content and provides reason', async () => {
    const validator = {
      async validate(content) {
        if (content.includes('bad')) {
          return {
            ok: true,
            value: { valid: false, reason: 'Contains bad word' },
          };
        }
        return { ok: true, value: { valid: true } };
      },
    };
    const result = await validator.validate('this is bad', {
      messages: [],
      tools: [],
    });
    assert.ok(result.ok);
    assert.equal(result.value.valid, false);
    assert.equal(result.value.reason, 'Contains bad word');
  });
  it('correctedContent replaces output', async () => {
    const validator = {
      async validate() {
        return {
          ok: true,
          value: {
            valid: false,
            reason: 'Needs correction',
            correctedContent: 'fixed output',
          },
        };
      },
    };
    const result = await validator.validate('wrong', {
      messages: [],
      tools: [],
    });
    assert.ok(result.ok);
    assert.equal(result.value.valid, false);
    assert.equal(result.value.correctedContent, 'fixed output');
  });
});
//# sourceMappingURL=validator.test.js.map
