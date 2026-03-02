import type { Message } from '../../types.js';
import type { CallOptions, LlmTool, Result } from '../interfaces/types.js';
import { SmartAgentError } from '../interfaces/types.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  correctedContent?: string;
}

export class ValidatorError extends SmartAgentError {
  constructor(message: string, code = 'VALIDATOR_ERROR') {
    super(message, code);
    this.name = 'ValidatorError';
  }
}

export interface IOutputValidator {
  validate(
    content: string,
    context: { messages: Message[]; tools: LlmTool[] },
    options?: CallOptions,
  ): Promise<Result<ValidationResult, ValidatorError>>;
}
