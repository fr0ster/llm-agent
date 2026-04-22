import type { Result } from '@mcp-abap-adt/llm-agent';
import type {
  IOutputValidator,
  ValidationResult,
  ValidatorError,
} from './types.js';

export class NoopValidator implements IOutputValidator {
  async validate(): Promise<Result<ValidationResult, ValidatorError>> {
    return { ok: true, value: { valid: true } };
  }
}
