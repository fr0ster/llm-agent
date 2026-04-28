/**
 * Plugin: content-filter — output validator that blocks sensitive content.
 *
 * Replaces the default output validator with a keyword-based filter.
 * Checks LLM responses for forbidden patterns and rejects them.
 *
 * Usage in YAML:
 *   pluginDir: ./plugins
 *   # No additional YAML config needed — the validator is applied globally.
 *   # All LLM responses pass through this filter automatically.
 *
 * Drop this file into your plugin directory.
 */
import type { CallOptions, IOutputValidator, LlmTool, Message, Result, ValidationResult } from '@mcp-abap-adt/llm-agent';
declare class ValidatorError extends Error {
    readonly code: string;
    constructor(message: string, code?: string);
}
declare class ContentFilterValidator implements IOutputValidator {
    validate(content: string, _context: {
        messages: Message[];
        tools: LlmTool[];
    }, _options?: CallOptions): Promise<Result<ValidationResult, ValidatorError>>;
}
export declare const outputValidator: ContentFilterValidator;
export {};
//# sourceMappingURL=02-content-filter.d.ts.map