import type { Result } from '@mcp-abap-adt/llm-agent';
import type {
  IOutputValidator,
  ValidationResult,
  ValidatorError,
} from './types.js';
export declare class NoopValidator implements IOutputValidator {
  validate(): Promise<Result<ValidationResult, ValidatorError>>;
}
//# sourceMappingURL=noop-validator.d.ts.map
