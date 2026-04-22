import type {
  CallOptions,
  LlmTool,
  Message,
  Result,
} from '@mcp-abap-adt/llm-agent';
import { SmartAgentError } from '@mcp-abap-adt/llm-agent';

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
