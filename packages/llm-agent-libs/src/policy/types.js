import { SmartAgentError } from '@mcp-abap-adt/llm-agent';
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class PolicyError extends SmartAgentError {
  constructor(message, code = 'POLICY_ERROR') {
    super(message, code);
    this.name = 'PolicyError';
  }
}
export class PromptInjectionError extends SmartAgentError {
  constructor(message) {
    super(message, 'PROMPT_INJECTION');
    this.name = 'PromptInjectionError';
  }
}
//# sourceMappingURL=types.js.map
