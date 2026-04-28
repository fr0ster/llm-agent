import type { LlmTool } from '@mcp-abap-adt/llm-agent';
export type ExternalToolValidationCode = 'INVALID_TOOL_SCHEMA' | 'UNSUPPORTED_TOOL_FORMAT' | 'TOOL_NAME_INVALID' | 'TOOL_PARAMETERS_INVALID';
export interface ExternalToolValidationError {
    code: ExternalToolValidationCode;
    message: string;
    param: string;
    toolIndex: number;
}
export declare const CLIENT_PROVIDED_PREFIX = "[client-provided] ";
export declare function normalizeExternalTools(rawTools?: unknown[]): LlmTool[];
export declare function normalizeAndValidateExternalTools(rawTools?: unknown[]): {
    tools: LlmTool[];
    errors: ExternalToolValidationError[];
};
//# sourceMappingURL=external-tools-normalizer.d.ts.map