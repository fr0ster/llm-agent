import type { LlmTool } from '../interfaces/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asSchema(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { type: 'object', properties: {} };
}

function normalizeExternalTool(raw: unknown): LlmTool | null {
  if (!isRecord(raw)) return null;

  const name = asString(raw.name);
  if (name) {
    return {
      name,
      description: asString(raw.description) ?? '',
      inputSchema: asSchema(raw.inputSchema),
    };
  }

  const fn = isRecord(raw.function) ? raw.function : null;
  const functionName = asString(fn?.name);
  if (!functionName) return null;

  return {
    name: functionName,
    description: asString(fn?.description) ?? '',
    inputSchema: asSchema(fn?.parameters),
  };
}

export function normalizeExternalTools(rawTools?: unknown[]): LlmTool[] {
  if (!Array.isArray(rawTools) || rawTools.length === 0) return [];
  return rawTools
    .map((tool) => normalizeExternalTool(tool))
    .filter((tool): tool is LlmTool => tool !== null);
}
