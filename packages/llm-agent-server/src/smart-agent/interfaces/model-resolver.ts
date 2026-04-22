import type { ILlm } from '@mcp-abap-adt/llm-agent';

/**
 * Resolves a model name + role into a ready-to-use ILlm instance.
 * Used by SmartServer to handle PUT /v1/config model changes.
 */
export interface IModelResolver {
  resolve(
    modelName: string,
    role: 'main' | 'classifier' | 'helper',
  ): Promise<ILlm>;
}
