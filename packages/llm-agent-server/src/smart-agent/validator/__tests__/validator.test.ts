import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Result } from '@mcp-abap-adt/llm-agent';
import { NoopValidator } from '../noop-validator.js';
import type {
  IOutputValidator,
  ValidationResult,
  ValidatorError,
} from '../types.js';

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
    const validator: IOutputValidator = {
      async validate(
        content,
      ): Promise<Result<ValidationResult, ValidatorError>> {
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
    const validator: IOutputValidator = {
      async validate(): Promise<Result<ValidationResult, ValidatorError>> {
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
