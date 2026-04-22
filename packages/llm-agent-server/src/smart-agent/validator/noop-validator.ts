import type { Result } from '../interfaces/types.js';
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
