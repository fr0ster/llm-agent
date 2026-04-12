import type { LlmTool } from '../interfaces/types.js';

export type ExternalToolValidationCode =
  | 'INVALID_TOOL_SCHEMA'
  | 'UNSUPPORTED_TOOL_FORMAT'
  | 'TOOL_NAME_INVALID'
  | 'TOOL_PARAMETERS_INVALID';

export interface ExternalToolValidationError {
  code: ExternalToolValidationCode;
  message: string;
  param: string;
  toolIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asSchema(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { type: 'object', properties: {} };
}

function validateDescription(
  value: unknown,
  toolIndex: number,
  param: string,
): ExternalToolValidationError | null {
  if (value === undefined || value === null || typeof value === 'string') {
    return null;
  }
  return {
    code: 'INVALID_TOOL_SCHEMA',
    message: `${param} must be a string when provided`,
    param,
    toolIndex,
  };
}

export const CLIENT_PROVIDED_PREFIX = '[client-provided] ';

function isAlreadyNormalized(raw: Record<string, unknown>): boolean {
  return (
    typeof raw.name === 'string' &&
    raw.name.length > 0 &&
    typeof raw.description === 'string' &&
    raw.description.startsWith(CLIENT_PROVIDED_PREFIX)
  );
}

function normalizeExternalTool(
  raw: unknown,
  toolIndex: number,
): { tool: LlmTool | null; error: ExternalToolValidationError | null } {
  if (!isRecord(raw)) {
    return {
      tool: null,
      error: {
        code: 'INVALID_TOOL_SCHEMA',
        message: `tools[${toolIndex}] must be an object`,
        param: `tools[${toolIndex}]`,
        toolIndex,
      },
    };
  }

  // Idempotent: already-normalized LlmTool passes through unchanged
  if (isAlreadyNormalized(raw)) {
    return { tool: raw as unknown as LlmTool, error: null };
  }

  const directDescriptionError = validateDescription(
    raw.description,
    toolIndex,
    `tools[${toolIndex}].description`,
  );
  if (directDescriptionError)
    return { tool: null, error: directDescriptionError };
  const name = asString(raw.name);
  if (name) {
    if (!isRecord(raw.inputSchema) && raw.inputSchema !== undefined) {
      return {
        tool: null,
        error: {
          code: 'TOOL_PARAMETERS_INVALID',
          message: `tools[${toolIndex}].inputSchema must be an object`,
          param: `tools[${toolIndex}].inputSchema`,
          toolIndex,
        },
      };
    }
    return {
      tool: {
        name,
        description: `${CLIENT_PROVIDED_PREFIX}${asString(raw.description) ?? ''}`,
        inputSchema: asSchema(raw.inputSchema),
      },
      error: null,
    };
  }

  if (raw.name !== undefined) {
    return {
      tool: null,
      error: {
        code: 'TOOL_NAME_INVALID',
        message: `tools[${toolIndex}].name must be a non-empty string`,
        param: `tools[${toolIndex}].name`,
        toolIndex,
      },
    };
  }

  if (!isRecord(raw.function)) {
    return {
      tool: null,
      error: {
        code: 'UNSUPPORTED_TOOL_FORMAT',
        message: `tools[${toolIndex}] must contain either name or function.name`,
        param: `tools[${toolIndex}]`,
        toolIndex,
      },
    };
  }

  const fn = raw.function;
  const functionDescriptionError = validateDescription(
    fn.description,
    toolIndex,
    `tools[${toolIndex}].function.description`,
  );
  if (functionDescriptionError) {
    return { tool: null, error: functionDescriptionError };
  }
  const functionName = asString(fn?.name);
  if (!functionName) {
    return {
      tool: null,
      error: {
        code: 'TOOL_NAME_INVALID',
        message: `tools[${toolIndex}].function.name must be a non-empty string`,
        param: `tools[${toolIndex}].function.name`,
        toolIndex,
      },
    };
  }
  if (!isRecord(fn.parameters) && fn.parameters !== undefined) {
    return {
      tool: null,
      error: {
        code: 'TOOL_PARAMETERS_INVALID',
        message: `tools[${toolIndex}].function.parameters must be an object`,
        param: `tools[${toolIndex}].function.parameters`,
        toolIndex,
      },
    };
  }

  return {
    tool: {
      name: functionName,
      description: `${CLIENT_PROVIDED_PREFIX}${asString(fn?.description) ?? ''}`,
      inputSchema: asSchema(fn?.parameters),
    },
    error: null,
  };
}

export function normalizeExternalTools(rawTools?: unknown[]): LlmTool[] {
  return normalizeAndValidateExternalTools(rawTools).tools;
}

export function normalizeAndValidateExternalTools(rawTools?: unknown[]): {
  tools: LlmTool[];
  errors: ExternalToolValidationError[];
} {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return { tools: [], errors: [] };
  }
  const tools: LlmTool[] = [];
  const errors: ExternalToolValidationError[] = [];
  for (const [index, rawTool] of rawTools.entries()) {
    const { tool, error } = normalizeExternalTool(rawTool, index);
    if (tool) tools.push(tool);
    if (error) errors.push(error);
  }
  return { tools, errors };
}
