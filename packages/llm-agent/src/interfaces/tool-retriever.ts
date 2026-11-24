import type {
  CallOptions,
  LlmUsage,
  McpTool,
  Result,
  SmartAgentError,
} from './types.js';

export type JsonSchema = McpTool['inputSchema'];

export interface ToolCandidate {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ToolRetrievalRequest {
  readonly text: string;
  readonly candidates: readonly ToolCandidate[];
}

export interface ToolRetrievalResult {
  /** Names drawn from the request's candidate catalogue. */
  readonly names: readonly string[];
  readonly usage?: LlmUsage;
}

export const TOOL_RETRIEVAL_INVALID = 'TOOL_RETRIEVAL_INVALID';

export interface IToolRetriever {
  readonly name: string;
  retrieve(
    request: ToolRetrievalRequest,
    options?: CallOptions,
  ): Promise<Result<ToolRetrievalResult, SmartAgentError>>;
}
