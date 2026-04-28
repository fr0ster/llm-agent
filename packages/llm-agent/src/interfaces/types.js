/**
 * Shared types for Smart Orchestrated Agent contracts.
 */
// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------
export class SmartAgentError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = 'SmartAgentError';
  }
}
export class LlmError extends SmartAgentError {
  constructor(message, code = 'LLM_ERROR') {
    super(message, code);
    this.name = 'LlmError';
  }
}
export class McpError extends SmartAgentError {
  constructor(message, code = 'MCP_ERROR') {
    super(message, code);
    this.name = 'McpError';
  }
}
export class RagError extends SmartAgentError {
  constructor(message, code = 'RAG_ERROR') {
    super(message, code);
    this.name = 'RagError';
  }
}
export class ClassifierError extends SmartAgentError {
  constructor(message, code = 'CLASSIFIER_ERROR') {
    super(message, code);
    this.name = 'ClassifierError';
  }
}
export class AssemblerError extends SmartAgentError {
  constructor(message, code = 'ASSEMBLER_ERROR') {
    super(message, code);
    this.name = 'AssemblerError';
  }
}
export class SkillError extends SmartAgentError {
  constructor(message, code = 'SKILL_ERROR') {
    super(message, code);
    this.name = 'SkillError';
  }
}
//# sourceMappingURL=types.js.map
