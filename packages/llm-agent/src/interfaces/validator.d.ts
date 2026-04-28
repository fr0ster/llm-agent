import type { Message } from '../types.js';
import type { CallOptions, LlmTool, Result } from './types.js';
import { SmartAgentError } from './types.js';
export interface ValidationResult {
  valid: boolean;
  reason?: string;
  correctedContent?: string;
}
export declare class ValidatorError extends SmartAgentError {
  constructor(message: string, code?: string);
}
export interface IOutputValidator {
  validate(
    content: string,
    context: {
      messages: Message[];
      tools: LlmTool[];
    },
    options?: CallOptions,
  ): Promise<Result<ValidationResult, ValidatorError>>;
}
//# sourceMappingURL=validator.d.ts.map
