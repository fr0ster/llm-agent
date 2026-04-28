import type { LlmStreamChunk, OrchestratorError, Result, SmartAgentResponse } from '@mcp-abap-adt/llm-agent';
import { type ApiRequestContext, type ApiSseEvent, type ILlmApiAdapter, type NormalizedRequest } from '../interfaces/api-adapter.js';
export declare class OpenAiApiAdapter implements ILlmApiAdapter {
    readonly name = "openai";
    normalizeRequest(request: unknown): NormalizedRequest;
    formatResult(response: SmartAgentResponse, context: ApiRequestContext): unknown;
    formatError(error: OrchestratorError, _context: ApiRequestContext): unknown;
    transformStream(source: AsyncIterable<Result<LlmStreamChunk, OrchestratorError>>, context: ApiRequestContext): AsyncIterable<ApiSseEvent>;
}
//# sourceMappingURL=openai-adapter.d.ts.map